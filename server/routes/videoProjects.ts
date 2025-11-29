import { Router, Response } from 'express';
import { db } from '../db.js';
import { sql } from 'drizzle-orm';
import { authenticateToken, AuthRequest } from '../middleware/auth-simple.js';
import { videoService } from '../services/videoService';
import { storage } from '../storage';
import { adminVideoPipelineService } from '../services/adminVideoPipelineService';
import { ensureTemplateVideosTable } from '../utils/templateVideos';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { ElevenLabsProvider } from '../tts/providers/elevenlabs';
import { transcriptionService } from '../services/transcriptionService';

const router = Router();

const isSQLite = process.env.DATABASE_URL?.startsWith('file:') ?? false;

async function dbQuery(query: ReturnType<typeof sql>): Promise<any[]> {
  if (isSQLite) {
    return await (db as any).all(query);
  } else {
    const result = await db.execute(query);
    return (result as any).rows || [];
  }
}

async function dbQueryOne(query: ReturnType<typeof sql>): Promise<any | null> {
  if (isSQLite) {
    return await (db as any).get(query);
  } else {
    const result = await db.execute(query);
    return (result as any).rows?.[0] || null;
  }
}

async function dbRun(query: ReturnType<typeof sql>): Promise<any> {
  if (isSQLite) {
    return await (db as any).run(query);
  } else {
    return await db.execute(query);
  }
}

const projectTranscriptDir = path.join(process.cwd(), 'uploads', 'admin-pipeline', 'project-transcripts');

async function setProjectProgress(projectId: string | number, progress: number, stage: string) {
  try {
    const now = new Date().toISOString();
    const row = await dbQueryOne(sql`SELECT metadata FROM video_projects WHERE id = ${projectId}`);
    const meta = parseMetadata(row?.metadata);
    const history = Array.isArray(meta.processingHistory) ? meta.processingHistory : [];
    history.push({ status: stage, timestamp: now });
    meta.processingHistory = history;
    if (isSQLite) {
      await dbRun(sql`
        UPDATE video_projects
        SET processing_progress = ${progress}, metadata = ${JSON.stringify(meta)}, updated_at = ${now}
        WHERE id = ${projectId}
      `);
    } else {
      await dbRun(sql`
        UPDATE video_projects
        SET processing_progress = ${progress}, metadata = ${JSON.stringify(meta)}::jsonb, updated_at = ${now}::timestamp
        WHERE id = ${projectId}
      `);
    }
  } catch (e) {
    console.error('[processing] Failed to set progress:', e);
  }
}

function toLocalUploadsPath(url: string): string {
  if (!url || !url.startsWith('/uploads/')) {
    throw new Error(`Unsupported uploads URL: ${url}`);
  }
  return path.join(process.cwd(), url.replace(/^\/+/, ''));
}

function parseMetadata(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? { ...parsed } : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

async function persistProjectTranscript(projectId: string | number, segments: any[]): Promise<string | null> {
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }

  const normalized = segments
    .map((segment) => {
      const startRaw = segment?.start ?? segment?.start_time ?? segment?.from ?? null;
      const endRaw = segment?.end ?? segment?.end_time ?? segment?.to ?? null;
      const start = typeof startRaw === 'number' ? startRaw : Number(startRaw);
      const end = typeof endRaw === 'number' ? endRaw : Number(endRaw);
      const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
        return null;
      }
      return {
        start,
        end,
        text,
      };
    })
    .filter(Boolean) as Array<{ start: number; end: number; text: string }>;

  if (!normalized.length) {
    return null;
  }

  await fs.mkdir(projectTranscriptDir, { recursive: true });
  const transcriptPath = path.join(projectTranscriptDir, `project-${projectId}.json`);
  await fs.writeFile(transcriptPath, JSON.stringify(normalized, null, 2), 'utf-8');
  return transcriptPath;
}

// Get video/audio duration using ffprobe
async function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration)) {
          resolve(duration);
        } else {
          reject(new Error('Could not parse duration from ffprobe output'));
        }
      } else {
        reject(new Error(`ffprobe failed: ${stderr}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
    });
  });
}

// Time-stretch an audio file to match a target duration using atempo filter
// atempo range is 0.5-2.0, so we may need to chain multiple filters
async function timeStretchAudio(
  inputPath: string,
  targetDuration: number,
  outputPath: string
): Promise<void> {
  const currentDuration = await getMediaDuration(inputPath);
  
  if (Math.abs(currentDuration - targetDuration) < 0.05) {
    // Close enough, just copy
    await fs.copyFile(inputPath, outputPath);
    return;
  }
  
  const ratio = currentDuration / targetDuration;
  console.log(`[elevenlabs] Time-stretching: ${currentDuration.toFixed(2)}s -> ${targetDuration.toFixed(2)}s (ratio: ${ratio.toFixed(3)})`);
  
  // Build atempo filter chain (each atempo must be between 0.5 and 2.0)
  const atempoFilters: string[] = [];
  let remainingRatio = ratio;
  
  while (remainingRatio > 2.0) {
    atempoFilters.push('atempo=2.0');
    remainingRatio /= 2.0;
  }
  while (remainingRatio < 0.5) {
    atempoFilters.push('atempo=0.5');
    remainingRatio /= 0.5;
  }
  atempoFilters.push(`atempo=${remainingRatio.toFixed(4)}`);
  
  const filterChain = atempoFilters.join(',');
  
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-af', filterChain,
      '-c:a', 'pcm_s16le',  // Lossless for intermediate files
      '-ar', '44100',
      outputPath
    ]);
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Time-stretch failed: ${stderr.slice(-500)}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for time-stretch: ${err.message}`));
    });
  });
}

// Generate silence of specified duration
async function generateSilence(duration: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=mono:sample_rate=44100`,
      '-t', duration.toString(),
      '-c:a', 'pcm_s16le',
      outputPath
    ]);
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to generate silence: ${stderr.slice(-500)}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for silence: ${err.message}`));
    });
  });
}

// Concatenate audio files using ffmpeg
async function concatenateAudioFiles(inputFiles: string[], outputPath: string): Promise<void> {
  const tempDir = path.dirname(outputPath);
  const listFile = path.join(tempDir, `concat_list_${Date.now()}.txt`);
  
  // Create concat file list
  const listContent = inputFiles.map(f => `file '${f}'`).join('\n');
  await fs.writeFile(listFile, listContent, 'utf-8');
  
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c:a', 'pcm_s16le',
      '-ar', '44100',
      outputPath
    ]);
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', async (code) => {
      try {
        await fs.unlink(listFile);
      } catch (e) {}
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Concatenation failed: ${stderr.slice(-500)}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for concat: ${err.message}`));
    });
  });
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

// Extract audio from video file
async function extractAudioFromVideo(videoPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      outputPath
    ]);
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio extraction failed: ${stderr.slice(-500)}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for audio extraction: ${err.message}`));
    });
  });
}

// Mix new voice with original audio using ducking (lowers original during speech)
async function mixVoiceWithBackground(
  originalAudioPath: string,
  newVoicePath: string, 
  outputPath: string,
  segments: TranscriptSegment[],
  duckLevel: number = -12 // dB reduction during speech
): Promise<void> {
  // Convert dB to linear (e.g., -12dB = 0.25)
  const duckLinear = Math.pow(10, duckLevel / 20);
  
  // Build complex filter for ducking and mixing
  // [0] = original audio, [1] = new voice
  // Duck original during speech segments, then mix with new voice
  
  let volumeFilter: string;
  if (segments.length > 0) {
    // Build OR chain of between() conditions: gte(between(t,s1,e1)+between(t,s2,e2)+...,1)
    // This evaluates to 1 (true) when t is within any segment
    const betweenConditions = segments.map(seg => 
      `between(t\\,${seg.start.toFixed(3)}\\,${seg.end.toFixed(3)})`
    ).join('+');
    // Use gte(...,1) to convert the sum to a boolean (1 if any segment matches)
    // Then use if() to apply duck level during speech, full volume otherwise
    volumeFilter = `[0:a]volume='if(gte(${betweenConditions}\\,1)\\,${duckLinear.toFixed(4)}\\,1)':eval=frame[ducked]`;
  } else {
    // No segments, just lower the entire original audio
    volumeFilter = `[0:a]volume=${duckLinear.toFixed(4)}[ducked]`;
  }
  
  // Mix ducked original with new voice (comma separates filters)
  const filterComplex = `${volumeFilter};[ducked][1:a]amix=inputs=2:duration=longest:dropout_transition=0:weights=1 1[out]`;
  
  console.log('[mixing] Filter complex:', filterComplex.slice(0, 200) + '...');
  
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', originalAudioPath,
      '-i', newVoicePath,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      outputPath
    ]);
    
    let stderr = '';
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[mixing] Audio mixing complete');
        resolve();
      } else {
        console.error('[mixing] ffmpeg stderr:', stderr.slice(-1000));
        reject(new Error(`Audio mixing failed: ${stderr.slice(-500)}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg for mixing: ${err.message}`));
    });
  });
}

interface VoiceReplacementOptions {
  preserveBackground?: boolean;  // Keep background audio/music
  backgroundDuckLevel?: number;  // dB reduction during speech (-12 default)
}

// Run ElevenLabs voice replacement with segment-by-segment synthesis and time-stretching
async function runElevenLabsVoiceReplacement(
  inputVideoPath: string,
  outputVideoPath: string,
  elevenLabsVoiceId: string,
  transcriptText: string,
  transcriptSegments?: TranscriptSegment[],
  options?: VoiceReplacementOptions
): Promise<void> {
  await fs.mkdir(path.dirname(outputVideoPath), { recursive: true });

  const preserveBackground = options?.preserveBackground ?? false;
  const duckLevel = options?.backgroundDuckLevel ?? -12;

  console.log('[elevenlabs] Starting voice replacement with ElevenLabs');
  console.log('[elevenlabs] Voice ID:', elevenLabsVoiceId);
  console.log('[elevenlabs] Transcript length:', transcriptText.length, 'characters');
  console.log('[elevenlabs] Segments available:', transcriptSegments?.length || 0);
  console.log('[elevenlabs] Preserve background:', preserveBackground);

  const provider = new ElevenLabsProvider();
  const tempDir = path.resolve(process.cwd(), 'temp');
  await fs.mkdir(tempDir, { recursive: true });
  
  const videoDuration = await getMediaDuration(inputVideoPath);
  console.log('[elevenlabs] Video duration:', videoDuration.toFixed(2), 'seconds');

  // If we have segments with timing, do segment-by-segment synthesis with time-stretching
  if (transcriptSegments && transcriptSegments.length > 0) {
    console.log('[elevenlabs] Using segment-by-segment synthesis with time-stretching');
    
    const audioClips: string[] = [];
    const cleanupFiles: string[] = [];
    let currentTime = 0;
    
    try {
      for (let i = 0; i < transcriptSegments.length; i++) {
        const segment = transcriptSegments[i];
        const segmentDuration = segment.end - segment.start;
        const segmentText = segment.text.trim();
        
        if (!segmentText) continue;
        
        if (segmentDuration <= 0.05) {
          console.warn(`[elevenlabs] Skipping segment ${i} with invalid duration: ${segmentDuration.toFixed(3)}s`);
          continue;
        }
        
        console.log(`[elevenlabs] Segment ${i + 1}/${transcriptSegments.length}: "${segmentText.slice(0, 50)}..." (${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s)`);
        
        // Add silence gap if there's a gap between current position and segment start
        if (segment.start > currentTime + 0.05) {
          const gapDuration = segment.start - currentTime;
          const gapFile = path.join(tempDir, `gap_${i}_${Date.now()}.wav`);
          await generateSilence(gapDuration, gapFile);
          audioClips.push(gapFile);
          cleanupFiles.push(gapFile);
          console.log(`[elevenlabs] Added ${gapDuration.toFixed(2)}s silence gap`);
        }
        
        // Synthesize this segment
        const result = await provider.synthesize({
          text: segmentText,
          voiceRef: elevenLabsVoiceId,
        });
        
        const rawAudioPath = path.join(tempDir, result.key);
        cleanupFiles.push(rawAudioPath);
        
        // Get the synthesized audio duration
        const synthDuration = await getMediaDuration(rawAudioPath);
        console.log(`[elevenlabs] Synthesized ${synthDuration.toFixed(2)}s, target ${segmentDuration.toFixed(2)}s`);
        
        // Time-stretch to match original segment duration
        const stretchedPath = path.join(tempDir, `stretched_${i}_${Date.now()}.wav`);
        await timeStretchAudio(rawAudioPath, segmentDuration, stretchedPath);
        audioClips.push(stretchedPath);
        cleanupFiles.push(stretchedPath);
        
        currentTime = segment.end;
      }
      
      // Add silence at the end if video is longer than last segment
      if (videoDuration > currentTime + 0.1) {
        const endGap = videoDuration - currentTime;
        const endGapFile = path.join(tempDir, `endgap_${Date.now()}.wav`);
        await generateSilence(endGap, endGapFile);
        audioClips.push(endGapFile);
        cleanupFiles.push(endGapFile);
        console.log(`[elevenlabs] Added ${endGap.toFixed(2)}s silence at end`);
      }
      
      // Concatenate all audio clips (new voice)
      const newVoicePath = path.join(tempDir, `newvoice_${Date.now()}.wav`);
      cleanupFiles.push(newVoicePath);
      
      console.log(`[elevenlabs] Concatenating ${audioClips.length} audio clips`);
      await concatenateAudioFiles(audioClips, newVoicePath);
      
      let finalAudioPath = newVoicePath;
      
      if (preserveBackground && transcriptSegments && transcriptSegments.length > 0) {
        console.log('[elevenlabs] Preserving background audio with ducking');
        
        // Extract original audio
        const originalAudioPath = path.join(tempDir, `original_${Date.now()}.wav`);
        cleanupFiles.push(originalAudioPath);
        await extractAudioFromVideo(inputVideoPath, originalAudioPath);
        
        // Mix new voice with ducked original (preserves background)
        const mixedAudioPath = path.join(tempDir, `mixed_${Date.now()}.wav`);
        cleanupFiles.push(mixedAudioPath);
        await mixVoiceWithBackground(originalAudioPath, newVoicePath, mixedAudioPath, transcriptSegments, duckLevel);
        
        finalAudioPath = mixedAudioPath;
        console.log('[elevenlabs] Background preserved with ducking during speech');
      }
      
      // Mux with video
      await muxAudioWithVideo(inputVideoPath, finalAudioPath, outputVideoPath);
      
      // Cleanup temp files
      for (const file of cleanupFiles) {
        try { await fs.unlink(file); } catch (e) {}
      }
      
      console.log('[elevenlabs] Segment-by-segment voice replacement complete');
      
    } catch (err) {
      // Cleanup on error
      for (const file of cleanupFiles) {
        try { await fs.unlink(file); } catch (e) {}
      }
      throw err;
    }
    
  } else {
    // Fallback: synthesize full text as one block (less accurate sync)
    console.log('[elevenlabs] No segments available, using full-text synthesis (sync may vary)');
    
    const result = await provider.synthesize({
      text: transcriptText,
      voiceRef: elevenLabsVoiceId,
    });
    
    const tempAudioPath = path.join(tempDir, result.key);
    
    // Pad audio to match video duration if needed
    const audioDuration = await getMediaDuration(tempAudioPath);
    let finalAudioPath = tempAudioPath;
    
    if (audioDuration < videoDuration) {
      const paddedPath = path.join(tempDir, `padded_${Date.now()}.wav`);
      await generateSilence(videoDuration - audioDuration, path.join(tempDir, 'pad_temp.wav'));
      await concatenateAudioFiles([tempAudioPath, path.join(tempDir, 'pad_temp.wav')], paddedPath);
      finalAudioPath = paddedPath;
      try { await fs.unlink(path.join(tempDir, 'pad_temp.wav')); } catch (e) {}
    }
    
    await muxAudioWithVideo(inputVideoPath, finalAudioPath, outputVideoPath);
    
    try { await fs.unlink(tempAudioPath); } catch (e) {}
    if (finalAudioPath !== tempAudioPath) {
      try { await fs.unlink(finalAudioPath); } catch (e) {}
    }
  }
}

// Mux audio with video (replace audio track)
async function muxAudioWithVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-map', '0:v:0',
      '-map', '1:a:0',
      outputPath,
    ];

    console.log('[elevenlabs] Muxing audio with video');

    const proc = spawn('ffmpeg', ffmpegArgs);
    let stderr = '';

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[elevenlabs] Video muxing complete:', outputPath);
        resolve();
      } else {
        reject(new Error(`ffmpeg mux failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

// Run the Python voice replacement pipeline
async function runVoiceReplacementPipeline(
  inputVideoPath: string,
  outputVideoPath: string,
  promptWavPath: string,
  transcriptJsonPath?: string | null
): Promise<void> {
  await fs.mkdir(path.dirname(outputVideoPath), { recursive: true });

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const scriptPath = path.resolve(process.cwd(), 'scripts', 'voice_replace_pipeline.py');
  const args: string[] = [
    scriptPath,
    '--input-video', inputVideoPath,
    '--output-video', outputVideoPath,
    '--audio-prompt', promptWavPath,
    '--device', String(process.env.CHATTERBOX_DEVICE || 'cpu'),
    '--verbose',
  ];

  if (transcriptJsonPath) {
    args.push('--transcript-json', transcriptJsonPath);
  }

  // Optional: override the Whisper model for transcription (e.g., tiny, base, small, medium)
  const whisperModel = process.env.WHISPER_MODEL;
  if (whisperModel && whisperModel.length > 0) {
    args.push('--whisper-model', whisperModel);
  }

  // Prefer faster-whisper for transcription by default; allow override via env
  const transcriber = String(process.env.TRANSCRIBER || 'faster-whisper');
  args.push('--transcriber', transcriber);

  // Optional: direct CTranslate2 settings for faster-whisper
  const ct2Device = process.env.WHISPER_CT2_DEVICE || undefined;
  const ct2Compute = process.env.WHISPER_CT2_COMPUTE || undefined;
  const ct2Beam = process.env.WHISPER_CT2_BEAM || undefined;
  if (ct2Device) {
    args.push('--ct2-device', ct2Device);
  }
  if (ct2Compute) {
    args.push('--ct2-compute', ct2Compute);
  }
  if (ct2Beam) {
    args.push('--ct2-beam-size', ct2Beam);
  }

  const timeoutMs = Number(process.env.VOICE_PIPELINE_TIMEOUT_MS || 10 * 60 * 1000); // default 10 minutes
  let timedOut = false;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => {
      const msg = d.toString();
      stdout += msg;
      console.log('[processing][pipeline stdout]', msg.trim());
    });
    proc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString();
      stderr += msg;
      console.error('[processing][pipeline stderr]', msg.trim());
    });
    proc.on('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited with code ${code}`;
      reject(new Error(`voice_replace_pipeline ${reason}: ${stderr || stdout || 'no output'}`));
    });
  });
}

async function ensureVideoProjectsTable() {
  if (!isSQLite) {
    return;
  }
  await dbRun(sql`
    CREATE TABLE IF NOT EXISTS video_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      template_video_id INTEGER NOT NULL,
      voice_profile_id INTEGER,
      face_image_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      output_video_url TEXT,
      processing_progress INTEGER DEFAULT 0,
      processing_error TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (template_video_id) REFERENCES template_videos(id) ON DELETE CASCADE
    )
  `);

  await dbRun(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_user_id ON video_projects(user_id)
  `);

  await dbRun(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status)
  `);

  await dbRun(sql`
    CREATE INDEX IF NOT EXISTS idx_video_projects_template_id ON video_projects(template_video_id)
  `);
}

async function migrateVideoProjectsUserIdTypeIfNeeded() {
  if (!isSQLite) {
    return;
  }
  try {
    const columns = await dbQuery(sql`PRAGMA table_info(video_projects)`);
    const userIdCol = Array.isArray(columns) ? (columns as any[]).find(c => c.name === 'user_id') : null;
    if (userIdCol && typeof userIdCol.type === 'string' && /int/i.test(userIdCol.type)) {
      await dbRun(sql`PRAGMA foreign_keys = OFF`);
      await dbRun(sql.raw(`BEGIN TRANSACTION`));
      await dbRun(sql.raw(`
        CREATE TABLE IF NOT EXISTS video_projects_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          template_video_id INTEGER NOT NULL,
          voice_profile_id INTEGER,
          face_image_url TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          output_video_url TEXT,
          processing_progress INTEGER DEFAULT 0,
          processing_error TEXT,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (template_video_id) REFERENCES template_videos(id) ON DELETE CASCADE
        )
      `));
      await dbRun(sql.raw(`
        INSERT INTO video_projects_new (
          id, user_id, template_video_id, voice_profile_id, face_image_url,
          status, output_video_url, processing_progress, processing_error, metadata,
          created_at, updated_at, completed_at
        )
        SELECT 
          id,
          CAST(user_id AS TEXT),
          template_video_id,
          voice_profile_id,
          face_image_url,
          status,
          output_video_url,
          processing_progress,
          processing_error,
          metadata,
          created_at,
          updated_at,
          completed_at
        FROM video_projects
      `));
      await dbRun(sql.raw(`DROP TABLE video_projects`));
      await dbRun(sql.raw(`ALTER TABLE video_projects_new RENAME TO video_projects`));
      await dbRun(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_user_id ON video_projects(user_id)`));
      await dbRun(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_status ON video_projects(status)`));
      await dbRun(sql.raw(`CREATE INDEX IF NOT EXISTS idx_video_projects_template_id ON video_projects(template_video_id)`));
      await dbRun(sql.raw(`COMMIT`));
      await dbRun(sql`PRAGMA foreign_keys = ON`);
      console.log('[migrate] video_projects.user_id migrated to TEXT');
    }
  } catch (err) {
    console.error('[migrate] Failed to migrate video_projects.user_id to TEXT:', err);
  }
}

// Create a new video project
router.post('/api/video-projects', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { templateVideoId, voiceProfileId, faceImageUrl, metadata } = req.body;
    const userId = req.user!.id;

    if (templateVideoId === undefined || templateVideoId === null) {
      return res.status(400).json({ error: 'Template video ID is required' });
    }

    const templateVideoIdNumber = Number(templateVideoId);
    if (!Number.isInteger(templateVideoIdNumber) || templateVideoIdNumber <= 0) {
      return res.status(400).json({ error: 'Template video ID must be a positive integer' });
    }

    // Ensure required tables exist and verify template video exists
    await ensureTemplateVideosTable();
    const isActiveValue = isSQLite ? 1 : true;
    const templateVideo = await dbQueryOne(sql`
      SELECT id, metadata FROM template_videos WHERE id = ${templateVideoIdNumber} AND is_active = ${isActiveValue}
    `);

    if (!templateVideo) {
      return res.status(404).json({ error: 'Template video not found' });
    }

    const templateMetadata = parseMetadata(templateVideo.metadata);
    const sourceVideoId = templateMetadata.sourceVideoId;
    const pipelineStatus = templateMetadata.pipelineStatus ?? 'queued';
    if (sourceVideoId && pipelineStatus === 'error') {
      try {
        const sourceVideo = await storage.getVideo(sourceVideoId);
        if (sourceVideo?.videoUrl) {
          await adminVideoPipelineService.enqueue(sourceVideo.id, sourceVideo.videoUrl);
        }
      } catch (err) {
        console.warn('[video-projects] Requeue pipeline failed', {
          templateId: templateVideoIdNumber,
          sourceVideoId,
          error: err instanceof Error ? err.message : err,
        });
      }
    }

    await ensureVideoProjectsTable();
    await migrateVideoProjectsUserIdTypeIfNeeded();

    const now = new Date();
    const baseMetadata = parseMetadata(metadata);
    if (sourceVideoId) {
      baseMetadata.sourceVideoId = sourceVideoId;
      baseMetadata.sourcePipelineStatus = pipelineStatus;
      baseMetadata.transcriptReady = pipelineStatus === 'completed';
    }
    const metadataPayload =
      Object.keys(baseMetadata).length > 0
        ? JSON.stringify(baseMetadata)
        : null;

    let insertedId: number | null = null;
    
    if (isSQLite) {
      const result = await dbRun(sql`
        INSERT INTO video_projects (
          user_id, template_video_id, voice_profile_id, face_image_url,
          status, processing_progress, metadata, created_at, updated_at
        ) VALUES (
          ${userId}, ${templateVideoIdNumber}, ${voiceProfileId || null}, 
          ${faceImageUrl || null}, 'pending', 0, ${metadataPayload},
          ${now.toISOString()}, ${now.toISOString()}
        )
      `);
      insertedId = typeof result?.lastInsertRowid === 'number'
        ? result.lastInsertRowid
        : typeof result?.lastID === 'number'
        ? result.lastID
        : null;
    } else {
      const result = await db.execute(sql`
        INSERT INTO video_projects (
          user_id, template_video_id, voice_profile_id, face_image_url,
          status, processing_progress, metadata, created_at, updated_at
        ) VALUES (
          ${userId}, ${templateVideoIdNumber}, ${voiceProfileId || null}, 
          ${faceImageUrl || null}, 'pending', 0, ${metadataPayload}::jsonb,
          ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp
        ) RETURNING id
      `);
      insertedId = (result as any).rows?.[0]?.id ?? null;
    }

    if (!insertedId) {
      throw new Error('Unable to determine newly created project ID');
    }

    const project = await dbQueryOne(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${insertedId}
    `);

    // Also create a corresponding entry in the main videos table so it appears in the library
    try {
      const initialVideo = await videoService.createVideo({
        title: project.template_title,
        description: project.metadata?.description ?? project.description ?? null,
        thumbnail: project.template_thumbnail ?? null,
        videoUrl: null, // will be filled when rendering completes
        duration: project.duration ?? null,
        status: 'draft',
        type: 'user_project',
        familyId: null,
        createdBy: userId,
        metadata: {
          projectId: insertedId,
          templateVideoId: templateVideoIdNumber,
          ...(sourceVideoId ? { sourceVideoId } : {}),
        },
      } as any);

      // Persist a backlink to the created video on the project row (in metadata)
      let meta: any = null;
      try {
        meta = project?.metadata ? (typeof project.metadata === 'string' ? JSON.parse(project.metadata) : project.metadata) : {};
      } catch {
        meta = {};
      }
      meta.linkedVideoId = initialVideo.id;
      if (isSQLite) {
        await dbRun(sql`
          UPDATE video_projects SET metadata = ${JSON.stringify(meta)}, updated_at = ${new Date().toISOString()} WHERE id = ${insertedId}
        `);
      } else {
        await dbRun(sql`
          UPDATE video_projects SET metadata = ${JSON.stringify(meta)}::jsonb, updated_at = ${new Date().toISOString()}::timestamp WHERE id = ${insertedId}
        `);
      }

      res.status(201).json({ ...project, linkedVideoId: initialVideo.id });
    } catch (linkErr) {
      // If creating the library video fails, still return the project so the flow can continue
      console.error('Failed to create linked library video:', linkErr);
      res.status(201).json(project);
    }
  } catch (error) {
    console.error('Error creating video project:', error);
    res.status(500).json({ error: 'Failed to create video project' });
  }
});

// Get all projects for the authenticated user
router.get('/api/video-projects', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const projects = await dbQuery(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail,
             tv.category, tv.duration as template_duration
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.user_id = ${userId}
      ORDER BY vp.created_at DESC
    `);

    res.json(projects);
  } catch (error) {
    console.error('Error fetching video projects:', error);
    res.status(500).json({ error: 'Failed to fetch video projects' });
  }
});

// Get a specific project
router.get('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const project = await dbQueryOne(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail,
             tv.video_url as template_video_url, tv.category, tv.difficulty
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id} AND vp.user_id = ${userId}
    `);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
  } catch (error) {
    console.error('Error fetching video project:', error);
    res.status(500).json({ error: 'Failed to fetch video project' });
  }
});

// Update project (add voice/face, update status)
router.patch('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { voiceProfileId, faceImageUrl, status, processingProgress, outputVideoUrl, metadata } = req.body;

    // Verify ownership
    const existing = await dbQueryOne(sql`
      SELECT id FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Build assignment list using Drizzle SQL template to ensure proper parameter binding
    const assignments: any[] = [];

    if (voiceProfileId !== undefined) {
      assignments.push(sql`voice_profile_id = ${voiceProfileId}`);
    }
    if (faceImageUrl !== undefined) {
      assignments.push(sql`face_image_url = ${faceImageUrl}`);
    }
    if (status !== undefined) {
      assignments.push(sql`status = ${status}`);
      if (status === 'completed') {
        if (isSQLite) {
          assignments.push(sql`completed_at = ${new Date().toISOString()}`);
        } else {
          assignments.push(sql`completed_at = ${new Date().toISOString()}::timestamp`);
        }
      }
    }
    if (processingProgress !== undefined) {
      assignments.push(sql`processing_progress = ${processingProgress}`);
    }
    if (outputVideoUrl !== undefined) {
      assignments.push(sql`output_video_url = ${outputVideoUrl}`);
    }
    if (metadata !== undefined) {
      if (isSQLite) {
        assignments.push(sql`metadata = ${JSON.stringify(metadata)}`);
      } else {
        assignments.push(sql`metadata = ${JSON.stringify(metadata)}::jsonb`);
      }
    }

    if (isSQLite) {
      assignments.push(sql`updated_at = ${new Date().toISOString()}`);
    } else {
      assignments.push(sql`updated_at = ${new Date().toISOString()}::timestamp`);
    }

    if (assignments.length > 0) {
      await dbRun(sql`
        UPDATE video_projects 
        SET ${sql.join(assignments, sql`, `)} 
        WHERE id = ${id}
      `);
    }

    const updated = await dbQueryOne(sql`
      SELECT vp.*, tv.title as template_title, tv.thumbnail_url as template_thumbnail
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id}
    `);

    res.json(updated);
  } catch (error) {
    console.error('Error updating video project:', error);
    res.status(500).json({ error: 'Failed to update video project' });
  }
});

// Delete project
router.delete('/api/video-projects/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const result = await dbRun(sql`
      DELETE FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    const changes = isSQLite ? result?.changes : (result as any)?.rowCount;
    if (changes === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting video project:', error);
    res.status(500).json({ error: 'Failed to delete video project' });
  }
});

// Start processing a project
router.post('/api/video-projects/:id/process', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    
    // Extract processing options from request body
    const { preserveBackground = false, backgroundDuckLevel = -12 } = req.body || {};

    const project = await dbQueryOne(sql`
      SELECT * FROM video_projects WHERE id = ${id} AND user_id = ${userId}
    `);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Processing currently requires only a voice profile; face image is optional (feature disabled)
    if (!project.voice_profile_id) {
      return res.status(400).json({ 
        error: 'Voice profile is required to start processing' 
      });
    }

    // Update status to processing
    const processingStartedAt = new Date().toISOString();
    await dbRun(sql`
      UPDATE video_projects
      SET status = 'processing', processing_progress = 0, updated_at = ${processingStartedAt}
      WHERE id = ${id}
    `);

    // Also mark the linked video as processing so it shows up in the library immediately
    const projectWithMeta = await dbQueryOne(sql`
      SELECT vp.*, tv.title as template_title, tv.video_url as template_video_url, tv.thumbnail_url as template_thumbnail, tv.metadata as template_metadata
      FROM video_projects vp
      JOIN template_videos tv ON vp.template_video_id = tv.id
      WHERE vp.id = ${id}
    `);

    const projectMeta = parseMetadata(projectWithMeta?.metadata);
    let linkedVideoId: string | undefined = typeof projectMeta?.linkedVideoId === 'string' ? projectMeta.linkedVideoId : undefined;

    if (linkedVideoId) {
      try {
        await videoService.updateVideo(linkedVideoId, { status: 'processing' } as any, userId);
      } catch (updateErr) {
        console.error('Failed to mark linked video processing:', updateErr);
      }
    }

    // Acknowledge the request immediately; perform processing asynchronously
    res.json({ message: 'Processing started', projectId: id, linkedVideoId: linkedVideoId ?? null });

    // Begin real voice replacement pipeline asynchronously
    (async () => {
      try {
        await setProjectProgress(id, 5, 'starting');
        // Resolve input video path from template video URL
        const templateUrl: string | null = projectWithMeta?.template_video_url ?? null;
        if (!templateUrl) {
          throw new Error('Template video URL not found for project');
        }
        const inputVideoPath = toLocalUploadsPath(templateUrl);
        console.log('[processing] input video path:', inputVideoPath);

        // Resolve voice profile
        const profileId = String(project.voice_profile_id);
        const profile = await storage.getVoiceProfile(profileId);
        if (!profile) {
          throw new Error('Selected voice profile not found');
        }

        // Check if this is an ElevenLabs voice profile
        const providerRef = (profile as any).providerRef || '';
        const provider = (profile as any).provider || '';
        const isElevenLabs = provider === 'elevenlabs' || 
          (providerRef && !providerRef.includes('/') && !providerRef.endsWith('.wav'));
        
        console.log('[processing] Voice profile provider:', provider || 'auto-detect');
        console.log('[processing] Provider ref:', providerRef);
        console.log('[processing] Using ElevenLabs:', isElevenLabs);

        // Determine output file location under uploads/videos
        const outputFileName = `processed-${id}.mp4`;
        const outputUrl = `/uploads/videos/${outputFileName}`;
        const outputVideoPath = toLocalUploadsPath(outputUrl);
        console.log('[processing] output video path:', outputVideoPath);

        const templateMetadata = parseMetadata(projectWithMeta?.template_metadata);
        const sourceVideoId =
          projectMeta?.sourceVideoId ??
          templateMetadata?.sourceVideoId ??
          null;

        // Get transcript text - needed for ElevenLabs synthesis
        let transcriptPath: string | null = null;
        let transcriptText: string = '';
        let transcriptSegments: any[] = [];
        let transcriptSource: string = 'none';
        
        // First, try to get existing transcript from source video metadata
        if (sourceVideoId) {
          try {
            const sourceVideo = await storage.getVideo(sourceVideoId);
            if (sourceVideo?.metadata) {
              const sourceMeta = parseMetadata((sourceVideo as any).metadata);
              const existingSegments = (sourceMeta?.pipeline as any)?.transcription?.segments;
              if (Array.isArray(existingSegments) && existingSegments.length > 0) {
                transcriptSegments = existingSegments;
                transcriptText = existingSegments
                  .map((s: any) => s.text?.trim())
                  .filter(Boolean)
                  .join(' ');
                transcriptSource = 'source_video';
                console.log('[processing] Found existing transcript from source video:', transcriptText.slice(0, 100) + '...');
              }
            }
          } catch (transcriptErr) {
            console.warn('[processing] Unable to get transcript from source video:', transcriptErr);
          }
        }

        // If no transcript from source video, try template metadata
        if (!transcriptText && templateMetadata?.transcript) {
          transcriptText = typeof templateMetadata.transcript === 'string' 
            ? templateMetadata.transcript 
            : JSON.stringify(templateMetadata.transcript);
          transcriptSource = 'template_metadata';
          console.log('[processing] Found transcript from template metadata:', transcriptText.slice(0, 100) + '...');
        }

        // If still no transcript and using ElevenLabs, use Gemini AI to transcribe the video
        if (!transcriptText && isElevenLabs) {
          console.log('[processing] No existing transcript found, using Gemini AI to transcribe video...');
          await setProjectProgress(id, 10, 'transcribing');
          
          if (!transcriptionService.isConfigured()) {
            throw new Error('Transcription service is not configured. Gemini AI integration required for voice replacement.');
          }
          
          try {
            const transcriptionResult = await transcriptionService.transcribeVideo(inputVideoPath);
            transcriptText = transcriptionResult.fullText;
            transcriptSegments = transcriptionResult.segments;
            transcriptSource = 'gemini_ai';
            console.log('[processing] Gemini transcription complete:', transcriptText.slice(0, 100) + '...');
            console.log('[processing] Transcription duration:', transcriptionResult.duration, 'seconds');
          } catch (transcribeErr) {
            console.error('[processing] Transcription failed:', transcribeErr);
            throw new Error(`Failed to transcribe video: ${transcribeErr instanceof Error ? transcribeErr.message : 'Unknown error'}`);
          }
        }

        // Persist transcript if we have segments (for any source)
        if (transcriptSegments.length > 0) {
          transcriptPath = await persistProjectTranscript(id, transcriptSegments);
        }
        
        // Mark transcript as ready if we have transcript text (from any source)
        if (transcriptText) {
          await setProjectProgress(id, 20, 'transcript_ready');
          console.log('[processing] Transcript ready from source:', transcriptSource);
        }

        await setProjectProgress(id, 25, 'pipeline_spawn');

        if (isElevenLabs) {
          // Use ElevenLabs TTS for voice replacement
          if (!transcriptText) {
            throw new Error('No transcript available for ElevenLabs voice synthesis. Please ensure the video has audio to transcribe.');
          }
          console.log('[processing] Using ElevenLabs voice replacement');
          console.log('[processing] Transcript text length:', transcriptText.length, 'characters');
          console.log('[processing] Transcript segments:', transcriptSegments.length);
          console.log('[processing] Preserve background audio:', preserveBackground);
          await setProjectProgress(id, 30, 'tts_synthesis');
          await runElevenLabsVoiceReplacement(inputVideoPath, outputVideoPath, providerRef, transcriptText, transcriptSegments, {
            preserveBackground,
            backgroundDuckLevel
          });
        } else {
          // Use Python pipeline for local voice cloning (F5/RVC)
          // For non-ElevenLabs, we still need a transcript for the pipeline
          // Try Gemini transcription if configured and no transcript yet
          if (!transcriptText && transcriptionService.isConfigured()) {
            console.log('[processing] Using Gemini AI to transcribe video for local pipeline...');
            await setProjectProgress(id, 10, 'transcribing');
            try {
              const transcriptionResult = await transcriptionService.transcribeVideo(inputVideoPath);
              transcriptText = transcriptionResult.fullText;
              transcriptSegments = transcriptionResult.segments;
              transcriptPath = await persistProjectTranscript(id, transcriptSegments);
              await setProjectProgress(id, 20, 'transcript_ready');
            } catch (transcribeErr) {
              console.warn('[processing] Transcription failed, continuing without transcript:', transcribeErr);
            }
          }
          
          const promptPath = providerRef || (profile.metadata as any)?.voice?.audioPromptPath;
          if (!promptPath) {
            throw new Error('Voice profile is missing an audio prompt path');
          }
          console.log('[processing] prompt wav path:', promptPath);

          // Validate that the prompt path actually exists before spawning the pipeline
          if (!(await fs.access(promptPath).then(() => true).catch(() => false))) {
            throw new Error(`Voice prompt not found on disk: ${promptPath}`);
          }

          await runVoiceReplacementPipeline(inputVideoPath, outputVideoPath, promptPath, transcriptPath);
        }

        const completionTimestamp = new Date().toISOString();
        // Update project record on success
        let meta = parseMetadata(projectWithMeta?.metadata);
        const history = Array.isArray(meta?.processingHistory) ? meta.processingHistory : [];
        history.push({ status: 'completed', timestamp: completionTimestamp });
        meta.processingHistory = history;
        meta.processingCompletedAt = completionTimestamp;
        if (sourceVideoId) {
          meta.sourceVideoId = sourceVideoId;
        }
        if (transcriptPath) {
          meta.transcriptPath = transcriptPath;
        }

        if (isSQLite) {
          await dbRun(sql`
            UPDATE video_projects
            SET
              status = 'completed',
              processing_progress = 100,
              output_video_url = ${outputUrl},
              metadata = ${JSON.stringify(meta)},
              updated_at = ${completionTimestamp},
              completed_at = ${completionTimestamp}
            WHERE id = ${id}
          `);
        } else {
          await dbRun(sql`
            UPDATE video_projects
            SET
              status = 'completed',
              processing_progress = 100,
              output_video_url = ${outputUrl},
              metadata = ${JSON.stringify(meta)}::jsonb,
              updated_at = ${completionTimestamp}::timestamp,
              completed_at = ${completionTimestamp}::timestamp
            WHERE id = ${id}
          `);
        }

        console.log('[processing] completed. output url:', outputUrl);
        if (linkedVideoId) {
          try {
            const linkedVideoUpdates: Record<string, unknown> = {
              status: 'completed',
              videoUrl: outputUrl,
            };
            if (projectWithMeta?.template_thumbnail) {
              linkedVideoUpdates.thumbnail = projectWithMeta.template_thumbnail;
            }
            await videoService.updateVideo(linkedVideoId, linkedVideoUpdates as any, userId);
          } catch (finalizeErr) {
            console.error('Failed to finalize linked video:', finalizeErr);
          }
        }
      } catch (err: any) {
        console.error('[processing] Voice replacement failed:', err?.message || err);
        const failedAt = new Date().toISOString();
        if (isSQLite) {
          await dbRun(sql`
            UPDATE video_projects
            SET
              status = 'failed',
              processing_progress = 100,
              processing_error = ${String(err?.message || 'Voice replacement failed')},
              updated_at = ${failedAt}
            WHERE id = ${id}
          `);
        } else {
          await dbRun(sql`
            UPDATE video_projects
            SET
              status = 'failed',
              processing_progress = 100,
              processing_error = ${String(err?.message || 'Voice replacement failed')},
              updated_at = ${failedAt}::timestamp
            WHERE id = ${id}
          `);
        }
        // Optionally mark linked video as error (schema uses 'error')
        if (linkedVideoId) {
          try {
            await videoService.updateVideo(linkedVideoId, { status: 'error' } as any, userId);
          } catch (e) {
            console.error('Failed to mark linked video failed:', e);
          }
        }
      }
    })();
  } catch (error) {
    console.error('Error starting video processing:', error);
    res.status(500).json({ error: 'Failed to start processing' });
  }
});

export default router;
