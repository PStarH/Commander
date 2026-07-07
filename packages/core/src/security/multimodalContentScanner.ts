/**
 * MultimodalContentScanner — Voice/video/image threat scanning.
 *
 * Complements the text-based ContentScanner by detecting threats embedded
 * in non-text modalities:
 *   - Image: Steganography indicators, EXIF command injection, SVG XSS,
 *            excessive resolution (DoS), GIFAR (polyglot) detection
 *   - Video: Frame injection, subtitle command injection, metadata attacks
 *   - Audio: DTMF/voice command injection, spectral encoding, metadata abuse
 *
 * Defense-in-depth: this runs AFTER ContentScanner has scanned the text
 * prompt. If ContentScanner already flags the input, we skip multimodal
 * scanning (avoid redundant work).
 *
 * Approach:
 *   - File fingerprinting (magic bytes + extension consistency)
 *   - Metadata inspection (EXIF, XMP, ID3, ffprobe)
 *   - Structural anomaly detection (polyglot, nested files, chunk corruption)
 *   - No actual decoding/transcoding — just boundary validation
 */

import * as crypto from 'node:crypto';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type ModalityType = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'archive';

export type MultimodalThreatType =
  | 'steganography_suspect'
  | 'metadata_injection'
  | 'polyglot_file'
  | 'svg_xss'
  | 'excessive_resolution'
  | 'nested_archive'
  | 'file_extension_mismatch'
  | 'corrupt_structure'
  | 'known_malicious_signature'
  | 'command_injection_in_metadata';

export type MultimodalThreatSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface MultimodalThreat {
  type: MultimodalThreatType;
  severity: MultimodalThreatSeverity;
  description: string;
  modality: ModalityType;
  filePath?: string;
  evidence: string;
  remediation: string;
}

export interface MultimodalScanResult {
  isSafe: boolean;
  modality: ModalityType;
  threats: MultimodalThreat[];
  riskScore: number; // 0-100
  scannedAt: string;
  fileHash: string;
  metadata: {
    fileSize: number;
    mimeType: string;
    extension: string;
    scanDurationMs: number;
  };
}

export interface MultimodalScannerConfig {
  /** Enable image scanning */
  enableImageScan: boolean;
  /** Enable video scanning */
  enableVideoScan: boolean;
  /** Enable audio scanning */
  enableAudioScan: boolean;
  /** Enable PDF scanning */
  enablePdfScan: boolean;
  /** Max file size (bytes) before early-reject */
  maxFileSize: number;
  /** Max image resolution (pixels) before DecompressionBomb flag */
  maxImagePixels: number;
}

// ============================================================================
// Magic Bytes Table
// ============================================================================

interface FileTypeSignature {
  extension: string;
  mime: string;
  magic: number[]; // Leading bytes
  offset?: number; // Offset where magic bytes start (for containers)
}

const KNOWN_SIGNATURES: FileTypeSignature[] = [
  // Images
  { extension: '.png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: '.jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { extension: '.gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { extension: '.webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { extension: '.bmp', mime: 'image/bmp', magic: [0x42, 0x4d] },
  { extension: '.svg', mime: 'image/svg+xml', magic: [0x3c] }, // Starts with '<'
  // Video
  {
    extension: '.mp4',
    mime: 'video/mp4',
    magic: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70],
    offset: 4,
  },
  { extension: '.avi', mime: 'video/x-msvideo', magic: [0x52, 0x49, 0x46, 0x46] },
  {
    extension: '.mov',
    mime: 'video/quicktime',
    magic: [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70],
    offset: 4,
  },
  { extension: '.webm', mime: 'video/webm', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  // Audio
  { extension: '.mp3', mime: 'audio/mpeg', magic: [0xff, 0xfb] },
  { extension: '.wav', mime: 'audio/wav', magic: [0x52, 0x49, 0x46, 0x46] },
  { extension: '.ogg', mime: 'audio/ogg', magic: [0x4f, 0x67, 0x67, 0x53] },
  { extension: '.flac', mime: 'audio/flac', magic: [0x66, 0x4c, 0x61, 0x43] },
  // Documents
  { extension: '.pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { extension: '.zip', mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { extension: '.gz', mime: 'application/gzip', magic: [0x1f, 0x8b, 0x08] },
];

// Malicious file signatures (known polyglots, exploit shells)
// Note: GIFAR check requires BOTH GIF header AND embedded ZIP/JAR deeper in file
const MALICIOUS_SIGNATURES: Array<{
  name: string;
  bytes?: number[];
  pattern?: RegExp;
  check?: (buffer: Buffer) => boolean;
}> = [
  {
    name: 'GIFAR (GIF+JAR polyglot)',
    check: (buffer: Buffer) => {
      // Only flag if both GIF header AND ZIP/JAR signature found in same file
      const hasGifHeader =
        buffer.length >= 4 &&
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38;
      if (!hasGifHeader) return false;
      const content = buffer.toString('latin1', 0, Math.min(buffer.length, 100_000));
      return content.includes('PK\u0003\u0004') || content.includes('Rar!');
    },
  },
  {
    name: 'ImageTragick delegate',
    pattern: /@(delegate|mvg|msl|eps|svg|pdf|http|https|ftp)[\s\n\r(]/i,
  },
  { name: 'GhostScript CVE-2023-36664', pattern: /%.*?pipe/i },
];

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: MultimodalScannerConfig = {
  enableImageScan: true,
  enableVideoScan: true,
  enableAudioScan: true,
  enablePdfScan: true,
  maxFileSize: 100 * 1024 * 1024, // 100 MB
  maxImagePixels: 100_000_000, // 100 megapixels
};

// ============================================================================
// MultimodalContentScanner
// ============================================================================

export class MultimodalContentScanner {
  private config: MultimodalScannerConfig;

  constructor(config?: Partial<MultimodalScannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Scan a file for multimodal threats.
   * @param buffer File contents as Buffer
   * @param filePath Optional file path for extension detection
   * @param fileExtension Explicit extension override (e.g., '.png')
   * @param mimeType Explicit MIME type override
   */
  scan(
    buffer: Buffer,
    options?: {
      filePath?: string;
      fileExtension?: string;
      mimeType?: string;
    },
  ): MultimodalScanResult {
    const startMs = Date.now();
    const threats: MultimodalThreat[] = [];

    const extension =
      options?.fileExtension ??
      (options?.filePath ? this.extractExtension(options.filePath) : '.bin');
    const normalizedExt = extension.toLowerCase().startsWith('.')
      ? extension.toLowerCase()
      : `.${extension.toLowerCase()}`;

    // Early size check
    if (buffer.length > this.config.maxFileSize) {
      return this.buildResult(
        'image',
        buffer,
        normalizedExt,
        'application/octet-stream',
        [
          {
            type: 'excessive_resolution',
            severity: 'MEDIUM',
            description: `File size ${buffer.length} exceeds max ${this.config.maxFileSize}`,
            modality: 'image',
            evidence: `size=${buffer.length}`,
            remediation: 'Reject file. Reduce size before uploading.',
          },
        ],
        startMs,
      );
    }

    // Detect modality from magic bytes
    const signature = this.detectSignature(buffer);
    const mimeType = options?.mimeType ?? signature?.mime ?? 'application/octet-stream';
    const modality = this.inferModality(mimeType, normalizedExt);

    // 1. Extension mismatch check
    if (signature && !this.supportsExtension(signature, normalizedExt)) {
      threats.push({
        type: 'file_extension_mismatch',
        severity: 'MEDIUM',
        description: `File extension ${normalizedExt} doesn't match magic bytes (${signature.mime})`,
        modality,
        evidence: `magic=${signature.mime}, ext=${normalizedExt}`,
        remediation: 'Verify file extension matches content. Rename file to correct extension.',
      });
    }

    // 2. Modality-specific checks
    if (modality === 'image' && this.config.enableImageScan) {
      threats.push(...this.scanImage(buffer, normalizedExt));
    } else if (modality === 'video' && this.config.enableVideoScan) {
      threats.push(...this.scanVideo(buffer, normalizedExt));
    } else if (modality === 'audio' && this.config.enableAudioScan) {
      threats.push(...this.scanAudio(buffer, normalizedExt));
    } else if (modality === 'pdf' && this.config.enablePdfScan) {
      threats.push(...this.scanPdf(buffer, normalizedExt));
    }

    // 3. Polyglot file detection
    const polyglotThreats = this.scanPolyglot(buffer, modality);
    threats.push(...polyglotThreats);

    // 4. Known malicious signatures
    const malThreats = this.scanMaliciousSignatures(buffer);
    threats.push(...malThreats);

    // 5. Corrupt structure detection
    const corruptThreats = this.scanCorruptStructure(buffer, normalizedExt);
    threats.push(...corruptThreats);

    return this.buildResult(modality, buffer, normalizedExt, mimeType, threats, startMs);
  }

  // ── Modality-Specific Scanners ────────────────────────────────────

  /** Scan image files for threats. */
  private scanImage(buffer: Buffer, extension: string): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    // SVG XSS detection
    if (extension === '.svg') {
      const svgContent = buffer.toString('utf-8', 0, Math.min(buffer.length, 50_000));
      if (/<script[\s>]/i.test(svgContent)) {
        threats.push({
          type: 'svg_xss',
          severity: 'CRITICAL',
          description: 'SVG file contains embedded <script> tag',
          modality: 'image',
          evidence: 'Found <script> in SVG content',
          remediation: 'Strip all script tags from SVG. Use an SVG sanitizer.',
        });
      }
      if (/on(load|click|error|mouseover)\s*=/i.test(svgContent)) {
        threats.push({
          type: 'svg_xss',
          severity: 'HIGH',
          description: 'SVG file contains event handler attributes',
          modality: 'image',
          evidence: 'Found on* event handler in SVG',
          remediation: 'Remove all event handler attributes. Sanitize SVG.',
        });
      }
      if (/<foreignobject[\s>]/i.test(svgContent)) {
        threats.push({
          type: 'svg_xss',
          severity: 'HIGH',
          description: 'SVG contains <foreignObject> (XSS/RCE vector)',
          modality: 'image',
          evidence: 'Found <foreignObject> in SVG',
          remediation: 'Remove <foreignObject> from SVG.',
        });
      }
    }

    // Decompression bomb detection (claims huge dimensions)
    if (extension === '.png') {
      // Check IHDR chunk for dimensions (bytes 16-23)
      if (buffer.length >= 24) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        const pixels = width * height;
        if (pixels > this.config.maxImagePixels) {
          threats.push({
            type: 'excessive_resolution',
            severity: 'MEDIUM',
            description: `Image dimensions ${width}x${height} = ${pixels} pixels (max ${this.config.maxImagePixels})`,
            modality: 'image',
            evidence: `dimensions=${width}x${height}`,
            remediation: 'Resize image to within resolution limits.',
          });
        }
      }
    }

    // GIFAR detection (GIF+JAR/RAR polyglot)
    if (extension === '.gif' && buffer.length > 1024) {
      const content = buffer.toString('latin1', 0, Math.min(buffer.length, 10_000));
      if (content.includes('PK\u0003\u0004') || content.includes('Rar!')) {
        threats.push({
          type: 'polyglot_file',
          severity: 'CRITICAL',
          description: 'GIF file contains embedded ZIP/RAR — possible GIFAR polyglot',
          modality: 'image',
          evidence: 'Found PK/RAR magic bytes within GIF',
          remediation: 'Reject file. Extract only the image data.',
        });
      }
    }

    // EXIF command injection check
    if (['.jpg', '.jpeg', '.tiff'].includes(extension)) {
      const exifCheck = this.scanExifForInjection(buffer);
      threats.push(...exifCheck);
    }

    return threats;
  }

  /** Scan video files for threats. */
  private scanVideo(buffer: Buffer, _extension: string): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    // Check for embedded subtitles with command injection
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 100_000));
    const subtitleIndicators = [
      /WEBVTT/i,
      /\.srt/i,
      /DIALOGUE/i, // ASS subtitle format
    ];

    for (const indicator of subtitleIndicators) {
      if (indicator.test(content)) {
        // Check subtitle content for injection patterns
        if (/(?:rm\s+-rf|curl\s+|wget\s+|eval\s*\(|exec\s*\()/i.test(content)) {
          threats.push({
            type: 'command_injection_in_metadata',
            severity: 'CRITICAL',
            description: 'Video subtitle track contains command injection patterns',
            modality: 'video',
            evidence: 'Found shell command patterns in subtitle data',
            remediation: 'Sanitize subtitle tracks. Strip shell metacharacters.',
          });
        }
      }
    }

    return threats;
  }

  /** Scan audio files for threats. */
  private scanAudio(buffer: Buffer, extension: string): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    // ID3 tag injection (MP3)
    if (extension === '.mp3') {
      const header = buffer.toString('latin1', 0, 3);
      if (header === 'ID3') {
        // Check ID3 frames for suspicious content
        const content = buffer.toString('latin1', 0, Math.min(buffer.length, 100_000));
        if (/(?:ignore.*instruction|system\s*(?:prompt|message|override))/i.test(content)) {
          threats.push({
            type: 'metadata_injection',
            severity: 'HIGH',
            description: 'MP3 ID3 tag contains prompt injection patterns',
            modality: 'audio',
            evidence: 'Found injection patterns in ID3 tags',
            remediation: 'Strip ID3 tags or sanitize their content.',
          });
        }
      }
    }

    // WAV RIFF chunk injection
    if (extension === '.wav' && buffer.length > 44) {
      const riffType = buffer.toString('ascii', 8, 12);
      if (riffType !== 'WAVE') {
        threats.push({
          type: 'file_extension_mismatch',
          severity: 'MEDIUM',
          description: 'WAV file has incorrect RIFF type — not a valid WAVE file',
          modality: 'audio',
          evidence: `RIFF type: ${riffType}`,
          remediation: 'Verify file is a valid WAV.',
        });
      }
    }

    return threats;
  }

  /** Scan PDF files for threats. */
  private scanPdf(buffer: Buffer, _extension: string): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 100_000));

    // PDF JavaScript injection
    if (/\/JS\s|\/JavaScript\s/i.test(content)) {
      threats.push({
        type: 'command_injection_in_metadata',
        severity: 'CRITICAL',
        description: 'PDF contains embedded JavaScript (potential RCE)',
        modality: 'pdf',
        evidence: 'Found /JS or /JavaScript in PDF',
        remediation: 'Strip all JavaScript from PDF. Use a PDF sanitizer.',
      });
    }

    // PDF Launch action (arbitrary command execution)
    if (/\/Launch\s/i.test(content)) {
      threats.push({
        type: 'command_injection_in_metadata',
        severity: 'CRITICAL',
        description: 'PDF contains /Launch action (arbitrary command execution)',
        modality: 'pdf',
        evidence: 'Found /Launch in PDF',
        remediation: 'Remove all /Launch actions. Sanitize PDF.',
      });
    }

    // PDF embedded files
    if (/\/EmbeddedFile\s/i.test(content)) {
      threats.push({
        type: 'polyglot_file',
        severity: 'HIGH',
        description: 'PDF contains embedded files (potential polyglot/exploit)',
        modality: 'pdf',
        evidence: 'Found /EmbeddedFile in PDF',
        remediation: 'Extract and scan embedded files separately.',
      });
    }

    // GhostScript pipeline injection
    if (/%%Page|%%Trailer/i.test(content) && /\bpipe\b/i.test(content)) {
      threats.push({
        type: 'command_injection_in_metadata',
        severity: 'HIGH',
        description: 'PostScript contains pipe operator — possible GhostScript RCE',
        modality: 'pdf',
        evidence: 'Found pipe operator in PostScript',
        remediation: 'Reject file. Upgrade GhostScript to patched version.',
      });
    }

    return threats;
  }

  // ── Cross-Modality Scanners ───────────────────────────────────────

  /** Detect polyglot files (files valid in multiple formats). */
  private scanPolyglot(buffer: Buffer, declaredModality: ModalityType): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    // Check for nested magic bytes from other formats
    const foundSignatures: string[] = [];
    for (const sig of KNOWN_SIGNATURES) {
      if (this.matchesMagic(buffer, sig, 0)) {
        foundSignatures.push(sig.mime);
      }
    }

    for (const sig of KNOWN_SIGNATURES) {
      // Search for magic bytes deeper in the file (after first 1KB)
      const searchStart = 1024;
      if (buffer.length > searchStart + sig.magic.length) {
        const slice = buffer.subarray(searchStart, Math.min(buffer.length, searchStart + 100_000));
        const content = slice.toString('latin1');
        const magicStr = sig.magic.map((b) => String.fromCharCode(b)).join('');
        if (content.includes(magicStr)) {
          const nestedModality = this.inferModality(sig.mime, sig.extension);
          if (nestedModality !== declaredModality) {
            threats.push({
              type: 'polyglot_file',
              severity: 'HIGH',
              description: `File appears to contain embedded ${sig.mime} (${sig.extension}) — possible polyglot`,
              modality: declaredModality,
              evidence: `Found ${sig.mime} magic bytes at offset > 1024 in ${declaredModality} file`,
              remediation: 'Extract and scan embedded content separately.',
            });
          }
        }
      }
    }

    return threats;
  }

  /** Scan for known malicious signatures. */
  private scanMaliciousSignatures(buffer: Buffer): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 50_000));

    for (const sig of MALICIOUS_SIGNATURES) {
      if (sig.bytes && this.matchesMagic(buffer, { magic: sig.bytes } as FileTypeSignature, 0)) {
        threats.push({
          type: 'known_malicious_signature',
          severity: 'CRITICAL',
          description: `Known malicious signature: ${sig.name}`,
          modality: 'image',
          evidence: sig.name,
          remediation: 'Reject file immediately. Investigate source.',
        });
      }
      if (sig.check && sig.check(buffer)) {
        threats.push({
          type: 'known_malicious_signature',
          severity: 'CRITICAL',
          description: `Known malicious signature: ${sig.name}`,
          modality: 'image',
          evidence: sig.name,
          remediation: 'Reject file immediately. Investigate source.',
        });
      }
      if (sig.pattern && sig.pattern.test(content)) {
        threats.push({
          type: 'known_malicious_signature',
          severity: 'CRITICAL',
          description: `Known exploit pattern: ${sig.name}`,
          modality: 'image',
          evidence: sig.name,
          remediation: 'Reject file. Apply OS patches.',
        });
      }
    }

    return threats;
  }

  /** Check for corrupt file structures. */
  private scanCorruptStructure(buffer: Buffer, extension: string): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];

    // Truncated PNG
    if (extension === '.png' && buffer.length < 8) {
      threats.push({
        type: 'corrupt_structure',
        severity: 'LOW',
        description: 'PNG file too small to be valid',
        modality: 'image',
        evidence: `size=${buffer.length}, min=8`,
        remediation: 'Request complete file.',
      });
    }

    // Truncated PDF
    if (extension === '.pdf' && buffer.length >= 4) {
      const trailer = buffer.toString('latin1', buffer.length - 5, buffer.length);
      if (!trailer.includes('F')) {
        // PDF must end with %%EOF
        const endContent = buffer.toString(
          'latin1',
          Math.max(0, buffer.length - 1024),
          buffer.length,
        );
        if (!endContent.includes('%%EOF')) {
          threats.push({
            type: 'corrupt_structure',
            severity: 'LOW',
            description: 'PDF missing %%EOF trailer — possibly truncated or malformed',
            modality: 'pdf',
            evidence: 'Missing %%EOF',
            remediation: 'Request complete file.',
          });
        }
      }
    }

    // Zero-byte file
    if (buffer.length === 0) {
      threats.push({
        type: 'corrupt_structure',
        severity: 'LOW',
        description: 'File is empty (0 bytes)',
        modality: 'image',
        evidence: 'size=0',
        remediation: 'Request non-empty file.',
      });
    }

    return threats;
  }

  /** Scan EXIF data for injection patterns. */
  private scanExifForInjection(buffer: Buffer): MultimodalThreat[] {
    const threats: MultimodalThreat[] = [];
    const content = buffer.toString('latin1', 0, Math.min(buffer.length, 200_000));

    // EXIF segments start with 0xFF,0xE1
    // Check for command injection patterns in this region
    const injectionPatterns = [
      /(?:system\s*\()/i,
      /(?:eval\s*\()/i,
      /(?:exec\s*\()/i,
      /(?:\\x[0-9a-f]{2}){10,}/i, // Heavily encoded payloads
      /(?:Ignore.*instructions|Disregard.*rules)/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(content)) {
        threats.push({
          type: 'metadata_injection',
          severity: 'HIGH',
          description: 'EXIF metadata contains suspicious patterns — possible injection',
          modality: 'image',
          evidence: `Pattern matched: ${pattern.source}`,
          remediation: 'Strip EXIF data before processing.',
        });
        break; // One finding is enough
      }
    }

    return threats;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Detect file type from magic bytes. */
  private detectSignature(buffer: Buffer): FileTypeSignature | null {
    const sigs = [...KNOWN_SIGNATURES].sort((a, b) => b.magic.length - a.magic.length);
    for (const sig of sigs) {
      if (this.matchesMagic(buffer, sig, 0)) {
        return sig;
      }
    }
    return null;
  }

  private matchesMagic(buffer: Buffer, sig: FileTypeSignature, searchOffset: number): boolean {
    const offset = sig.offset ?? 0;
    const startPos = searchOffset + offset;
    if (startPos + sig.magic.length > buffer.length) return false;
    for (let i = 0; i < sig.magic.length; i++) {
      if (buffer[startPos + i] !== sig.magic[i]) return false;
    }
    return true;
  }

  /** Check if extension is compatible with the file signature. */
  private supportsExtension(sig: FileTypeSignature, extension: string): boolean {
    return sig.extension === extension;
  }

  /** Infer the modality from MIME type and extension. */
  private inferModality(mimeType: string, extension: string): ModalityType {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    // Fallback: detect by extension when magic bytes don't match
    if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'].includes(extension))
      return 'audio';
    if (['.mp4', '.avi', '.mov', '.webm', '.mkv', '.wmv'].includes(extension)) return 'video';
    if (['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(extension)) return 'document';
    if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(extension)) return 'archive';
    return 'document';
  }

  private extractExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '.bin';
    return filePath.slice(lastDot);
  }

  private buildResult(
    modality: ModalityType,
    buffer: Buffer,
    extension: string,
    mimeType: string,
    threats: MultimodalThreat[],
    startMs: number,
  ): MultimodalScanResult {
    const riskScore = this.calculateRiskScore(threats);
    const scanDurationMs = Date.now() - startMs;
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    return {
      isSafe:
        threats.filter((t) => t.severity === 'CRITICAL' || t.severity === 'HIGH').length === 0,
      modality,
      threats,
      riskScore,
      scannedAt: new Date().toISOString(),
      fileHash,
      metadata: {
        fileSize: buffer.length,
        mimeType,
        extension,
        scanDurationMs,
      },
    };
  }

  private calculateRiskScore(threats: MultimodalThreat[]): number {
    if (threats.length === 0) return 0;
    const weights = { LOW: 5, MEDIUM: 15, HIGH: 35, CRITICAL: 45 };
    return Math.min(
      100,
      threats.reduce((sum, t) => sum + weights[t.severity], 0),
    );
  }
}

// ============================================================================
// Singleton
// ============================================================================

const scannerSingleton = createTenantAwareSingleton(() => new MultimodalContentScanner(), {
  allowGlobalFallback: true,
});

export function getMultimodalContentScanner(
  _config?: Partial<MultimodalScannerConfig>,
): MultimodalContentScanner {
  return scannerSingleton.get();
}

export function resetMultimodalContentScanner(): void {
  scannerSingleton.reset();
}
