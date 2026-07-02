// ─────────────────────────────────────────────────────────────────────────────
// DeterminismCapture
//
// Soft determinism: instead of forbidding non-deterministic inputs (Temporal's
// approach), we RECORD them to the EventSourcingEngine WAL. During replay,
// recorded values are returned instead of re-computing — guaranteeing
// "replay produces same result" without constraining the execution model.
//
// This is the foundation for event replay recovery (Phase 2.2).
//
// Design:
// - During normal execution: capture() records values to event log
// - During replay: ReplayContext returns recorded values, skips real computation
// - Non-invasive: agent code calls capture/replay helpers, not raw Date.now()
// - Fire-and-forget: capture failures never block the critical path
// ─────────────────────────────────────────────────────────────────────────────

import { getGlobalEventSourcingEngine } from './eventSourcingEngine';
import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type NonDeterministicInput =
  | 'timestamp'
  | 'random'
  | 'llmResponse'
  | 'toolResponse'
  | 'externalApiCall';

export interface CapturedInput {
  runId: string;
  step: number;
  type: NonDeterministicInput;
  value: unknown;
  capturedAt: string;
}

export interface ReplayContext {
  /** Get a recorded timestamp (returns recorded value, not Date.now()) */
  getTimestamp(step: number): number;
  /** Get a recorded random value (returns recorded value, not Math.random()) */
  getRandom(step: number): number;
  /** Get a recorded LLM response (returns recorded value, no LLM call) */
  getLLMResponse(step: number): unknown;
  /** Get a recorded tool response (returns recorded value, no tool execution) */
  getToolResponse(step: number): unknown;
  /** Check if a recording exists for this step + type */
  has(type: NonDeterministicInput, step: number): boolean;
  /** Total number of recorded inputs for this run */
  size(): number;
  /** Whether this context is in replay mode */
  readonly isReplay: boolean;
}

// ============================================================================
// DeterminismCapture
// ============================================================================

/**
 * Captures non-deterministic inputs during agent execution and records them
 * to the EventSourcingEngine WAL. During replay, a ReplayContext is built
 * from these recordings to reproduce the exact same execution.
 */
export class DeterminismCapture {
  private captured: Map<string, CapturedInput> = new Map();
  private stepCounter: Map<string, number> = new Map();

  private key(runId: string, type: NonDeterministicInput, step: number): string {
    return `${runId}:${type}:${step}`;
  }

  /**
   * Capture a timestamp for a run step. During normal execution, this
   * records Date.now() to the event log. During replay, use ReplayContext.
   */
  captureTimestamp(runId: string, step: number): number {
    const now = Date.now();
    this.capture(runId, step, 'timestamp', now);
    return now;
  }

  /**
   * Capture a random value for a run step.
   */
  captureRandom(runId: string, step: number): number {
    const val = Math.random();
    this.capture(runId, step, 'random', val);
    return val;
  }

  /**
   * Capture an LLM response. Called AFTER the LLM returns — the response
   * is recorded so replay can skip the actual LLM call.
   */
  captureLLMResponse(runId: string, step: number, response: unknown): void {
    this.capture(runId, step, 'llmResponse', response);
  }

  /**
   * Capture a tool execution response. Called AFTER the tool returns.
   */
  captureToolResponse(runId: string, step: number, response: unknown): void {
    this.capture(runId, step, 'toolResponse', response);
  }

  /**
   * Capture an external API call response.
   */
  captureExternalApiCall(runId: string, step: number, response: unknown): void {
    this.capture(runId, step, 'externalApiCall', response);
  }

  /**
   * Get the next step number for a run (monotonically increasing).
   */
  nextStep(runId: string): number {
    const step = (this.stepCounter.get(runId) ?? 0) + 1;
    this.stepCounter.set(runId, step);
    return step;
  }

  /**
   * Build a ReplayContext for a run from captured inputs.
   * If no captures exist, returns null (caller should fall back to checkpoint).
   */
  buildReplayContext(runId: string): ReplayContext | null {
    const runCaptures: Map<string, unknown> = new Map();

    for (const [key, input] of this.captured) {
      if (input.runId === runId) {
        runCaptures.set(`${input.type}:${input.step}`, input.value);
      }
    }

    if (runCaptures.size === 0) return null;

    return {
      isReplay: true,
      getTimestamp: (step: number) => {
        const v = runCaptures.get(`timestamp:${step}`);
        return typeof v === 'number' ? v : Date.now();
      },
      getRandom: (step: number) => {
        const v = runCaptures.get(`random:${step}`);
        return typeof v === 'number' ? v : Math.random();
      },
      getLLMResponse: (step: number) => runCaptures.get(`llmResponse:${step}`),
      getToolResponse: (step: number) => runCaptures.get(`toolResponse:${step}`),
      has: (type: NonDeterministicInput, step: number) => runCaptures.has(`${type}:${step}`),
      size: () => runCaptures.size,
    };
  }

  /**
   * Clear all captures for a run (after successful recovery or abort).
   */
  clearRun(runId: string): void {
    this.stepCounter.delete(runId);
    for (const key of this.captured.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.captured.delete(key);
      }
    }
  }

  /**
   * Check if a run has captured inputs (i.e., is replayable).
   */
  hasCaptures(runId: string): boolean {
    for (const input of this.captured.values()) {
      if (input.runId === runId) return true;
    }
    return false;
  }

  /**
   * Rebuild in-memory captures for a run from the EventSourcingEngine WAL.
   *
   * After a process crash, the in-memory `captured` map is lost. This method
   * reads `determinism.*` events from the WAL (keyed by correlationId=runId)
   * and repopulates the in-memory map so that hasCaptures()/buildReplayContext()
   * work correctly during recovery.
   *
   * Called by RunRecovery.attempt() before checking hasCaptures().
   * Safe to call multiple times — idempotent (overwrites existing entries).
   */
  restoreFromWAL(runId: string): number {
    let restored = 0;
    try {
      const engine = getGlobalEventSourcingEngine();
      const events = engine.getEventsByCorrelationId(runId);
      for (const event of events) {
        if (!event.type.startsWith('determinism.')) continue;
        const type = event.type.slice('determinism.'.length) as NonDeterministicInput;
        if (
          !['timestamp', 'random', 'llmResponse', 'toolResponse', 'externalApiCall'].includes(type)
        ) {
          continue;
        }
        const payload = event.payload as
          | { step?: number; value?: unknown; capturedAt?: string }
          | undefined;
        if (!payload || typeof payload.step !== 'number') continue;

        const input: CapturedInput = {
          runId,
          step: payload.step,
          type,
          value: payload.value,
          capturedAt: payload.capturedAt ?? new Date(event.timestamp).toISOString(),
        };
        this.captured.set(this.key(runId, type, payload.step), input);
        restored++;
      }
      if (restored > 0) {
        // Rebuild stepCounter to avoid collisions with future captures
        let maxStep = 0;
        for (const input of this.captured.values()) {
          if (input.runId === runId && input.step > maxStep) {
            maxStep = input.step;
          }
        }
        this.stepCounter.set(runId, maxStep);
      }
    } catch (err) {
      reportSilentFailure(err, 'determinismCapture:restoreFromWAL');
    }
    return restored;
  }

  /**
   * Get capture statistics for a run.
   */
  getCaptureCount(runId: string): number {
    let count = 0;
    for (const input of this.captured.values()) {
      if (input.runId === runId) count++;
    }
    return count;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private capture(runId: string, step: number, type: NonDeterministicInput, value: unknown): void {
    const input: CapturedInput = {
      runId,
      step,
      type,
      value,
      capturedAt: new Date().toISOString(),
    };

    this.captured.set(this.key(runId, type, step), input);

    // Persist to EventSourcingEngine WAL (fire-and-forget)
    try {
      const engine = getGlobalEventSourcingEngine();
      engine
        .append({
          type: `determinism.${type}`,
          payload: { runId, step, value, capturedAt: input.capturedAt },
          correlationId: runId,
        })
        .catch((err: unknown) => {
          reportSilentFailure(err, 'determinismCapture:capture:append');
        });
    } catch (err) {
      reportSilentFailure(err, 'determinismCapture:capture:init');
    }
  }
}

// ============================================================================
// NoopReplayContext — for when replay is not available
// ============================================================================

/**
 * A ReplayContext that passes through to real computation (no replay).
 * Used when no captures exist or replay is disabled.
 */
export function createLiveContext(): ReplayContext {
  return {
    isReplay: false,
    getTimestamp: () => Date.now(),
    getRandom: () => Math.random(),
    getLLMResponse: () => undefined,
    getToolResponse: () => undefined,
    has: () => false,
    size: () => 0,
  };
}

// ============================================================================
// Singleton
// ============================================================================

let globalCapture: DeterminismCapture | null = null;

export function getGlobalDeterminismCapture(): DeterminismCapture {
  if (!globalCapture) {
    globalCapture = new DeterminismCapture();
    getGlobalLogger().debug('DeterminismCapture', 'Initialized');
  }
  return globalCapture;
}

/** Reset the global singleton — for test isolation only. */
export function resetGlobalDeterminismCapture(): void {
  globalCapture = null;
}
