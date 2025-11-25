import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { PassThrough, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { Readable } from "stream";
import FormData from "form-data";
import axios from "axios";

import { config } from "../../config";
import { uploadStreamToS3 } from "../../utils/s3";
import type { ITTSProvider, TTSInput, TTSResult } from "../TTSProvider";
import { storage } from "../../storage";

export class RVCProvider implements ITTSProvider {
    private readonly serverUrl: string;

    constructor() {
        this.serverUrl = config.GPU_SERVER_URL;
    }

    async synthesize({ text, voiceRef, storyId, sectionId, metadata }: TTSInput): Promise<TTSResult> {
        const songTemplateId = metadata?.songTemplateId as string | undefined;
        if (!songTemplateId) {
            throw new Error("RVC Provider requires 'songTemplateId' in metadata");
        }

        const songTemplate = await storage.getSongTemplate(songTemplateId);
        if (!songTemplate) {
            throw new Error(`Song template not found: ${songTemplateId}`);
        }

        // Determine Voice Model Path
        let voiceModelPath = metadata?.rvcModelPath as string | undefined;
        if (!voiceModelPath && voiceRef.endsWith(".pth")) {
            voiceModelPath = voiceRef;
        }

        if (!voiceModelPath) {
            throw new Error("RVC Provider requires 'rvcModelPath' in metadata");
        }

        // Prepare Guide Audio
        const tempDir = path.resolve(process.cwd(), "temp");
        await fsp.mkdir(tempDir, { recursive: true });

        let guideAudioPath = songTemplate.guideAudioUrl;
        let tempGuidePath: string | null = null;

        // If guide audio is a URL, download it
        if (guideAudioPath.startsWith("http")) {
            tempGuidePath = path.join(tempDir, `guide-${nanoid(6)}.wav`);
            const res = await fetch(guideAudioPath);
            if (!res.ok) throw new Error(`Failed to download guide audio: ${res.statusText}`);
            const buffer = await res.arrayBuffer();
            await fsp.writeFile(tempGuidePath, Buffer.from(buffer));
            guideAudioPath = tempGuidePath;
        } else if (!path.isAbsolute(guideAudioPath)) {
            guideAudioPath = path.resolve(process.cwd(), guideAudioPath);
        }

        const filename = `rvc-${Date.now()}-${nanoid(6)}.wav`;
        const outFile = path.join(tempDir, filename);

        try {
            const form = new FormData();
            form.append("guide_audio", fs.createReadStream(guideAudioPath));
            form.append("voice_model", fs.createReadStream(voiceModelPath));
            form.append("pitch_change", "0");

            const response = await axios.post(`${this.serverUrl}/api/rvc/convert`, form, {
                headers: {
                    ...form.getHeaders(),
                },
                responseType: 'json'
            });

            if (response.data.status !== "success") {
                throw new Error(`RVC Conversion failed: ${JSON.stringify(response.data)}`);
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
        } finally {
            // Clean up temp guide if we downloaded it
            if (tempGuidePath) {
                try { await fsp.unlink(tempGuidePath); } catch (e) { /* ignore */ }
            }
        }

        // Handle Output (S3 or Local)
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
        try { await fsp.unlink(outFile); } catch (e) { }

        return {
            key: s3Key,
            url,
            checksum: checksum.digest("hex"),
            durationSec: undefined,
            transcript: undefined,
        } satisfies TTSResult;
    }
}
