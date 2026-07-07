/**
 * TokenMetrics — Track token efficiency for hash-anchored edits.
 *
 * Measures how much token savings hash-anchored editing achieves vs.
 * traditional string-replacement. Inspired by OhMyPi's benchmarking:
 * - Grok 4 Fast: 61% fewer output tokens
 * - Grok Code Fast 1: 10x pass rate improvement
 */
export interface TokenMetricsSnapshot {
  /** Total tokens that would have been used with str_replace */
  traditionalTokens: number;
  /** Actual tokens used with hash-anchored editing */
  hashAnchoredTokens: number;
  /** Percentage saved */
  savingsPercent: number;
  /** Number of edits in this session */
  editCount: number;
  /** Number of edits that succeeded on first attempt */
  firstAttemptSuccess: number;
  /** Total edit attempts (including retries) */
  totalAttempts: number;
}

export class TokenMetrics {
  private snapshot: TokenMetricsSnapshot = {
    traditionalTokens: 0,
    hashAnchoredTokens: 0,
    savingsPercent: 0,
    editCount: 0,
    firstAttemptSuccess: 0,
    totalAttempts: 0,
  };

  /**
   * Record a hash-anchored edit. Estimate what the traditional
   * str_replace approach would have cost in tokens.
   */
  recordEdit(params: {
    hashesCount: number;
    replacementLength: number;
    oldContentLength: number;
    success: boolean;
    isRetry: boolean;
  }): void {
    const { hashesCount, replacementLength, oldContentLength, success, isRetry } = params;

    // Hash-anchored: hashes (~6 chars each) + replacement
    const hashTokens = Math.ceil((hashesCount * 6) / 4);
    const replacementTokens = Math.ceil(replacementLength / 4);
    const actualTokens = hashTokens + replacementTokens + 10; // +10 for overhead (¶, →, @)

    // Traditional str_replace: old content + new content
    const traditionalTokens = Math.ceil(oldContentLength / 4) + replacementTokens;

    this.snapshot.hashAnchoredTokens += actualTokens;
    this.snapshot.traditionalTokens += traditionalTokens;
    this.snapshot.editCount++;
    this.snapshot.totalAttempts++;

    if (!isRetry) {
      this.snapshot.firstAttemptSuccess++;
    }

    // Recalculate savings
    if (this.snapshot.traditionalTokens > 0) {
      this.snapshot.savingsPercent = Math.round(
        (1 - this.snapshot.hashAnchoredTokens / this.snapshot.traditionalTokens) * 100,
      );
    }
  }

  /** Record a failed attempt (retry) */
  recordRetry(): void {
    this.snapshot.totalAttempts++;
  }

  /** Get current metrics snapshot */
  getSnapshot(): Readonly<TokenMetricsSnapshot> {
    return { ...this.snapshot };
  }

  /** Get first-attempt success rate */
  getSuccessRate(): number {
    if (this.snapshot.editCount === 0) return 100;
    return Math.round((this.snapshot.firstAttemptSuccess / this.snapshot.editCount) * 100);
  }

  /** Format metrics as a human-readable summary */
  formatSummary(): string {
    const s = this.snapshot;
    if (s.editCount === 0) return 'No hash-anchored edits recorded yet.';

    return [
      `Token Efficiency: ${s.savingsPercent}% saved (${s.hashAnchoredTokens} vs ${s.traditionalTokens} traditional)`,
      `First-Attempt Success: ${this.getSuccessRate()}% (${s.firstAttemptSuccess}/${s.editCount})`,
      `Total Attempts: ${s.totalAttempts} (including ${s.totalAttempts - s.editCount} retries)`,
    ].join('\n');
  }

  /** Reset metrics for a new session */
  reset(): void {
    this.snapshot = {
      traditionalTokens: 0,
      hashAnchoredTokens: 0,
      savingsPercent: 0,
      editCount: 0,
      firstAttemptSuccess: 0,
      totalAttempts: 0,
    };
  }
}

// Global singleton
let globalTokenMetrics: TokenMetrics | null = null;

export function getTokenMetrics(): TokenMetrics {
  if (!globalTokenMetrics) {
    globalTokenMetrics = new TokenMetrics();
  }
  return globalTokenMetrics;
}

export function resetTokenMetrics(): void {
  globalTokenMetrics = null;
}
