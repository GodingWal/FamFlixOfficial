import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../../server/storage', () => ({
  storage: {
    createVoiceProfile: vi.fn(),
    updateVoiceProfile: vi.fn(),
    getVoiceProfile: vi.fn(),
    deleteVoiceProfile: vi.fn(),
    getVoiceProfilesByFamily: vi.fn(),
    getVoiceProfilesByUser: vi.fn(),
    createVoiceGeneration: vi.fn(),
    updateVoiceGeneration: vi.fn(),
    getVoiceGeneration: vi.fn(),
    getVoiceGenerationsByProfile: vi.fn(),
    logActivity: vi.fn(),
  },
}));

vi.mock('../../server/config', () => ({
  config: {
    TTS_PROVIDER: 'ELEVENLABS',
    UPLOAD_DIR: 'test-uploads',
  },
}));

vi.mock('../../server/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../server/tts', () => ({
  getTTSProvider: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
    generateSpeech: vi.fn(),
  })),
  getElevenLabsProvider: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
    createVoiceClone: vi.fn(),
    generateSpeech: vi.fn(),
  })),
}));

// Mock fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();

vi.mock('fs/promises', () => {
  const mocks = {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readdir: mockReaddir,
    stat: mockStat,
    unlink: mockUnlink,
    readFile: mockReadFile,
  };
  return {
    ...mocks,
    default: mocks,
  };
});

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn((event, callback) => {
      if (event === 'close') {
        setTimeout(() => callback(0), 0);
      }
    }),
  })),
}));

describe('VoiceService', () => {
  let voiceService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get fresh instance
    vi.resetModules();
    const module = await import('../../server/services/voiceService');
    voiceService = module.voiceService;
  });

  afterEach(() => {
    if (voiceService && voiceService.shutdown) {
      voiceService.shutdown();
    }
  });

  describe('getVoiceProfilesByUser', () => {
    it('should retrieve voice profiles for a user', async () => {
      const { storage } = await import('../../server/storage');
      const mockProfiles = [
        { id: 'profile-1', name: 'Profile 1', userId: 'user-123' },
        { id: 'profile-2', name: 'Profile 2', userId: 'user-123' },
      ];

      vi.mocked(storage.getVoiceProfilesByUser).mockResolvedValue(mockProfiles as any);

      const result = await voiceService.getVoiceProfilesByUser('user-123');

      expect(storage.getVoiceProfilesByUser).toHaveBeenCalledWith('user-123');
      expect(result).toEqual(mockProfiles);
    });
  });

  describe('getVoiceProfilesByFamily', () => {
    it('should retrieve voice profiles for a family', async () => {
      const { storage } = await import('../../server/storage');
      const mockProfiles = [
        { id: 'profile-1', name: 'Profile 1', familyId: 'family-123' },
        { id: 'profile-2', name: 'Profile 2', familyId: 'family-123' },
      ];

      vi.mocked(storage.getVoiceProfilesByFamily).mockResolvedValue(mockProfiles as any);

      const result = await voiceService.getVoiceProfilesByFamily('family-123');

      expect(storage.getVoiceProfilesByFamily).toHaveBeenCalledWith('family-123');
      expect(result).toEqual(mockProfiles);
    });
  });

  describe('deleteVoiceProfile', () => {
    it('should delete voice profile', async () => {
      const { storage } = await import('../../server/storage');
      vi.mocked(storage.deleteVoiceProfile).mockResolvedValue(undefined);

      await voiceService.deleteVoiceProfile('profile-123');

      expect(storage.deleteVoiceProfile).toHaveBeenCalledWith('profile-123');
    });
  });

  describe('generateSpeech', () => {
    it('should throw error when voice profile not found', async () => {
      const { storage } = await import('../../server/storage');
      vi.mocked(storage.getVoiceProfile).mockResolvedValue(undefined);

      await expect(
        voiceService.generateSpeech('nonexistent', 'Hello world', 'user-123')
      ).rejects.toThrow('Voice profile not found');
    });

    it('should throw error when voice profile is not ready', async () => {
      const { storage } = await import('../../server/storage');
      vi.mocked(storage.getVoiceProfile).mockResolvedValue({
        id: 'profile-123',
        status: 'processing',
        provider: 'ELEVENLABS',
      } as any);

      await expect(
        voiceService.generateSpeech('profile-123', 'Hello world', 'user-123')
      ).rejects.toThrow('Voice profile is not ready for speech generation');
    });
  });

  describe('isWavBuffer', () => {
    it('should identify valid WAV buffer', () => {
      // Create a minimal WAV header
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36, 4); // file size - 8
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16); // fmt chunk size
      wavHeader.writeUInt16LE(1, 20); // audio format (PCM)
      wavHeader.writeUInt16LE(1, 22); // channels
      wavHeader.writeUInt32LE(44100, 24); // sample rate
      wavHeader.writeUInt32LE(88200, 28); // byte rate
      wavHeader.writeUInt16LE(2, 32); // block align
      wavHeader.writeUInt16LE(16, 34); // bits per sample
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(0, 40); // data size

      // Access private method through the instance
      const result = voiceService['isWavBuffer'](wavHeader);
      expect(result).toBe(true);
    });

    it('should reject non-WAV buffer', () => {
      const nonWavBuffer = Buffer.from('not a wav file');
      const result = voiceService['isWavBuffer'](nonWavBuffer);
      expect(result).toBe(false);
    });

    it('should reject empty buffer', () => {
      const emptyBuffer = Buffer.alloc(0);
      const result = voiceService['isWavBuffer'](emptyBuffer);
      expect(result).toBe(false);
    });
  });

  describe('normalizeAudio', () => {
    it('should normalize audio samples to target amplitude', () => {
      const samples = [0.5, -0.3, 0.8, -0.6];
      const result = voiceService['normalizeAudio'](samples);

      // Should scale to ~0.8 peak amplitude
      const peak = Math.max(...result.map(Math.abs));
      expect(peak).toBeCloseTo(0.8, 1);
    });

    it('should handle silent audio', () => {
      const silentSamples = [0, 0, 0, 0];
      const result = voiceService['normalizeAudio'](silentSamples);

      // Silent audio should remain silent
      expect(result).toEqual([0, 0, 0, 0]);
    });

    it('should handle very loud audio', () => {
      const loudSamples = [0.95, -0.98, 0.99, -0.97];
      const result = voiceService['normalizeAudio'](loudSamples);

      // Should be scaled down
      const peak = Math.max(...result.map(Math.abs));
      expect(peak).toBeLessThanOrEqual(0.85);
    });
  });

  describe('highPassFilter', () => {
    it('should apply high-pass filter to samples', () => {
      // Low frequency signal should be attenuated
      const sampleRate = 44100;
      const samples = Array.from({ length: 1000 }, (_, i) =>
        Math.sin(2 * Math.PI * 50 * i / sampleRate) // 50Hz signal
      );

      const result = voiceService['highPassFilter'](samples, sampleRate);

      // The output should exist and have the same length
      expect(result).toHaveLength(samples.length);

      // Energy should be reduced for low frequency content
      const inputEnergy = samples.reduce((sum, s) => sum + s * s, 0);
      const outputEnergy = result.reduce((sum, s) => sum + s * s, 0);
      expect(outputEnergy).toBeLessThan(inputEnergy);
    });

    it('should preserve high frequency content', () => {
      const sampleRate = 44100;
      // High frequency signal (5000Hz) should pass through
      const samples = Array.from({ length: 1000 }, (_, i) =>
        Math.sin(2 * Math.PI * 5000 * i / sampleRate)
      );

      const result = voiceService['highPassFilter'](samples, sampleRate);

      // High frequency should be mostly preserved
      const inputEnergy = samples.reduce((sum, s) => sum + s * s, 0);
      const outputEnergy = result.reduce((sum, s) => sum + s * s, 0);
      // Should retain most energy (at least 80%)
      expect(outputEnergy / inputEnergy).toBeGreaterThan(0.8);
    });
  });

  describe('shutdown', () => {
    it('should clean up resources on shutdown', async () => {
      const { logger } = await import('../../server/utils/logger');

      voiceService.shutdown();

      expect(logger.info).toHaveBeenCalledWith('VoiceService shutdown complete');
    });
  });

  describe('cleanupTempFiles', () => {
    it('should remove stale temp files', async () => {
      const twoHoursAgo = Date.now() - (3 * 60 * 60 * 1000); // 3 hours ago

      mockReaddir.mockResolvedValue(['old-file.wav', 'new-file.wav']);
      mockStat
        .mockResolvedValueOnce({ mtimeMs: twoHoursAgo })
        .mockResolvedValueOnce({ mtimeMs: Date.now() });

      await voiceService['cleanupTempFiles']();

      // Should only unlink the old file
      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });

    it('should handle errors gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('Directory not found'));

      // Should not throw
      await expect(voiceService['cleanupTempFiles']()).resolves.not.toThrow();
    });
  });
});
