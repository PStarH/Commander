/**
 * WS3 §6 — Health check honesty probes.
 *
 * Replaces the fake-READY /ready handler (spec §6.1 gap) with real dependency
 * probes. The invariant is §6.2: a dependency that has not been probed MUST be
 * reported as `unknown`, never `ok`/`ready`. Only `fail` gates readiness;
 * `unknown`/`degraded` are surfaced honestly but do not fail the probe.
 *
 * Hard gates (503 if `fail`): database, kernel.
 * Soft indicators (never 503): effectBroker (honest presence probe; API process
 * does not host the worker-plane broker), warRoomStore (`degraded`),
 * memoryHeap (`degraded`).
 */

/** Outcome of a single dependency probe. */
export type ProbeStatus = 'ok' | 'fail' | 'unknown' | 'degraded';

/**
 * Probe functions for each dependency. `undefined` means the probe is not
 * wired (returns `unknown`); a function is invoked and its result mapped.
 */
export interface ReadinessProbeDeps {
  /** Database liveness probe (e.g. `SELECT 1`). Returns 'ok' or throws. */
  database?: () => Promise<'ok'>;
  /** Kernel gateway resolver; non-null = ok, null = fail. */
  kernel: () => unknown | null;
  /** EffectBroker resolver; non-null = ok, null = fail. */
  effectBroker: () => unknown | null;
  /** WarRoom store presence; true = ok, false = degraded (never gates). */
  warRoomStore?: () => boolean;
  /** Heap usage ratio 0..1; >0.8 = degraded (never gates). */
  memoryHeap?: () => number;
}

/** Run a database probe, mapping outcomes to ProbeStatus. */
export async function probeDatabase(
  fn: (() => Promise<'ok'>) | undefined,
): Promise<ProbeStatus> {
  if (!fn) return 'unknown';
  try {
    const result = await fn();
    return result === 'ok' ? 'ok' : 'unknown';
  } catch {
    return 'fail';
  }
}

/** Map a null/non-null resolver to ok/fail. */
export function probeKernel(fn: () => unknown | null): ProbeStatus {
  return fn() !== null ? 'ok' : 'fail';
}

/** Map a null/non-null resolver to ok/fail. */
export function probeEffectBroker(fn: () => unknown | null): ProbeStatus {
  return fn() !== null ? 'ok' : 'fail';
}

/** Map warRoomStore presence: true=ok, false=degraded. Never gates. */
export function probeWarRoomStore(fn: (() => boolean) | undefined): ProbeStatus {
  if (!fn) return 'unknown';
  return fn() ? 'ok' : 'degraded';
}

/** Map heap usage: <0.8 = ok, >=0.8 = degraded. Never gates. */
export function probeMemoryHeap(fn: (() => number) | undefined): ProbeStatus {
  if (!fn) return 'unknown';
  return fn() < 0.8 ? 'ok' : 'degraded';
}

/**
 * Hard gates whose `fail` status forces 503.
 *
 * effectBroker is intentionally NOT a hard gate: the API process does not
 * host the worker-plane `@commander/effect-broker`. Presence is still probed
 * and reported honestly; a throw-on-admit stub must not mint a green hard gate.
 */
const HARD_GATES = ['database', 'kernel'] as const;

export interface ReadinessResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, ProbeStatus>;
  timestamp: string;
}

/**
 * Run all configured probes and aggregate into a readiness verdict.
 *
 * - Any hard gate with status `fail` → `not_ready` (503).
 * - `unknown`/`degraded` are honest indicators but never gate (§6.2).
 */
export async function probeReadiness(deps: ReadinessProbeDeps): Promise<ReadinessResult> {
  const checks: Record<string, ProbeStatus> = {
    database: await probeDatabase(deps.database),
    kernel: probeKernel(deps.kernel),
    effectBroker: probeEffectBroker(deps.effectBroker),
    warRoomStore: probeWarRoomStore(deps.warRoomStore),
    memoryHeap: probeMemoryHeap(deps.memoryHeap),
  };

  const anyHardGateFailed = HARD_GATES.some((gate) => checks[gate] === 'fail');
  return {
    status: anyHardGateFailed ? 'not_ready' : 'ready',
    checks,
    timestamp: new Date().toISOString(),
  };
}
