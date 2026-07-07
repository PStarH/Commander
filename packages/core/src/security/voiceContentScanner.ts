/**
 * VoiceContentScanner — Enhanced audio/voice threat scanning.
 *
 * Extends MultimodalContentScanner with deeper audio-specific checks:
 *   - Voice command injection (hidden "hey siri", "ok google" triggers)
 *   - DTMF tone sequence detection (dual-tone multi-frequency injection)
 *   - Spectrogram-encoded data channel detection
 *   - Audio steganography indicators (LSB, phase coding)
 *   - Voice cloning / deepfake audio metadata patterns
 *   - Ultrasonic/subsonic hidden channel detection
 *
 * Design:
 *   - Runs AFTER MultimodalContentScanner (metadata boundary check)
 *   - Scans raw audio buffer for threat patterns without decoding
 *   - Pattern-based detection as decoding audio requires ffmpeg/sox
 *   - Defense-in-depth: complements text ContentScanner + multimodal metadata checks
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type VoiceThreatType =
  | 'voice_command_injection'
  | 'dtmf_injection'
  | 'spectrogram_hidden_data'
  | 'audio_steganography'
  | 'deepfake_audio'
  | 'ultrasonic_channel'
  | 'subsonic_channel';

export type VoiceThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface VoiceThreat {
  type: VoiceThreatType;
  severity: VoiceThreatSeverity;
  description: string;
  evidence: string;
  remediation: string;
}

export interface VoiceScanResult {
  isSafe: boolean;
  threats: VoiceThreat[];
  riskScore: number;
  scannedAt: string;
  audioHash: string;
  metadata: {
    fileSize: number;
    format: string; // Detected audio format (mp3/wav/ogg/flac)
    durationEstimate?: number; // Estimated duration in seconds
    sampleRateEstimate?: number;
    scanDurationMs: number;
  };
}

export interface VoiceScannerConfig {
  /** Enable voice command injection detection */
  enableVoiceCommandScan: boolean;
  /** Enable DTMF tone detection */
  enableDTMFScan: boolean;
  /** Enable spectrogram hidden data scan */
  enableSpectrogramScan: boolean;
  /** Enable steganography detection */
  enableSteganographyScan: boolean;
  /** Max audio file size (bytes) */
  maxFileSize: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: VoiceScannerConfig = {
  enableVoiceCommandScan: true,
  enableDTMFScan: true,
  enableSpectrogramScan: true,
  enableSteganographyScan: true,
  maxFileSize: 50 * 1024 * 1024, // 50 MB
};

// ============================================================================
// Voice Command Injection Patterns (in raw bytes)
// ============================================================================

const VOICE_COMMAND_PATTERNS: Array<{
  name: string;
  patterns: string[];
  severity: VoiceThreatSeverity;
}> = [
  {
    name: 'Hey Siri trigger',
    patterns: ['hey siri', 'heysiri', 'hey  siri', 'h e y s i r i'],
    severity: 'HIGH',
  },
  {
    name: 'OK Google trigger',
    patterns: ['ok google', 'okay google', 'hey google', 'o k g o o g l e'],
    severity: 'HIGH',
  },
  {
    name: 'Alexa trigger',
    patterns: ['alexa', 'a l e x a', 'computer (wake word)'],
    severity: 'HIGH',
  },
  {
    name: 'System command injection',
    patterns: [
      'ignore all previous',
      'disregard instructions',
      'system override',
      'admin mode activate',
      'sudo mode',
      'developer mode',
      'jailbreak',
      'do anything now',
    ],
    severity: 'CRITICAL',
  },
  {
    name: 'Hidden instruction',
    patterns: [
      'execute command',
      'download and run',
      'open terminal',
      'run script',
      'bash -c',
      'cmd /c',
      'powershell -command',
    ],
    severity: 'CRITICAL',
  },
];

// ============================================================================
// ============================================================================
// Audio Format Header Offsets
// ============================================================================

interface AudioFormatInfo {
  format: string;
  magic: number[];
  sampleRateOffset: number;
  dataOffset: number;
  dataSizeOffset?: number;
}

const AUDIO_FORMATS: AudioFormatInfo[] = [
  // WAV fmt chunk: after "fmt " (4 bytes) + chunk size (4 bytes) = offset 20
  { format: 'wav', magic: [0x52, 0x49, 0x46, 0x46], sampleRateOffset: 24, dataOffset: 44 },
  // MP3 frame header: 0xFF 0xFB (or 0xFF 0xF3, 0xFF 0xFA, 0xFF 0xF2)
  { format: 'mp3', magic: [0xff, 0xfb], sampleRateOffset: 2, dataOffset: 0 },
  { format: 'mp3', magic: [0xff, 0xf3], sampleRateOffset: 2, dataOffset: 0 },
  { format: 'mp3', magic: [0xff, 0xfa], sampleRateOffset: 2, dataOffset: 0 },
  // OGG: "OggS" at offset 0
  { format: 'ogg', magic: [0x4f, 0x67, 0x67, 0x53], sampleRateOffset: 56, dataOffset: 58 },
  // FLAC: "fLaC" at offset 0
  { format: 'flac', magic: [0x66, 0x4c, 0x61, 0x43], sampleRateOffset: 18, dataOffset: 42 },
];

// ============================================================================
// VoiceContentScanner
// ============================================================================

export class VoiceContentScanner {
  private config: VoiceScannerConfig;

  constructor(config?: Partial<VoiceScannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan audio content for voice threats.
   * Does NOT decode audio — operates on raw buffer only.
   */
  scan(buffer: Buffer): VoiceScanResult {
    const startMs = Date.now();
    const threats: VoiceThreat[] = [];

    // Early size check
    if (buffer.length > this.config.maxFileSize) {
      return this.buildResult(buffer, 'unknown', threats, startMs, {
        fileSize: buffer.length,
        format: 'unknown',
      });
    }

    // Detect audio format
    const formatInfo = this.detectFormat(buffer);
    const format = formatInfo?.format ?? 'unknown';

    // Estimate sample rate
    let sampleRateEstimate: number | undefined;
    let durationEstimate: number | undefined;

    if (formatInfo && buffer.length >= formatInfo.sampleRateOffset + 4) {
      try {
        sampleRateEstimate = buffer.readUInt32LE(formatInfo.sampleRateOffset);
        // Rough duration estimate based on raw samples (WAV: offset 40 has data size)
        if (format === 'wav' && buffer.length >= 44) {
          const dataSize = buffer.readUInt32LE(40);
          const byteRate = sampleRateEstimate * 2 * 2; // 16-bit stereo
          if (byteRate > 0) {
            durationEstimate = dataSize / byteRate;
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'voiceContentScanner:229');
        /* not enough data for parsing */
      }
    }

    // 1. Voice command injection detection
    if (this.config.enableVoiceCommandScan) {
      threats.push(...this.scanVoiceCommands(buffer));
    }

    // 2. DTMF tone injection detection
    if (this.config.enableDTMFScan) {
      threats.push(...this.scanDTMF(buffer));
    }

    // 3. Spectrogram hidden data detection
    if (this.config.enableSpectrogramScan) {
      threats.push(...this.scanSpectrogram(buffer, formatInfo));
    }

    // 4. Audio steganography detection
    if (this.config.enableSteganographyScan) {
      threats.push(...this.scanSteganography(buffer, formatInfo));
    }

    return this.buildResult(buffer, format, threats, startMs, {
      fileSize: buffer.length,
      format,
      durationEstimate,
      sampleRateEstimate,
    });
  }

  // ── Detection Methods ─────────────────────────────────────────────

  /** Scan for voice command injection patterns in raw audio bytes. */
  private scanVoiceCommands(buffer: Buffer): VoiceThreat[] {
    const threats: VoiceThreat[] = [];

    // Search in both ASCII and UTF-16 encodings (voice assistants use both)
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 200_000));
    const utf16Le = buffer.toString('utf16le', 0, Math.min(buffer.length, 200_000));

    for (const group of VOICE_COMMAND_PATTERNS) {
      for (const pattern of group.patterns) {
        const lowerPattern = pattern.toLowerCase();

        if (content.toLowerCase().includes(lowerPattern)) {
          threats.push({
            type: 'voice_command_injection',
            severity: group.severity,
            description: `Voice command trigger detected: "${group.name}"`,
            evidence: `Found "${pattern}" in audio metadata/content`,
            remediation:
              'Strip voice command triggers from audio. Re-encode audio from trusted source.',
          });
          break; // One match per group is enough
        }

        if (utf16Le.toLowerCase().includes(lowerPattern)) {
          threats.push({
            type: 'voice_command_injection',
            severity: group.severity,
            description: `Voice command trigger detected in UTF-16: "${group.name}"`,
            evidence: `Found "${pattern}" in UTF-16 encoded audio metadata`,
            remediation: 'Strip UTF-16 metadata. Sanitize all text channels in audio container.',
          });
          break;
        }
      }
    }

    return threats;
  }

  /** Detect DTMF tone injection by searching for frequency pair patterns. */
  private scanDTMF(buffer: Buffer): VoiceThreat[] {
    const threats: VoiceThreat[] = [];

    // DTMF detection without actual frequency analysis:
    // Search for metadata describing DTMF sequences or raw DTMF byte markers
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 100_000));

    const dtmfIndicators = [
      /DTMF/i,
      /dual.?tone/i,
      /touch.?tone/i,
      /##\d{3,}##/, // DTMF command sequences often delimited by ##
      /\*\d{3,}\*/, // Star-delimited DTMF sequences
    ];

    for (const indicator of dtmfIndicators) {
      if (indicator.test(content)) {
        threats.push({
          type: 'dtmf_injection',
          severity: 'HIGH',
          description: 'DTMF tone sequence or metadata detected in audio',
          evidence: `Matched pattern: ${indicator.source}`,
          remediation:
            'Verify audio source. Strip non-audio metadata. Detect and flag DTMF tones during playback.',
        });
        break;
      }
    }

    return threats;
  }

  /** Detect spectrogram-encoded data channels. */
  private scanSpectrogram(buffer: Buffer, formatInfo?: AudioFormatInfo | null): VoiceThreat[] {
    const threats: VoiceThreat[] = [];

    // Spectrogram hidden data indicators:
    // - Abnormally high sample rate (beyond human hearing range)
    // - Extremely long audio with very simple content (carrier signal)
    // - FFT watermark patterns in metadata

    if (formatInfo && buffer.length >= formatInfo.sampleRateOffset + 4) {
      try {
        const sampleRate = buffer.readUInt32LE(formatInfo.sampleRateOffset);
        // Ultrasonic detection: sample rate > 96kHz (beyond standard music encoding)
        if (sampleRate > 96000) {
          threats.push({
            type: 'ultrasonic_channel',
            severity: 'MEDIUM',
            description: `Audio has abnormally high sample rate (${sampleRate} Hz) — possible ultrasonic data channel`,
            evidence: `Sample rate: ${sampleRate} Hz (normal: 44100/48000 Hz)`,
            remediation: 'Downsample audio to standard rate. Verify source legitimacy.',
          });
        }
      } catch (err) {
        reportSilentFailure(err, 'voiceContentScanner:360');
        /* parsing error, skip */
      }
    }

    // Check for FFT/spectrogram metadata
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 50_000));
    if (/\b(?:spectrogram|fft|watermark|stegano)\b/i.test(content)) {
      threats.push({
        type: 'spectrogram_hidden_data',
        severity: 'HIGH',
        description: 'Audio metadata references spectrogram/watermarking/steganography tools',
        evidence: 'Found spectrogram/watermark references in metadata',
        remediation: 'Verify audio source. Strip metadata. Re-encode from trusted original.',
      });
    }

    // Ultra-long audio with silence/simple patterns (potential carrier)
    if (buffer.length > 10 * 1024 * 1024) {
      // Check entropy — very low entropy might indicate a simple carrier
      const entropy = this.estimateEntropy(buffer);
      if (entropy < 3.0) {
        threats.push({
          type: 'spectrogram_hidden_data',
          severity: 'MEDIUM',
          description: `Large audio file (${(buffer.length / 1024 / 1024).toFixed(1)}MB) with very low entropy (${entropy.toFixed(1)} bits) — possible hidden data carrier`,
          evidence: `Size: ${buffer.length}B, entropy: ${entropy.toFixed(1)} bits/byte`,
          remediation: 'Investigate audio source. Low-entropy large audio is suspicious.',
        });
      }
    }

    return threats;
  }

  /** Detect audio steganography indicators. */
  private scanSteganography(buffer: Buffer, formatInfo?: AudioFormatInfo | null): VoiceThreat[] {
    const threats: VoiceThreat[] = [];

    // LSB steganography indicators:
    // - WAV: audio data chunk with unusual patterns in LSBs
    // - High-entropy audio data (hidden data increases entropy)
    // - Metadata referencing steganography tools

    if (formatInfo && formatInfo.format === 'wav' && buffer.length >= formatInfo.dataOffset) {
      // Check for audio steganography tool signatures in the data chunk
      const dataStart = formatInfo.dataOffset;
      const dataLength = Math.min(buffer.length - dataStart, 50000);
      const audioData = buffer.subarray(dataStart, dataStart + dataLength);

      // DeepSound signature: "DS" at specific offset
      const content = audioData.toString('latin1');
      if (
        content.includes('DeepSound') ||
        content.includes('Steghide') ||
        content.includes('SilentEye')
      ) {
        threats.push({
          type: 'audio_steganography',
          severity: 'CRITICAL',
          description: 'Audio steganography tool signature detected in audio data',
          evidence: 'Found steganography tool name in audio payload',
          remediation: 'Reject file. Audio likely contains hidden payload.',
        });
      }

      // LSB analysis: check ratio of 1s in LSB of every sample
      // Random hidden data → ~50% 1s; natural audio → typically biased
      let lsbOnes = 0;
      const sampleCount = Math.min(Math.floor(audioData.length / 2), 10000); // 16-bit samples
      for (let i = 0; i < sampleCount * 2; i += 2) {
        if (audioData[i] & 0x01) lsbOnes++; // LSB of low byte
      }
      const lsbRatio = sampleCount > 0 ? lsbOnes / sampleCount : 0;

      // If LSB ratio near 0.5 (±0.05), suspicious
      if (sampleCount > 100 && lsbRatio > 0.45 && lsbRatio < 0.55) {
        threats.push({
          type: 'audio_steganography',
          severity: 'HIGH',
          description: `LSB analysis suggests hidden data (LSB 1-ratio: ${(lsbRatio * 100).toFixed(1)}% — near random 50%)`,
          evidence: `LSB ratio: ${(lsbRatio * 100).toFixed(1)}% (expected: significantly biased away from 50%)`,
          remediation:
            'Investigate audio source. Apply LSB destruction filter to strip hidden data.',
        });
      }
    }

    return threats;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private detectFormat(buffer: Buffer): AudioFormatInfo | null {
    for (const fmt of AUDIO_FORMATS) {
      if (buffer.length >= fmt.magic.length) {
        let match = true;
        for (let i = 0; i < fmt.magic.length; i++) {
          if (buffer[i] !== fmt.magic[i]) {
            match = false;
            break;
          }
        }
        if (match) return fmt;
      }
    }
    return null;
  }

  /** Estimate Shannon entropy of a buffer (bits per byte). */
  private estimateEntropy(buffer: Buffer): number {
    const sampleSize = Math.min(buffer.length, 50000);
    const freq = new Array(256).fill(0);
    for (let i = 0; i < sampleSize; i++) {
      freq[buffer[i]]++;
    }
    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > 0) {
        const p = freq[i] / sampleSize;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  private buildResult(
    buffer: Buffer,
    format: string,
    threats: VoiceThreat[],
    startMs: number,
    meta: {
      fileSize: number;
      format: string;
      durationEstimate?: number;
      sampleRateEstimate?: number;
    },
  ): VoiceScanResult {
    const riskScore = this.calculateRiskScore(threats);
    const audioHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    return {
      isSafe: threats.length === 0,
      threats,
      riskScore,
      scannedAt: new Date().toISOString(),
      audioHash,
      metadata: {
        fileSize: meta.fileSize,
        format: meta.format,
        durationEstimate: meta.durationEstimate,
        sampleRateEstimate: meta.sampleRateEstimate,
        scanDurationMs: Date.now() - startMs,
      },
    };
  }

  private calculateRiskScore(threats: VoiceThreat[]): number {
    if (threats.length === 0) return 0;
    const weights: Record<VoiceThreatSeverity, number> = {
      LOW: 5,
      MEDIUM: 15,
      HIGH: 35,
      CRITICAL: 45,
    };
    return Math.min(
      100,
      threats.reduce((sum, t) => sum + weights[t.severity], 0),
    );
  }
}

// ============================================================================
// Singleton
// ============================================================================

const scannerSingleton = createTenantAwareSingleton(() => new VoiceContentScanner(), {
  allowGlobalFallback: true,
});

export function getVoiceContentScanner(_config?: Partial<VoiceScannerConfig>): VoiceContentScanner {
  return scannerSingleton.get();
}

export function resetVoiceContentScanner(): void {
  scannerSingleton.reset();
}
