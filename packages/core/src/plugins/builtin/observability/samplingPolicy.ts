/**
 * P-obs-2: Tail-based sampling policy for OTel Collector export.
 *
 * Two-phase sampling:
 *  - **Head-based** (in-process): deterministic hash decides up-front.
 *  - **Tail-based** (post-collection): the rule engine reconsiders after
 *    all spans are in, so we can keep traces that ended in error,
 *    exceeded latency, or had >N retries even if the head sample
 *    would have dropped them.
 *
 * The in-process implementation here mirrors what a downstream
 * OTel Collector would do via the `tail_sampling` processor. We
 * duplicate it so single-process deployments get sampling without
 * standing up a Collector.
 */

import type { TraceEvent } from '../../../runtime/types';

export interface SamplingPolicyConfig {
  /** Probability of head-sampling a routine trace. Default 0.05 (5%). */
  baseRate?: number;
  /** Always keep traces whose total duration exceeds this (ms). Default 30000. */
  keepIfLatencyMs?: number;
  /** Always keep traces with >= this many errors. Default 1. */
  keepIfErrorsAtLeast?: number;
  /** Always keep traces with >= this many LLM retries. Default 1. */
  keepIfRetriesAtLeast?: number;
  /** Always keep traces with quality score below this (0-1). Default 0.5. */
  keepIfQualityBelow?: number;
  /** Always keep traces with verification failures. Default true. */
  keepIfVerificationFailed?: boolean;
  /** Deterministic salt so two policies at the same rate differ. */
  salt?: string;
}

export interface SamplingDecision {
  keep: boolean;
  reason: 'base' | 'error' | 'latency' | 'retry' | 'quality' | 'verification' | 'drop';
  probability: number;
}

export class SamplingPolicy {
  private readonly baseRate: number;
  private readonly keepIfLatencyMs: number;
  private readonly keepIfErrorsAtLeast: number;
  private readonly keepIfRetriesAtLeast: number;
  private readonly keepIfQualityBelow: number;
  private readonly keepIfVerificationFailed: boolean;
  private readonly salt: string;

  constructor(config: SamplingPolicyConfig = {}) {
    this.baseRate = clampProbability(config.baseRate ?? 0.05);
    this.keepIfLatencyMs = config.keepIfLatencyMs ?? 30_000;
    this.keepIfErrorsAtLeast = config.keepIfErrorsAtLeast ?? 1;
    this.keepIfRetriesAtLeast = config.keepIfRetriesAtLeast ?? 1;
    this.keepIfQualityBelow = config.keepIfQualityBelow ?? 0.5;
    this.keepIfVerificationFailed = config.keepIfVerificationFailed ?? true;
    this.salt = config.salt ?? 'commander-default-salt';
  }

  /**
   * Decide whether to keep a complete trace. Tail-based: scans all
   * events and reconsiders the head decision based on final outcome.
   * Deterministic for testing: uses SHA-1-like djb2 hash of traceId
   * + salt so the same input always produces the same decision.
   */
  decide(events: TraceEvent[], traceId: string, totalDurationMs: number): SamplingDecision {
    // Tail rules: always keep. Order matters — the most specific
    // signal wins. A "retry" is a transient error that was
    // recovered; it IS an error, but classifying it as 'retry'
    // gives the operator a more useful signal ('we retried and
    // succeeded') than the generic 'error' bucket.
    const retryCount = countRetries(events);
    if (retryCount >= this.keepIfRetriesAtLeast) {
      return { keep: true, reason: 'retry', probability: 1.0 };
    }
    const errorCount = events.filter((e) => e.type === 'error').length;
    if (errorCount >= this.keepIfErrorsAtLeast) {
      return { keep: true, reason: 'error', probability: 1.0 };
    }
    if (totalDurationMs >= this.keepIfLatencyMs) {
      return { keep: true, reason: 'latency', probability: 1.0 };
    }
    if (this.keepIfVerificationFailed) {
      const verifications = events.filter((e) => e.type === 'verification');
      const failed = verifications.filter((e) => e.data.evaluationPassed === false);
      if (failed.length > 0) {
        return { keep: true, reason: 'verification', probability: 1.0 };
      }
    }
    const minScore = minEvaluationScore(events);
    if (minScore !== undefined && minScore < this.keepIfQualityBelow) {
      return { keep: true, reason: 'quality', probability: 1.0 };
    }
    // Head rule: hash-based probabilistic keep
    const u = djb2(`${this.salt}:${traceId}`);
    if (u < this.baseRate) {
      return { keep: true, reason: 'base', probability: this.baseRate };
    }
    return { keep: false, reason: 'drop', probability: this.baseRate };
  }

  /**
   * Convert to a YAML-ish config block an operator can drop into
   * their OTel Collector's `processors.tail_sampling` config.
   * Keeps Commander's policy in lockstep with the Collector.
   */
  toCollectorConfig(): {
    tail_sampling: {
      decision_wait: string;
      num_traces: number;
      expected_new_traces_per_sec: number;
      policies: Array<Record<string, unknown>>;
    };
  } {
    return {
      tail_sampling: {
        decision_wait: '10s',
        num_traces: 50000,
        expected_new_traces_per_sec: 100,
        policies: [
          {
            name: 'keep-on-error',
            type: 'status_code',
            status_code: { status_codes: ['ERROR'] },
          },
          {
            name: 'keep-on-latency',
            type: 'latency',
            latency: { threshold_ms: this.keepIfLatencyMs },
          },
          {
            name: 'probabilistic',
            type: 'probabilistic',
            probabilistic: { sampling_percentage: this.baseRate * 100 },
          },
        ],
      },
    };
  }

  /** Plain JSON snapshot for the /sampling HTTP endpoint. */
  toJSON(): SamplingPolicyConfig & { baseRate: number; salt: string } {
    return {
      baseRate: this.baseRate,
      keepIfLatencyMs: this.keepIfLatencyMs,
      keepIfErrorsAtLeast: this.keepIfErrorsAtLeast,
      keepIfRetriesAtLeast: this.keepIfRetriesAtLeast,
      keepIfQualityBelow: this.keepIfQualityBelow,
      keepIfVerificationFailed: this.keepIfVerificationFailed,
      salt: this.salt,
    };
  }
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.05;
  return Math.max(0, Math.min(1, p));
}

function countRetries(events: TraceEvent[]): number {
  // A "retry" is a step_error_boundary / llm_retry retry, surfaced
  // as an error event whose data marks it as a retry attempt. We
  // accept either of two flags the recorder may set:
  //   - `data.retrying === true`  (used by the runtime recorder)
  //   - `data.errorClass === 'transient'` (used by LLM retry classifier)
  // Cheap heuristic; if neither flag is set we still count any
  // error event whose `data.retryable === true`.
  return events.filter((e) => {
    if (e.type !== 'error') return false;
    const d = e.data as { retrying?: boolean; errorClass?: string; retryable?: boolean };
    return d.retrying === true || d.errorClass === 'transient' || d.retryable === true;
  }).length;
}

function minEvaluationScore(events: TraceEvent[]): number | undefined {
  const scores: number[] = [];
  for (const e of events) {
    if (e.type === 'verification' && typeof e.data.evaluationScore === 'number') {
      scores.push(e.data.evaluationScore);
    }
  }
  if (scores.length === 0) return undefined;
  return Math.min(...scores);
}

/** djb2 hash → [0, 1) deterministic float. Not cryptographic. */
function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Map signed 32-bit hash to [0, 1)
  return ((hash >>> 0) % 1_000_000) / 1_000_000;
}
