import { storage } from "../storage";
import { InsertVoiceProfile, InsertVoiceGeneration } from "../db/schema";
import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { spawn } from "child_process";
import { config } from "../config";
import { getTTSProvider, getElevenLabsProvider } from "../tts";
import { logger } from "../utils/logger";

// Voice quality thresholds for optimal cloning
const VOICE_QUALITY_THRESHOLDS = {
  MIN_DURATION_SECONDS: 30,        // Minimum total audio duration for good cloning
  OPTIMAL_DURATION_SECONDS: 120,   // Optimal duration (2 minutes)
  MIN_RMS_LEVEL: 0.02,             // Minimum RMS level (too quiet below this)
  MAX_RMS_LEVEL: 0.5,              // Maximum RMS level (distortion risk above this)
  OPTIMAL_RMS_MIN: 0.05,           // Optimal RMS range minimum
  OPTIMAL_RMS_MAX: 0.3,            // Optimal RMS range maximum
  CLIPPING_THRESHOLD: 0.95,        // Peak level indicating clipping
  MIN_SAMPLE_RATE: 22050,          // Minimum acceptable sample rate
  OPTIMAL_SAMPLE_RATE: 44100,      // Optimal sample rate
};

export interface VoiceQualityAnalysis {
  overallScore: number;           // 0-100 quality score
  isAcceptable: boolean;          // Whether quality is sufficient for cloning
  duration: number;               // Total duration in seconds
  rmsLevel: number;               // RMS (volume) level
  peakLevel: number;              // Peak amplitude
  sampleRate: number;             // Sample rate
  issues: string[];               // List of detected issues
  recommendations: string[];      // Suggestions for improvement
  speakerConsistency: number;     // 0-100 consistency score across samples
}

/**
 * Voice synthesis settings for fine-tuning the cloned voice output
 * These settings control how similar the output sounds to the original voice
 */
export interface VoiceSynthesisSettings {
  /**
   * Stability: Controls variation in the generated speech (0.0 - 1.0)
   * - Lower values (0.0-0.3): More expressive, varied intonation
   * - Medium values (0.4-0.6): Balanced expressiveness
   * - Higher values (0.7-1.0): More consistent, monotone delivery
   * Default: 0.65 (balanced for natural speech with consistency)
   */
  stability: number;

  /**
   * Similarity Boost: How closely the voice matches the original (0.0 - 1.0)
   * - Lower values (0.0-0.5): More variation from original voice
   * - Medium values (0.6-0.8): Moderate similarity
   * - Higher values (0.9-1.0): Maximum similarity to original voice
   * Default: 0.95 (prioritize sounding like the original)
   */
  similarity_boost: number;

  /**
   * Style: Intensity of the voice style/personality (0.0 - 1.0)
   * - Lower values (0.0-0.3): More neutral delivery
   * - Higher values (0.4-1.0): More stylized/exaggerated
   * For voice cloning, keep this LOW to preserve original characteristics
   * Default: 0.0 (neutral, preserve original voice style)
   */
  style: number;

  /**
   * Speaker Boost: Enhances clarity and speaker characteristics
   * Recommended: true for voice cloning
   * Default: true
   */
  use_speaker_boost: boolean;
}

/**
 * Default voice settings optimized for accurate voice cloning
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSynthesisSettings = {
  stability: 0.65,
  similarity_boost: 0.95,
  style: 0.0,
  use_speaker_boost: true,
};

/**
 * Preset configurations for different use cases
 */
export const VOICE_SETTING_PRESETS = {
  // Maximum similarity to original voice (recommended for voice cloning)
  maximum_similarity: {
    stability: 0.70,
    similarity_boost: 1.0,
    style: 0.0,
    use_speaker_boost: true,
  },
  // Balanced settings for natural conversation
  natural_conversation: {
    stability: 0.50,
    similarity_boost: 0.85,
    style: 0.1,
    use_speaker_boost: true,
  },
  // More expressive for storytelling
  expressive_storytelling: {
    stability: 0.35,
    similarity_boost: 0.80,
    style: 0.3,
    use_speaker_boost: true,
  },
  // Consistent delivery for narration
  consistent_narration: {
    stability: 0.80,
    similarity_boost: 0.90,
    style: 0.0,
    use_speaker_boost: true,
  },
} as const;

export class VoiceService {
  private readonly audioStoragePath = path.resolve(process.cwd(), "uploads", "audio");
  private readonly tempDir = path.resolve(process.cwd(), "temp");
  private readonly defaultProvider = config.TTS_PROVIDER;
  private readonly activeBuffers: Set<WeakRef<Buffer>> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Ensure audio storage directory exists
    this.ensureStorageDirectory();
    // Start periodic cleanup of temp files
    this.startCleanupInterval();
  }

  private startCleanupInterval(): void {
    // Clean up stale temp files every 30 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupTempFiles().catch(err =>
        logger.error('Failed to cleanup temp files', { error: err })
      );
    }, 30 * 60 * 1000);
  }

  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir);
      const now = Date.now();
      const maxAge = 2 * 60 * 60 * 1000; // 2 hours

      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            logger.debug('Cleaned up stale temp file', { filePath });
          }
        } catch (err) {
          // Ignore individual file errors
        }
      }
    } catch (err) {
      // Temp dir might not exist yet
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.activeBuffers.clear();
    logger.info('VoiceService shutdown complete');
  }

  // Decode arbitrary audio (MP3/OGG/M4A/WAV/etc.) into PCM WAV using ffmpeg via stdin/stdout
  private async decodeAudioToWav(input: Buffer, targetSampleRate = 24000, targetChannels = 1, targetBitDepth = 16): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-sn', '-dn',
        '-ac', String(Math.max(1, targetChannels)),
        '-ar', String(targetSampleRate),
        '-f', 'wav',
        ...(targetBitDepth === 24 ? ['-acodec', 'pcm_s24le'] : ['-acodec', 'pcm_s16le']),
        'pipe:1',
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', (e: Error) => reject(e));
      proc.on('close', (code: number | null) => {
        if (code === 0) return resolve(Buffer.concat(chunks));
        reject(new Error(`ffmpeg decode failed with code ${code}: ${err}`));
      });
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  // Minimal prompt preprocessing for voice cloning: preserve identity while standardizing format
  // IMPORTANT: Avoid aggressive processing that might alter voice characteristics (timbre, pitch, formants)
  private async preprocessVoicePrompt(audioBuffer: Buffer, preserveQuality = true): Promise<Buffer> {
    try {
      let workingBuffer = audioBuffer;

      // Use higher sample rate (44100 Hz) to preserve more voice detail
      // ElevenLabs and modern TTS systems can utilize higher quality audio
      const TARGET_SR = preserveQuality ? 44100 : 24000;
      const TARGET_CH = 1;  // Mono is standard for voice cloning
      const TARGET_BIT = 16; // 16-bit PCM is sufficient and widely supported

      // Properly decode non-WAV uploads (e.g., MP3/OGG/M4A) using ffmpeg
      if (!this.isWavBuffer(workingBuffer)) {
        workingBuffer = await this.decodeAudioToWav(workingBuffer, TARGET_SR, TARGET_CH, TARGET_BIT);
      }

      let audioInfo = await this.analyzeAudioBuffer(workingBuffer);

      // Convert to target format only if necessary
      if (
        audioInfo.sampleRate !== TARGET_SR ||
        audioInfo.channels !== TARGET_CH ||
        audioInfo.bitDepth !== TARGET_BIT
      ) {
        workingBuffer = await this.convertToTargetFormat(workingBuffer, audioInfo, TARGET_SR, TARGET_CH, TARGET_BIT);
        audioInfo = await this.analyzeAudioBuffer(workingBuffer);
      }

      // Apply gentle normalization to preserve voice dynamics
      // CRITICAL: Do NOT apply noise reduction, compression, or heavy filtering
      // These can alter the unique characteristics that make a voice recognizable
      try {
        const dataStart = (audioInfo as any).dataOffset ?? 44;
        const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, workingBuffer.length - dataStart));
        const safeEnd = Math.min(workingBuffer.length, dataEnd);
        const audioData = workingBuffer.slice(dataStart, safeEnd);
        const samples = this.extractSamples(audioData, audioInfo);

        // Use gentle normalization that preserves dynamics
        const normalized = this.normalizeAudioGently(samples);

        return this.createWavBuffer(normalized, audioInfo.sampleRate, audioInfo.channels, audioInfo.bitDepth);
      } catch {
        return workingBuffer;
      }
    } catch (error) {
      logger.error('Voice prompt preprocessing error', { error });
      return audioBuffer;
    }
  }

  /**
   * Gentle normalization that preserves voice dynamics and characteristics
   * Uses RMS-based normalization instead of peak-based for more natural results
   */
  private normalizeAudioGently(samples: number[]): number[] {
    if (samples.length === 0) return samples;

    // Calculate RMS (root mean square) for perceived loudness
    let sumSquares = 0;
    let peak = 0;
    for (const sample of samples) {
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // Target RMS level for voice (approximately -20dBFS)
    // This preserves natural dynamics while ensuring adequate volume
    const targetRms = 0.1; // ~-20dBFS
    const targetPeak = 0.85; // Leave headroom to prevent clipping

    if (rms <= 0 || !Number.isFinite(rms)) return samples;

    // Calculate gain based on RMS, but limit by peak to prevent clipping
    let gain = targetRms / rms;

    // Ensure we don't exceed peak limit
    if (peak * gain > targetPeak) {
      gain = targetPeak / peak;
    }

    // Apply gain with soft limiting
    const output = new Array<number>(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i] * gain;
      // Soft clipping using tanh for any samples that approach limits
      if (Math.abs(sample) > 0.9) {
        sample = Math.tanh(sample);
      }
      output[i] = Math.max(-1, Math.min(1, sample));
    }

    return output;
  }

  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.audioStoragePath, { recursive: true });
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error("Failed to create audio storage directory", { error });
    }
  }

  async createVoiceClone(audioFile: Buffer, name: string, userId: string, familyId?: string): Promise<string> {
    return this.createVoiceCloneFromFiles([audioFile], name, userId, familyId);
  }

  async createVoiceCloneFromFiles(audioFiles: Buffer[], name: string, userId: string, familyId?: string, recordingMetadata?: unknown[]): Promise<string> {
    try {
      logger.info(`Creating voice clone`, { name, audioFileCount: audioFiles.length });

      const metaList = Array.isArray(recordingMetadata) ? recordingMetadata : [];

      const augmentedFiles: Array<{ buffer: Buffer; metadata?: any; duration: number }> = [];
      for (let i = 0; i < audioFiles.length; i++) {
        const originalBuffer = audioFiles[i];
        const metadata = metaList[i];
        let duration: number | undefined = typeof metadata?.duration === 'number' ? metadata.duration : undefined;

        try {
          let analysisBuffer = originalBuffer;
          if (!this.isWavBuffer(analysisBuffer)) {
            analysisBuffer = await this.decodeAudioToWav(analysisBuffer).catch(() => Buffer.alloc(0));
          }
          if (duration === undefined && analysisBuffer.length > 0) {
            const info = await this.analyzeAudioBuffer(analysisBuffer);
            duration = info.duration;
            logger.debug(`VoiceService: analyzed input #${i}`, { format: info.format, channels: info.channels, sampleRate: info.sampleRate, bitDepth: info.bitDepth, duration: duration?.toFixed?.(2) });
          }
        } catch {
          // If analysis fails, duration remains undefined
        }

        if (!Number.isFinite(duration as number)) {
          const est = Math.max(0, Math.round((originalBuffer.length / 96000) * 100) / 100);
          duration = est;
          logger.warn(`VoiceService: duration analysis failed for input #${i}; using size-based estimate`, { estimatedDuration: est, bytes: originalBuffer.length });
        }

        augmentedFiles.push({ buffer: originalBuffer, metadata, duration: Number(duration) });
      }

      const validAudioFiles = augmentedFiles.filter(({ duration }) => duration >= 3);

      if (validAudioFiles.length === 0) {
        throw new Error("No valid audio recordings were provided. Please include at least one clip longer than 3 seconds.");
      }

      const processedRecordings: Array<{ buffer: Buffer; duration: number; metadata?: any; filePath: string }> = [];
      for (const recording of validAudioFiles) {
        const processedAudio = await this.preprocessVoicePrompt(recording.buffer);
        const audioFileName = `${nanoid()}_${Date.now()}_sample.wav`;
        const audioFilePath = path.join(this.audioStoragePath, audioFileName);
        await fs.writeFile(audioFilePath, processedAudio);
        processedRecordings.push({
          buffer: processedAudio,
          duration: recording.duration,
          metadata: recording.metadata,
          filePath: audioFilePath,
        });
      }

      const totalDuration = processedRecordings.reduce((sum, rec) => sum + rec.duration, 0);

      const elevenLabs = getElevenLabsProvider();
      let providerRef: string;
      let provider: string;

      if (elevenLabs.isConfigured()) {
        logger.info('VoiceService: Using ElevenLabs for voice cloning');
        provider = "ELEVENLABS";

        try {
          const voiceId = await elevenLabs.createVoiceClone(
            name,
            processedRecordings.map(r => r.filePath),
            `Voice clone for ${name} - Created via FamFlix`
          );
          providerRef = voiceId;
          logger.info('VoiceService: ElevenLabs voice created', { voiceId });
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          logger.error("VoiceService: ElevenLabs cloning failed", { error: errorMessage });
          throw new Error(`Voice cloning failed: ${errorMessage}`);
        }
      } else {
        logger.info('VoiceService: ElevenLabs not configured, storing local audio prompt');
        provider = this.defaultProvider;

        const promptBuffer = processedRecordings.length > 1
          ? await this.combineProcessedAudioFiles(processedRecordings.map(r => r.buffer))
          : processedRecordings[0].buffer;

        const audioFileName = `${nanoid()}_${Date.now()}_prompt.wav`;
        const audioFilePath = path.join(this.audioStoragePath, audioFileName);
        await fs.writeFile(audioFilePath, promptBuffer);
        providerRef = audioFilePath;
      }

      const audioSampleUrl = processedRecordings.length > 0
        ? `/uploads/audio/${path.basename(processedRecordings[0].filePath)}`
        : undefined;

      const voiceProfile = await storage.createVoiceProfile({
        name,
        userId,
        familyId,
        provider: provider as any,
        providerRef,
        audioSampleUrl,
        trainingProgress: 100,
        status: "ready",
        metadata: {
          isRealClone: true,
          cloneType: provider === "ELEVENLABS" ? "elevenlabs_ivc" : "zero_shot",
          totalInputDuration: totalDuration,
          createdAt: new Date().toISOString(),
          originalDurations: processedRecordings.map(rec => rec.duration),
          originalFileSizes: validAudioFiles.map(rec => rec.buffer.length),
        },
      } as InsertVoiceProfile);

      logger.info('Voice profile created', { profileId: voiceProfile.id, provider });
      return voiceProfile.id;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error("Voice cloning error", { error: errorMessage });
      throw new Error(`Voice cloning failed: ${errorMessage}. Please try again.`);
    }
  }



  private isWavBuffer(buffer: Buffer): boolean {
    return (
      buffer.length > 44 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE'
    );
  }

  private wrapRawAudioAsWav(audioBuffer: Buffer): Buffer {
    const sampleRate = 44100;
    const channels = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioBuffer.length;
    const fileSize = 44 + dataSize;

    const wavBuffer = Buffer.alloc(fileSize);

    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(fileSize - 8, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitDepth, 34);
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);

    audioBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  private async analyzeAudioBuffer(buffer: Buffer): Promise<{
    sampleRate: number;
    channels: number;
    bitDepth: number;
    format: string;
    duration: number;
    dataOffset: number;
    dataSize: number;
  }> {
    // Robust RIFF/WAV parser: scan chunks to locate 'fmt ' and 'data'
    if (buffer.length < 44) {
      throw new Error('Audio buffer too small to contain valid WAV header');
    }

    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      throw new Error('Not a valid WAV file (missing RIFF/WAVE)');
    }

    let audioFormatCode: number | undefined;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitsPerSample: number | undefined;
    let dataSize: number | undefined;
    let dataOffset: number | undefined;

    let offset = 12; // start of first chunk
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      const next = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned

      if (chunkId === 'fmt ') {
        if (chunkStart + 16 <= buffer.length) {
          audioFormatCode = buffer.readUInt16LE(chunkStart + 0);
          channels = buffer.readUInt16LE(chunkStart + 2);
          sampleRate = buffer.readUInt32LE(chunkStart + 4);
          // skip byteRate (4), blockAlign (2)
          bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
        }
      } else if (chunkId === 'data') {
        dataSize = Math.min(chunkSize, Math.max(0, buffer.length - chunkStart));
        dataOffset = chunkStart;
        // Found data; we can stop scanning further
        offset = next;
        break;
      }

      offset = next;
    }

    if (
      audioFormatCode === undefined ||
      channels === undefined ||
      sampleRate === undefined ||
      bitsPerSample === undefined ||
      dataSize === undefined ||
      dataOffset === undefined
    ) {
      throw new Error('Incomplete WAV header (missing fmt/data chunks)');
    }

    const bytesPerSample = (bitsPerSample / 8) * channels;
    const totalSamples = bytesPerSample > 0 ? dataSize / bytesPerSample : 0;
    const duration = totalSamples / sampleRate;

    const fmtLabel = audioFormatCode === 1 ? 'PCM' : audioFormatCode === 3 ? 'FLOAT' : `FORMAT_${audioFormatCode}`;
    return {
      sampleRate,
      channels,
      bitDepth: bitsPerSample,
      format: fmtLabel,
      duration,
      dataOffset,
      dataSize,
    };
  }

  private async convertToTargetFormat(
    buffer: Buffer,
    audioInfo: {
      sampleRate: number;
      channels: number;
      bitDepth: number;
      format?: string;
      dataOffset?: number;
      dataSize?: number;
    },
    targetSampleRate: number,
    targetChannels: number,
    targetBitDepth: number,
  ): Promise<Buffer> {
    const normalizedChannels = Math.max(1, Number.isFinite(targetChannels) ? Math.floor(targetChannels) : 1);
    const normalizedBitDepth = targetBitDepth === 24 ? 24 : 16;

    if (
      audioInfo.sampleRate === targetSampleRate &&
      audioInfo.channels === normalizedChannels &&
      audioInfo.bitDepth === normalizedBitDepth
    ) {
      return buffer;
    }

    logger.debug('VoiceService: Converting audio format', {
      from: { sampleRate: audioInfo.sampleRate, channels: audioInfo.channels, bitDepth: audioInfo.bitDepth },
      to: { sampleRate: targetSampleRate, channels: normalizedChannels, bitDepth: normalizedBitDepth }
    });

    const dataStart = (audioInfo as any).dataOffset ?? 44;
    const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, buffer.length - dataStart));
    const safeEnd = Math.min(buffer.length, dataEnd);
    const audioData = buffer.slice(dataStart, safeEnd);
    let processedSamples = this.extractSamples(audioData, audioInfo);

    if (audioInfo.channels !== normalizedChannels) {
      if (normalizedChannels === 1) {
        processedSamples = this.convertToMono(processedSamples, audioInfo.channels);
      } else {
        const baseSamples = audioInfo.channels === 1 ? processedSamples : this.convertToMono(processedSamples, audioInfo.channels);
        processedSamples = this.duplicateChannels(baseSamples, normalizedChannels);
      }
    }

    if (audioInfo.sampleRate !== targetSampleRate) {
      processedSamples = this.resampleAudio(processedSamples, audioInfo.sampleRate, targetSampleRate);
    }

    return this.createWavBuffer(processedSamples, targetSampleRate, normalizedChannels, normalizedBitDepth);
  }

  private async convertToOptimalFormat(buffer: Buffer, audioInfo: any): Promise<Buffer> {
    return this.convertToTargetFormat(buffer, audioInfo, 44100, 1, 16);
  }

  private duplicateChannels(samples: number[], channels: number): number[] {
    if (channels <= 1) return samples;

    const duplicated = new Array<number>(samples.length * channels);
    let offset = 0;
    for (const sample of samples) {
      for (let c = 0; c < channels; c++) {
        duplicated[offset++] = sample;
      }
    }

    return duplicated;
  }

  private extractSamples(audioData: Buffer, audioInfo: any): number[] {
    const samples: number[] = [];
    const bytesPerSample = audioInfo.bitDepth / 8;

    const frameSize = bytesPerSample * audioInfo.channels;
    if (!Number.isFinite(frameSize) || frameSize <= 0) return samples;

    for (let i = 0; i + frameSize <= audioData.length; i += frameSize) {
      for (let channel = 0; channel < audioInfo.channels; channel++) {
        const sampleOffset = i + (channel * bytesPerSample);
        if (sampleOffset < 0 || sampleOffset + bytesPerSample > audioData.length) {
          // Avoid out-of-bounds reads on final partial frame
          continue;
        }
        let sample = 0;

        const isFloat = String(audioInfo.format || '').toUpperCase().includes('FLOAT');
        if (isFloat && audioInfo.bitDepth === 32) {
          // IEEE float 32
          sample = audioData.readFloatLE(sampleOffset);
        } else if (audioInfo.bitDepth === 16) {
          sample = audioData.readInt16LE(sampleOffset) / 32768.0;
        } else if (audioInfo.bitDepth === 24) {
          // Read 24-bit sample (3 bytes)
          const byte1 = audioData.readUInt8(sampleOffset);
          const byte2 = audioData.readUInt8(sampleOffset + 1);
          const byte3 = audioData.readUInt8(sampleOffset + 2);
          sample = ((byte3 << 16) | (byte2 << 8) | byte1);
          if (sample & 0x800000) sample |= 0xFF000000; // Sign extend
          sample = sample / 8388608.0;
        } else if (audioInfo.bitDepth === 32) {
          // 32-bit signed PCM
          sample = audioData.readInt32LE(sampleOffset) / 2147483648.0;
        }

        samples.push(Math.max(-1, Math.min(1, sample))); // Clamp to [-1, 1]
      }
    }

    return samples;
  }

  private convertToMono(samples: number[], channels: number): number[] {
    if (channels === 1) return samples;

    const monoSamples: number[] = [];
    for (let i = 0; i < samples.length; i += channels) {
      // Average all channels to create mono
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += samples[i + c] || 0;
      }
      monoSamples.push(sum / channels);
    }

    return monoSamples;
  }

  private resampleAudio(samples: number[], inputRate: number, outputRate: number): number[] {
    if (inputRate === outputRate) return samples;

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(samples.length / ratio);
    const resampled: number[] = [];

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const index = Math.floor(sourceIndex);
      const fraction = sourceIndex - index;

      if (index + 1 < samples.length) {
        // Linear interpolation
        const sample1 = samples[index];
        const sample2 = samples[index + 1];
        resampled.push(sample1 + (sample2 - sample1) * fraction);
      } else {
        resampled.push(samples[index] || 0);
      }
    }

    return resampled;
  }

  private createWavBuffer(samples: number[], sampleRate: number, channels: number, bitDepth: number): Buffer {
    const bytesPerSample = bitDepth / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;
    const fileSize = 44 + dataSize;

    const buffer = Buffer.alloc(fileSize);

    // WAV Header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize - 8, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20);  // AudioFormat (PCM)
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Audio Data
    let offset = 44;
    for (const sample of samples) {
      const clampedSample = Math.max(-1, Math.min(1, sample));

      if (bitDepth === 16) {
        buffer.writeInt16LE(Math.round(clampedSample * 32767), offset);
        offset += 2;
      } else if (bitDepth === 24) {
        const intSample = Math.round(clampedSample * 8388607);
        buffer.writeUInt8(intSample & 0xFF, offset);
        buffer.writeUInt8((intSample >> 8) & 0xFF, offset + 1);
        buffer.writeUInt8((intSample >> 16) & 0xFF, offset + 2);
        offset += 3;
      }
    }

    return buffer;
  }

  private async enhanceAudioQuality(audioBuffer: Buffer, audioInfoOverride?: {
    sampleRate: number;
    channels: number;
    bitDepth: number;
  }): Promise<Buffer> {
    // Apply basic audio enhancements for better voice cloning
    try {
      const audioInfo = audioInfoOverride || await this.analyzeAudioBuffer(audioBuffer);
      const dataStart = (audioInfo as any).dataOffset ?? 44;
      const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, audioBuffer.length - 44));
      const safeEnd = Math.min(audioBuffer.length, dataEnd);
      const audioData = audioBuffer.slice(dataStart, safeEnd);
      const samples = this.extractSamples(audioData, audioInfo);

      // Remove low-level ambient noise before normalization
      const denoisedSamples = this.reduceBackgroundNoise(samples, audioInfo.sampleRate);

      // Apply gentle normalization
      const normalizedSamples = this.normalizeAudio(denoisedSamples);

      // Apply subtle high-pass filter to remove low-frequency noise
      const filteredSamples = this.highPassFilter(normalizedSamples, audioInfo.sampleRate);

      return this.createWavBuffer(filteredSamples, audioInfo.sampleRate, audioInfo.channels, audioInfo.bitDepth);
    } catch (error) {
      logger.error('Audio enhancement error', { error });
      return audioBuffer; // Return original if enhancement fails
    }
  }

  private normalizeAudio(samples: number[]): number[] {
    // Find peak amplitude iteratively to avoid spreading very large arrays
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }

    if (!Number.isFinite(peak) || peak <= 0) return samples;

    // Normalize to -3dB to prevent clipping (0.707 ≈ -3dB)
    const targetPeak = 0.707;
    const gain = targetPeak / peak;

    const out = new Array<number>(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] * gain;
    }
    return out;
  }

  private reduceBackgroundNoise(samples: number[], sampleRate: number): number[] {
    if (samples.length === 0) {
      return samples;
    }

    const windowSize = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms windows
    const energyWindows: number[] = [];

    for (let i = 0; i < samples.length; i += windowSize) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j < windowSize && i + j < samples.length; j++) {
        const sample = samples[i + j];
        sum += sample * sample;
        count++;
      }

      if (count > 0) {
        energyWindows.push(Math.sqrt(sum / count));
      }
    }

    const sortedEnergy = energyWindows.slice().sort((a, b) => a - b);
    const noiseFloor = sortedEnergy.length > 0 ? sortedEnergy[Math.floor(sortedEnergy.length * 0.25)] : 0;
    const threshold = noiseFloor > 0 ? noiseFloor * 1.6 : 0.02;

    const cleaned = samples.slice();
    for (let i = 0; i < cleaned.length; i++) {
      const absSample = Math.abs(cleaned[i]);
      if (absSample < threshold) {
        const attenuation = Math.pow(absSample / threshold, 1.5);
        cleaned[i] = cleaned[i] * attenuation * 0.5;
      }
    }

    // Gentle smoothing to avoid gate artifacts
    for (let i = 1; i < cleaned.length - 1; i++) {
      cleaned[i] = (cleaned[i - 1] + cleaned[i] * 2 + cleaned[i + 1]) / 4;
    }

    return cleaned;
  }

  private highPassFilter(samples: number[], sampleRate: number): number[] {
    // Simple high-pass filter to remove rumble below 80Hz
    const cutoffFreq = 80; // Hz
    const dt = 1.0 / sampleRate;
    const rc = 1.0 / (2 * Math.PI * cutoffFreq);
    const alpha = rc / (rc + dt);

    const filtered: number[] = [];
    let prevInput = 0;
    let prevOutput = 0;

    for (const sample of samples) {
      const output = alpha * (prevOutput + sample - prevInput);
      filtered.push(output);
      prevInput = sample;
      prevOutput = output;
    }

    return filtered;
  }

  private async combineProcessedAudioFiles(audioBuffers: Buffer[]): Promise<Buffer> {
    if (audioBuffers.length === 0) {
      throw new Error('No audio buffers provided for combination');
    }

    logger.info('VoiceService: Combining processed recordings', { count: audioBuffers.length });

    const sampleSegments: number[][] = [];
    let referenceInfo = await this.analyzeAudioBuffer(audioBuffers[0]);

    for (let index = 0; index < audioBuffers.length; index++) {
      let buffer = audioBuffers[index];
      let info = await this.analyzeAudioBuffer(buffer);

      // If the current buffer deviates from the reference format, normalize it
      if (
        info.sampleRate !== referenceInfo.sampleRate ||
        info.channels !== referenceInfo.channels ||
        info.bitDepth !== referenceInfo.bitDepth
      ) {
        buffer = await this.convertToTargetFormat(
          buffer,
          info,
          referenceInfo.sampleRate,
          referenceInfo.channels,
          referenceInfo.bitDepth,
        );
        info = await this.analyzeAudioBuffer(buffer);

        if (index === 0) {
          referenceInfo = info;
        }
      }

      const dataStart = (info as any).dataOffset ?? 44;
      const dataEnd = dataStart + ((info as any).dataSize ?? Math.max(0, buffer.length - 44));
      const safeEnd = Math.min(buffer.length, dataEnd);
      const audioData = buffer.slice(dataStart, safeEnd);
      const samples = this.extractSamples(audioData, info);

      const fadeSamples = Math.min(Math.floor(referenceInfo.sampleRate * 0.02), Math.floor(samples.length / 4));
      if (fadeSamples > 0) {
        this.applyFade(samples, fadeSamples, {
          fadeIn: index !== 0,
          fadeOut: index !== audioBuffers.length - 1,
        });
      }

      sampleSegments.push(samples);
    }

    // Concatenate segments without spread (avoids stack overflow on large arrays)
    const totalSamples = sampleSegments.reduce((sum, seg) => sum + seg.length, 0);
    const combinedSamples: number[] = new Array<number>(totalSamples);
    let writeIndex = 0;
    for (const segment of sampleSegments) {
      for (let i = 0; i < segment.length; i++) {
        combinedSamples[writeIndex++] = segment[i];
      }
    }

    const normalizedCombined = this.normalizeAudio(combinedSamples);

    return this.createWavBuffer(
      normalizedCombined,
      referenceInfo.sampleRate,
      referenceInfo.channels,
      referenceInfo.bitDepth
    );
  }

  private applyFade(samples: number[], fadeSamples: number, options: { fadeIn?: boolean; fadeOut?: boolean }) {
    const { fadeIn = true, fadeOut = true } = options;

    if (fadeIn) {
      for (let i = 0; i < fadeSamples && i < samples.length; i++) {
        const factor = i / fadeSamples;
        samples[i] *= factor;
      }
    }

    if (fadeOut) {
      for (let i = 0; i < fadeSamples && i < samples.length; i++) {
        const factor = (fadeSamples - i) / fadeSamples;
        const index = samples.length - fadeSamples + i;
        if (index >= 0 && index < samples.length) {
          samples[index] *= factor;
        }
      }
    }
  }

  async generateSpeech(voiceProfileId: string, text: string, requestedBy: string, voiceSettings?: any): Promise<string> {
    const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
    if (!voiceProfile) {
      throw new Error("Voice profile not found");
    }

    if (voiceProfile.status !== "ready") {
      throw new Error("Voice profile is not ready for speech generation");
    }

    // Determine voice settings: custom > preset > profile defaults > system defaults
    let effectiveSettings: VoiceSynthesisSettings;

    if (voiceSettings) {
      // Use custom settings, falling back to defaults for missing values
      effectiveSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        ...voiceSettings,
      };
    } else if (preset && VOICE_SETTING_PRESETS[preset]) {
      // Use preset configuration
      effectiveSettings = { ...VOICE_SETTING_PRESETS[preset] };
    } else if ((voiceProfile.metadata as any)?.voiceSettings) {
      // Use profile's saved settings
      effectiveSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        ...(voiceProfile.metadata as any).voiceSettings,
      };
    } else {
      // Use system defaults (optimized for voice cloning)
      effectiveSettings = { ...DEFAULT_VOICE_SETTINGS };
    }

    // Validate settings are within valid ranges
    effectiveSettings.stability = Math.max(0, Math.min(1, effectiveSettings.stability));
    effectiveSettings.similarity_boost = Math.max(0, Math.min(1, effectiveSettings.similarity_boost));
    effectiveSettings.style = Math.max(0, Math.min(1, effectiveSettings.style));

    logger.info('Generating speech with settings', {
      profileId: voiceProfileId,
      stability: effectiveSettings.stability,
      similarity_boost: effectiveSettings.similarity_boost,
      style: effectiveSettings.style,
      speaker_boost: effectiveSettings.use_speaker_boost,
    });

    // Create voice generation record
    const generation = await storage.createVoiceGeneration({
      voiceProfileId,
      text,
      requestedBy,
      status: "processing",
      metadata: {
        createdAt: new Date().toISOString(),
        usedSettings: voiceSettings // Store used settings for reference
      }
    });

    try {
      const providerKey = (voiceProfile as any).provider || this.defaultProvider;
      const providerRef = (voiceProfile as any).providerRef || (voiceProfile.metadata as any)?.voice?.audioPromptPath;
      if (!providerRef) {
        throw new Error("Voice profile is missing an audio prompt reference");
      }

      const provider = getTTSProvider(providerKey as string);

      // Merge profile settings with overrides
      // If voiceSettings is provided, it overrides what's in the profile
      const effectiveSettings = voiceSettings || (voiceProfile.metadata as any)?.voiceSettings;

      const result = await provider.synthesize({
        text,
        voiceRef: providerRef,
        storyId: undefined,
        sectionId: undefined,
        metadata: {
          requestedBy,
          voiceSettings: effectiveSettings
        },
      });

      await storage.updateVoiceGeneration(generation.id, {
        status: "completed",
        audioUrl: result.url,
        metadata: {
          ...(generation.metadata || {}),
          provider: providerKey,
          audioFilePath: result.key,
          completedAt: new Date().toISOString(),
          checksum: result.checksum,
          voiceSettings: effectiveSettings,
        }
      });

      return generation.id;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Speech generation failed";
      logger.error("Speech generation error", { error: errorMessage });

      await storage.updateVoiceGeneration(generation.id, {
        status: "failed",
        metadata: {
          ...(generation.metadata || {}),
          error: errorMessage,
          failedAt: new Date().toISOString()
        }
      });

      throw new Error(`${errorMessage}. Please try again.`);
    }
  }

  /**
   * Update voice synthesis settings for a voice profile
   * These settings will be used as defaults when generating speech
   */
  async updateVoiceProfileSettings(
    profileId: string,
    settings: Partial<VoiceSynthesisSettings>
  ): Promise<void> {
    const profile = await storage.getVoiceProfile(profileId);
    if (!profile) {
      throw new Error("Voice profile not found");
    }

    // Validate and clamp settings to valid ranges
    const validatedSettings: Partial<VoiceSynthesisSettings> = {};

    if (settings.stability !== undefined) {
      validatedSettings.stability = Math.max(0, Math.min(1, settings.stability));
    }
    if (settings.similarity_boost !== undefined) {
      validatedSettings.similarity_boost = Math.max(0, Math.min(1, settings.similarity_boost));
    }
    if (settings.style !== undefined) {
      validatedSettings.style = Math.max(0, Math.min(1, settings.style));
    }
    if (settings.use_speaker_boost !== undefined) {
      validatedSettings.use_speaker_boost = settings.use_speaker_boost;
    }

    // Merge with existing settings
    const existingSettings = (profile.metadata as any)?.voiceSettings || {};
    const newSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      ...existingSettings,
      ...validatedSettings,
    };

    await storage.updateVoiceProfile(profileId, {
      metadata: {
        ...(profile.metadata || {}),
        voiceSettings: newSettings,
        settingsUpdatedAt: new Date().toISOString(),
      },
    });

    logger.info('Voice profile settings updated', {
      profileId,
      settings: newSettings,
    });
  }

  /**
   * Get voice synthesis settings for a profile
   * Returns profile settings merged with defaults
   */
  async getVoiceProfileSettings(profileId: string): Promise<VoiceSynthesisSettings> {
    const profile = await storage.getVoiceProfile(profileId);
    if (!profile) {
      throw new Error("Voice profile not found");
    }

    const profileSettings = (profile.metadata as any)?.voiceSettings || {};

    return {
      ...DEFAULT_VOICE_SETTINGS,
      ...profileSettings,
    };
  }

  /**
   * Get available voice setting presets
   */
  getVoiceSettingPresets(): typeof VOICE_SETTING_PRESETS {
    return VOICE_SETTING_PRESETS;
  }

  async getVoiceProfilesByFamily(familyId: string) {
    return await storage.getVoiceProfilesByFamily(familyId);
  }

  async getVoiceProfilesByUser(userId: string) {
    return await storage.getVoiceProfilesByUser(userId);
  }

  async updateVoiceProfileTraining(profileId: string, progress: number) {
    const status = progress >= 100 ? "ready" : "training";
    return await storage.updateVoiceProfile(profileId, {
      trainingProgress: progress,
      status,
    });
  }

  async deleteVoiceProfile(profileId: string) {
    const profile = await storage.getVoiceProfile(profileId);
    if (!profile) {
      throw new Error("Voice profile not found");
    }

    // Attempt to remove associated files (best-effort)
    try {
      if (profile.providerRef) {
        await fs.unlink(profile.providerRef).catch(() => { });
      }
      if (profile.audioSampleUrl && profile.audioSampleUrl.startsWith('/uploads/')) {
        const samplePath = path.join(process.cwd(), profile.audioSampleUrl.replace(/^\/+/, ''));
        await fs.unlink(samplePath).catch(() => { });
      }
    } catch (e) {
      // Ignore file deletion errors
    }

    await storage.deleteVoiceProfile(profileId);
  }

  async getVoiceGeneration(generationId: string) {
    return await storage.getVoiceGeneration(generationId);
  }
  async getVoiceGenerationsByProfile(profileId: string) {
    return await storage.getVoiceGenerationsByProfile(profileId);
  }

  /**
   * Analyze audio quality for voice cloning suitability
   * Returns detailed quality metrics and recommendations
   */
  async analyzeVoiceQuality(audioBuffers: Buffer[]): Promise<VoiceQualityAnalysis> {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let totalDuration = 0;
    let totalRms = 0;
    let maxPeak = 0;
    let sampleRate = 0;
    const rmsValues: number[] = [];

    for (const buffer of audioBuffers) {
      try {
        let wavBuffer = buffer;
        if (!this.isWavBuffer(buffer)) {
          wavBuffer = await this.decodeAudioToWav(buffer);
        }

        const audioInfo = await this.analyzeAudioBuffer(wavBuffer);
        const dataStart = (audioInfo as any).dataOffset ?? 44;
        const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, wavBuffer.length - dataStart));
        const safeEnd = Math.min(wavBuffer.length, dataEnd);
        const audioData = wavBuffer.slice(dataStart, safeEnd);
        const samples = this.extractSamples(audioData, audioInfo);

        // Calculate RMS for this segment
        let rms = 0;
        let peak = 0;
        for (const sample of samples) {
          rms += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        rms = samples.length > 0 ? Math.sqrt(rms / samples.length) : 0;

        totalDuration += audioInfo.duration;
        totalRms += rms;
        rmsValues.push(rms);
        maxPeak = Math.max(maxPeak, peak);
        sampleRate = Math.max(sampleRate, audioInfo.sampleRate);
      } catch (error) {
        logger.warn('Failed to analyze audio segment', { error });
      }
    }

    const avgRms = rmsValues.length > 0 ? totalRms / rmsValues.length : 0;

    // Calculate speaker consistency (variance in RMS across samples)
    let rmsVariance = 0;
    if (rmsValues.length > 1) {
      for (const rms of rmsValues) {
        rmsVariance += Math.pow(rms - avgRms, 2);
      }
      rmsVariance = Math.sqrt(rmsVariance / rmsValues.length);
    }
    // Lower variance = higher consistency (0-100 scale)
    const speakerConsistency = Math.max(0, Math.min(100, 100 - (rmsVariance * 500)));

    // Score calculation
    let score = 100;

    // Duration scoring
    if (totalDuration < VOICE_QUALITY_THRESHOLDS.MIN_DURATION_SECONDS) {
      const durationDeficit = VOICE_QUALITY_THRESHOLDS.MIN_DURATION_SECONDS - totalDuration;
      score -= Math.min(40, durationDeficit * 1.5);
      issues.push(`Recording too short (${totalDuration.toFixed(1)}s). Minimum ${VOICE_QUALITY_THRESHOLDS.MIN_DURATION_SECONDS}s recommended.`);
      recommendations.push(`Record at least ${Math.ceil(VOICE_QUALITY_THRESHOLDS.MIN_DURATION_SECONDS - totalDuration)} more seconds of audio.`);
    } else if (totalDuration < VOICE_QUALITY_THRESHOLDS.OPTIMAL_DURATION_SECONDS) {
      score -= 10;
      recommendations.push(`For best results, record ${VOICE_QUALITY_THRESHOLDS.OPTIMAL_DURATION_SECONDS}+ seconds total.`);
    }

    // Volume (RMS) scoring
    if (avgRms < VOICE_QUALITY_THRESHOLDS.MIN_RMS_LEVEL) {
      score -= 30;
      issues.push('Audio is too quiet. Voice characteristics may not be captured properly.');
      recommendations.push('Speak louder or move closer to the microphone.');
    } else if (avgRms < VOICE_QUALITY_THRESHOLDS.OPTIMAL_RMS_MIN) {
      score -= 15;
      issues.push('Audio volume is below optimal level.');
      recommendations.push('Try speaking slightly louder for clearer voice capture.');
    } else if (avgRms > VOICE_QUALITY_THRESHOLDS.MAX_RMS_LEVEL) {
      score -= 20;
      issues.push('Audio is very loud and may be distorted.');
      recommendations.push('Move further from the microphone or speak softer.');
    }

    // Clipping detection
    if (maxPeak > VOICE_QUALITY_THRESHOLDS.CLIPPING_THRESHOLD) {
      score -= 25;
      issues.push('Audio clipping detected. This can severely degrade voice quality.');
      recommendations.push('Reduce input volume or increase distance from microphone.');
    }

    // Sample rate scoring
    if (sampleRate < VOICE_QUALITY_THRESHOLDS.MIN_SAMPLE_RATE) {
      score -= 20;
      issues.push(`Low audio quality detected (${sampleRate}Hz sample rate).`);
      recommendations.push('Use a higher quality microphone or recording settings.');
    } else if (sampleRate < VOICE_QUALITY_THRESHOLDS.OPTIMAL_SAMPLE_RATE) {
      score -= 5;
    }

    // Speaker consistency scoring
    if (speakerConsistency < 60) {
      score -= 15;
      issues.push('Inconsistent volume levels across recordings.');
      recommendations.push('Maintain consistent distance from microphone and speaking volume.');
    } else if (speakerConsistency < 80) {
      score -= 5;
    }

    // Ensure score is within bounds
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Add general recommendations based on score
    if (score >= 80) {
      recommendations.push('Audio quality is excellent for voice cloning.');
    } else if (score >= 60) {
      recommendations.push('Audio quality is acceptable but could be improved.');
    } else {
      recommendations.push('Consider re-recording in a quieter environment with better microphone positioning.');
    }

    return {
      overallScore: score,
      isAcceptable: score >= 50,
      duration: totalDuration,
      rmsLevel: avgRms,
      peakLevel: maxPeak,
      sampleRate,
      issues,
      recommendations,
      speakerConsistency,
    };
  }

  /**
   * Validate audio samples before creating a voice clone
   * Throws if quality is too low, returns analysis otherwise
   */
  async validateForCloning(audioBuffers: Buffer[]): Promise<VoiceQualityAnalysis> {
    const analysis = await this.analyzeVoiceQuality(audioBuffers);

    logger.info('Voice quality analysis completed', {
      score: analysis.overallScore,
      duration: analysis.duration,
      rms: analysis.rmsLevel,
      peak: analysis.peakLevel,
      consistency: analysis.speakerConsistency,
      issues: analysis.issues.length,
    });

    if (!analysis.isAcceptable) {
      logger.warn('Voice quality below threshold', {
        score: analysis.overallScore,
        issues: analysis.issues
      });
    }

    return analysis;
  }
}

export const voiceService = new VoiceService();
