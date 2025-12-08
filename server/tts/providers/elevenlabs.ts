import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import axios from "axios";
import FormData from "form-data";

import { config } from "../../config";
import type { ITTSProvider, TTSInput, TTSResult } from "../TTSProvider";

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

export class ElevenLabsProvider implements ITTSProvider {
    private readonly apiKey: string;

    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY || "";
        if (!this.apiKey) {
            console.warn("[ElevenLabs] API key not configured. Voice cloning will not work.");
        }
    }

    async createVoiceClone(name: string, audioFiles: string[], description?: string): Promise<string> {
        if (!this.apiKey) {
            throw new Error("ElevenLabs API key is not configured");
        }

        const form = new FormData();
        form.append("name", name);
        if (description) {
            form.append("description", description);
        }
        form.append("remove_background_noise", "true");

        for (const filePath of audioFiles) {
            const absPath = path.isAbsolute(filePath) 
                ? filePath 
                : path.resolve(process.cwd(), filePath);
            
            if (!fs.existsSync(absPath)) {
                throw new Error(`Audio file not found: ${absPath}`);
            }
            form.append("files", fs.createReadStream(absPath));
        }

        try {
            const response = await axios.post(
                `${ELEVENLABS_API_URL}/voices/add`,
                form,
                {
                    headers: {
                        "xi-api-key": this.apiKey,
                        ...form.getHeaders(),
                    },
                    timeout: 120000,
                }
            );

            console.log(`[ElevenLabs] Voice clone created: ${response.data.voice_id}`);
            return response.data.voice_id;
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                const message = error.response?.data?.detail?.message || 
                               error.response?.data?.message ||
                               error.message;
                throw new Error(`ElevenLabs voice cloning failed: ${message}`);
            }
            throw error;
        }
    }

    async deleteVoice(voiceId: string): Promise<void> {
        if (!this.apiKey) return;

        try {
            await axios.delete(`${ELEVENLABS_API_URL}/voices/${voiceId}`, {
                headers: { "xi-api-key": this.apiKey },
            });
            console.log(`[ElevenLabs] Voice deleted: ${voiceId}`);
        } catch (error) {
            console.error(`[ElevenLabs] Failed to delete voice ${voiceId}:`, error);
        }
    }

    async synthesize({ text, voiceRef, metadata }: TTSInput): Promise<TTSResult> {
        if (!this.apiKey) {
            throw new Error("ElevenLabs API key is not configured");
        }

        if (!voiceRef) {
            throw new Error("Voice reference (ElevenLabs voice_id) is required");
        }

        const modelId = (metadata?.modelId as string) || "eleven_multilingual_v2";
        
        const tempDir = path.resolve(process.cwd(), "temp");
        await fsp.mkdir(tempDir, { recursive: true });

        const filename = `elevenlabs-${Date.now()}-${nanoid(6)}.mp3`;
        const outFile = path.join(tempDir, filename);

        // Extract voice settings from metadata or use optimized defaults for voice cloning
        const voiceSettings = {
            // Higher stability (0.6-0.8) reduces variation but maintains consistency
            stability: (metadata?.stability as number) ?? 0.65,
            // CRITICAL: Higher similarity_boost (0.90+) makes output sound more like original voice
            similarity_boost: (metadata?.similarity_boost as number) ?? 0.95,
            // Style intensity - keep low for voice cloning to preserve original characteristics
            style: (metadata?.style as number) ?? 0.0,
            // Speaker boost enhances voice clarity and similarity
            use_speaker_boost: (metadata?.use_speaker_boost as boolean) ?? true,
        };

        try {
            const response = await axios.post(
                `${ELEVENLABS_API_URL}/text-to-speech/${voiceRef}`,
                {
                    text,
                    model_id: modelId,
                    voice_settings: voiceSettings,
                },
                {
                    headers: {
                        "xi-api-key": this.apiKey,
                        "Content-Type": "application/json",
                        "Accept": "audio/mpeg",
                    },
                    responseType: "arraybuffer",
                    timeout: 60000,
                }
            );

            await fsp.writeFile(outFile, response.data);

            const checksum = createHash("md5").update(response.data).digest("hex");

            console.log(`[ElevenLabs] Speech synthesized: ${filename} (${response.data.length} bytes)`);

            return {
                key: filename,
                url: `/api/audio/${filename}`,
                checksum,
                durationSec: undefined,
                transcript: text,
            };
        } catch (error: any) {
            if (axios.isAxiosError(error)) {
                const message = error.response?.data?.detail?.message || 
                               error.response?.data?.message ||
                               (typeof error.response?.data === 'string' ? error.response.data : null) ||
                               error.message;
                throw new Error(`ElevenLabs synthesis failed: ${message}`);
            }
            throw error;
        }
    }

    async getVoices(): Promise<Array<{ voice_id: string; name: string }>> {
        if (!this.apiKey) {
            return [];
        }

        try {
            const response = await axios.get(`${ELEVENLABS_API_URL}/voices`, {
                headers: { "xi-api-key": this.apiKey },
            });
            return response.data.voices || [];
        } catch (error) {
            console.error("[ElevenLabs] Failed to get voices:", error);
            return [];
        }
    }

    isConfigured(): boolean {
        return !!this.apiKey;
    }
}

export const elevenLabsProvider = new ElevenLabsProvider();
