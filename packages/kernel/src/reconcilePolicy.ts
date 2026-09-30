import type { ReconcilePolicy } from './types.js';

export const RECONCILE_MAX_ATTEMPTS = 8 as const;
export const RECONCILE_INITIAL_DELAY_MS = 30_000 as const;
export const RECONCILE_MAX_DELAY_MS = 900_000 as const;
export const RECONCILE_CLAIM_TTL_MS = 60_000 as const;
export const DEFAULT_RECONCILE_DEADLINE_MS = 86_400_000;

function instant(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return parsed;
}

export function reconcileDeadlineWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COMMANDER_RECONCILE_DEADLINE_MS?.trim();
  if (!raw) return DEFAULT_RECONCILE_DEADLINE_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('RECONCILE_DEADLINE_WINDOW_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('RECONCILE_DEADLINE_WINDOW_INVALID');
  }
  return value;
}

export function createReconcilePolicy(input: {
  unknownAt: string;
  governedActionDeadlineAt?: string | null;
  deadlineWindowMs?: number;
}): ReconcilePolicy {
  const unknownAt = instant(input.unknownAt, 'RECONCILE_UNKNOWN_AT_INVALID');
  const window = input.deadlineWindowMs ?? DEFAULT_RECONCILE_DEADLINE_MS;
  if (!Number.isSafeInteger(window) || window <= 0 || unknownAt + window > 8_640_000_000_000_000) {
    throw new Error('RECONCILE_DEADLINE_WINDOW_INVALID');
  }
  const governed = input.governedActionDeadlineAt
    ? instant(input.governedActionDeadlineAt, 'RECONCILE_GOVERNED_DEADLINE_INVALID')
    : Number.POSITIVE_INFINITY;
  const deadlineAt = Math.min(unknownAt + window, governed);
  if (deadlineAt <= unknownAt) throw new Error('RECONCILE_DEADLINE_INVALID');
  return {
    maxAttempts: RECONCILE_MAX_ATTEMPTS,
    initialDelayMs: RECONCILE_INITIAL_DELAY_MS,
    maxDelayMs: RECONCILE_MAX_DELAY_MS,
    deadlineAt: new Date(deadlineAt).toISOString(),
  };
}

export function nextReconcileAfter(
  policy: ReconcilePolicy,
  attemptsAfterCommit: number,
  observedAt: string,
): string {
  if (!Number.isSafeInteger(attemptsAfterCommit) || attemptsAfterCommit < 1) {
    throw new Error('RECONCILE_ATTEMPT_INVALID');
  }
  const observed = instant(observedAt, 'RECONCILE_OBSERVED_AT_INVALID');
  const delay = Math.min(
    policy.initialDelayMs * 2 ** Math.max(0, attemptsAfterCommit - 1),
    policy.maxDelayMs,
  );
  return new Date(
    Math.min(observed + delay, instant(policy.deadlineAt, 'RECONCILE_DEADLINE_INVALID')),
  ).toISOString();
}
