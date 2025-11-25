import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { PassThrough, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import FormData from "form-data";
import axios from "axios";

import { config } from "../../config";
import { uploadStreamToS3 } from "../../utils/s3";
import type { ITTSProvider, TTSInput, TTSResult } from "../TTSProvider";

export class F5Provider implements ITTSProvider {
    private readonly serverUrl: string;

    constructor() {
        this.serverUrl = config.GPU_SERVER_URL;
    }

    async synthesize({ text, voiceRef, storyId, sectionId }: TTSInput): Promise<TTSResult> {
        if (!voiceRef) {
            throw new Error("Voice reference (audio prompt path) is required for F5-TTS");
        }

        const absPrompt = path.isAbsolute(voiceRef)
            ? voiceRef
            : path.resolve(process.cwd(), voiceRef.replace(/^\//, ""));

        if (!fs.existsSync(absPrompt)) {
            throw new Error(`Voice reference file not found: ${absPrompt}`);
        }

        const tempDir = path.resolve(process.cwd(), "temp");
        await fsp.mkdir(tempDir, { recursive: true });

        const filename = `f5-${Date.now()}-${nanoid(6)}.wav`;
        const outFile = path.join(tempDir, filename);

        try {
            const form = new FormData();
            form.append("text", text);
            form.append("remove_silence", "true");
            form.append("voice_ref", fs.createReadStream(absPrompt));

            const response = await axios.post(`${this.serverUrl}/api/f5/synthesize`, form, {
                headers: {
                    ...form.getHeaders(),
                },
                responseType: 'json'
            });

            if (response.data.status !== "success") {
                throw new Error(`F5 Synthesis failed: ${JSON.stringify(response.data)}`);
            }

            // Download the result
            const audioUrl = `${this.serverUrl}${response.data.url}`;
            const audioRes = await axios.get(audioUrl, { responseType: 'stream' });

            const writer = fs.createWriteStream(outFile);
            audioRes.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

        } catch (err) {
            if (axios.isAxiosError(err) && err.code === 'ECONNREFUSED') {
                throw new Error(`GPU Server is not running at ${this.serverUrl}. Please ensure the tunnel is active.`);
            }
            throw err;
        }

        // If S3 is not configured, serve locally
        if (!config.S3_BUCKET) {
            const localHash = createHash("md5");
            try {
                await pipeline(
                    fs.createReadStream(outFile),
                    new Transform({
                        transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: unknown) => void) {
                            localHash.update(chunk);
                            cb(null, chunk);
                        },
                    }),
                    new PassThrough()
                );
            } catch { }

            return {
                key: filename,
                url: `/api/audio/${filename}`,
                checksum: localHash.digest("hex"),
                durationSec: undefined,
                transcript: undefined,
            } satisfies TTSResult;
        }

        // Upload to S3
        const keyBase = config.STORY_AUDIO_PREFIX.replace(/\/$/, "");
        const s3Key = `${keyBase}/raw/${filename}`;

        const checksum = createHash("md5");
        const pass = new PassThrough();

        const uploadPromise = uploadStreamToS3(s3Key, "audio/wav", pass);

        await pipeline(
            fs.createReadStream(outFile),
            new Transform({
                transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: unknown) => void) {
                    checksum.update(chunk);
                    cb(null, chunk);
                },
            }),
            pass
        );

        const { url } = await uploadPromise;

        try { await fsp.unlink(outFile); } catch (e) { /* ignore */ }

        return {
            key: s3Key,
            url,
            checksum: checksum.digest("hex"),
            durationSec: undefined,
            transcript: undefined,
        } satisfies TTSResult;
    }
}
