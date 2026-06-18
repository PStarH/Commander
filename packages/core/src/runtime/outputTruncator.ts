/**
 * OutputTruncator — Token-aware tool output truncation.
 *
 * Implements Codex-style head+tail preservation. When tool output exceeds
 * a configured size budget, the middle is elided and replaced with a marker
 * showing how much content was removed. This preserves the most useful
 * information (file headers, error messages, end-of-file state) while
 * keeping the context window small.
 *
 * Strategies:
 * - `head-tail`: keep first N lines and last M lines
 * - `head-tail-bytes`: keep first N bytes and last M bytes (for binary-ish output)
 * - `smart-trim`: head+tail with a heuristic to retain error/exception
 *   blocks from anywhere in the output
 * - `none`: pass-through
 */

export type TruncationStrategy = 'head-tail' | 'head-tail-bytes' | 'smart-trim' | 'none';

export interface OutputTruncatorConfig {
  /** When output exceeds maxBytes, apply truncation (default: true) */
  enabled: boolean;
  /** Maximum bytes before truncation kicks in (default: 50KB) */
  maxBytes: number;
  /** Number of lines to preserve at the start (default: 50) */
  headLines: number;
  /** Number of lines to preserve at the end (default: 50) */
  tailLines: number;
  /** Number of bytes to preserve at the start for byte-based strategies (default: 8KB) */
  headBytes: number;
  /** Number of bytes to preserve at the end for byte-based strategies (default: 8KB) */
  tailBytes: number;
  /** Marker placed between head and tail (default: '\n...[truncated N bytes]...\n') */
  markerTemplate: string;
  /** Strategy to apply when maxBytes is exceeded (default: 'head-tail') */
  strategy: TruncationStrategy;
  /** For smart-trim: regex patterns that indicate "important" lines to keep */
  importantPatterns: RegExp[];
  /** For smart-trim: max number of "important" middle lines to retain */
  maxImportantLines: number;
}

const DEFAULT_CONFIG: OutputTruncatorConfig = {
  enabled: true,
  maxBytes: 50 * 1024,
  headLines: 50,
  tailLines: 50,
  headBytes: 8 * 1024,
  tailBytes: 8 * 1024,
  markerTemplate: '\n...[{elided} bytes elided from {original} total]...\n',
  strategy: 'head-tail',
  importantPatterns: [
    /error|exception|fatal|fail/i,
    /^at\s+/,
    /throw\s+/i,
    /\bERR_[A-Z_]+\b/,
    /\bTypeError\b/,
    /\bReferenceError\b/,
    /\bSyntaxError\b/,
  ],
  maxImportantLines: 20,
};

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalBytes: number;
  elidedBytes: number;
  strategy: TruncationStrategy;
}

export class OutputTruncator {
  private config: OutputTruncatorConfig;

  constructor(config?: Partial<OutputTruncatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): OutputTruncatorConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<OutputTruncatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Truncate the given content according to the configured strategy.
   * Returns the (possibly truncated) content plus metadata.
   */
  truncate(content: string): TruncationResult {
    const originalBytes = Buffer.byteLength(content, 'utf-8');

    if (!this.config.enabled || this.config.strategy === 'none') {
      return {
        content,
        truncated: false,
        originalBytes,
        elidedBytes: 0,
        strategy: this.config.strategy,
      };
    }

    if (originalBytes <= this.config.maxBytes) {
      return {
        content,
        truncated: false,
        originalBytes,
        elidedBytes: 0,
        strategy: this.config.strategy,
      };
    }

    switch (this.config.strategy) {
      case 'head-tail':
        return this.truncateHeadTail(content, originalBytes);
      case 'head-tail-bytes':
        return this.truncateHeadTailBytes(content, originalBytes);
      case 'smart-trim':
        return this.truncateSmart(content, originalBytes);
      default:
        return {
          content,
          truncated: false,
          originalBytes,
          elidedBytes: 0,
          strategy: this.config.strategy,
        };
    }
  }

  private truncateHeadTail(content: string, originalBytes: number): TruncationResult {
    const lines = content.split('\n');
    const headLines = this.config.headLines;
    const tailLines = this.config.tailLines;

    if (lines.length <= headLines + tailLines) {
      return this.truncateHeadTailBytes(content, originalBytes);
    }

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(lines.length - tailLines).join('\n');
    const marker = this.renderMarker(originalBytes, head.length + tail.length);
    const truncated = `${head}${marker}${tail}`;

    return {
      content: truncated,
      truncated: true,
      originalBytes,
      elidedBytes: originalBytes - Buffer.byteLength(truncated, 'utf-8'),
      strategy: 'head-tail',
    };
  }

  private truncateHeadTailBytes(content: string, originalBytes: number): TruncationResult {
    const headBytes = this.config.headBytes;
    const tailBytes = this.config.tailBytes;

    let headEnd = headBytes;
    while (headEnd > 0 && (content.charCodeAt(headEnd - 1) & 0b11000000) === 0b10000000) {
      headEnd--;
    }
    let tailStart = Math.max(0, content.length - tailBytes);
    while (
      tailStart < content.length &&
      (content.charCodeAt(tailStart) & 0b11000000) === 0b10000000
    ) {
      tailStart++;
    }

    if (tailStart <= headEnd) {
      return {
        content,
        truncated: false,
        originalBytes,
        elidedBytes: 0,
        strategy: 'head-tail-bytes',
      };
    }

    const head = content.slice(0, headEnd);
    const tail = content.slice(tailStart);
    const marker = this.renderMarker(originalBytes, head.length + tail.length);
    const truncated = `${head}${marker}${tail}`;

    return {
      content: truncated,
      truncated: true,
      originalBytes,
      elidedBytes: originalBytes - Buffer.byteLength(truncated, 'utf-8'),
      strategy: 'head-tail-bytes',
    };
  }

  private truncateSmart(content: string, originalBytes: number): TruncationResult {
    const lines = content.split('\n');
    const headLines = this.config.headLines;
    const tailLines = this.config.tailLines;
    const maxImportant = this.config.maxImportantLines;

    const middle = lines.slice(headLines, Math.max(headLines, lines.length - tailLines));
    const importantMatches: Array<{ line: string; index: number }> = [];
    for (let i = 0; i < middle.length; i++) {
      const line = middle[i] ?? '';
      if (this.config.importantPatterns.some((p) => p.test(line))) {
        importantMatches.push({ line, index: headLines + i });
      }
      if (importantMatches.length >= maxImportant) break;
    }

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(Math.max(0, lines.length - tailLines)).join('\n');
    const marker = this.renderMarker(
      originalBytes,
      head.length + tail.length + importantMatches.reduce((s, m) => s + m.line.length + 1, 0),
    );

    const importantBlock =
      importantMatches.length > 0
        ? `\n[retained ${importantMatches.length} important middle lines]\n${importantMatches.map((m) => `L${m.index + 1}: ${m.line}`).join('\n')}\n`
        : '';

    const truncated = `${head}${importantBlock}${marker}${tail}`;

    return {
      content: truncated,
      truncated: true,
      originalBytes,
      elidedBytes: originalBytes - Buffer.byteLength(truncated, 'utf-8'),
      strategy: 'smart-trim',
    };
  }

  private renderMarker(originalBytes: number, keptBytes: number): string {
    const elided = Math.max(0, originalBytes - keptBytes);
    return this.config.markerTemplate
      .replace('{elided}', String(elided))
      .replace('{original}', String(originalBytes));
  }
}
