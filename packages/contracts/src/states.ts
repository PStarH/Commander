/**
 * Canonical Run/Step state machines for Architecture V2.
 *
 * This module is the single source of truth for execution lifecycle states and
 * valid transitions. All other packages (kernel, SDK, Gateway, worker-plane)
 * must derive their public types from these constants.
 */

export const RUN_STATES = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'COMPENSATING',
  'COMPENSATED',
] as const;

export const STEP_STATES = [
  'PENDING',
  'RUNNING',
  'WAITING_FOR_HUMAN',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type StepState = (typeof STEP_STATES)[number];

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'COMPENSATED',
]);

export const TERMINAL_STEP_STATES: ReadonlySet<StepState> = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
]);

/** Valid run state transitions keyed by current state. */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  // PENDING/PAUSED may still hold COMPLETED effects (e.g. pause then deadline);
  // compensation replaces the historical *→FAILED finish path in those cases.
  PENDING: ['RUNNING', 'PAUSED', 'FAILED', 'CANCELLED', 'COMPENSATING'],
  RUNNING: ['PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'COMPENSATING'],
  PAUSED: ['RUNNING', 'FAILED', 'CANCELLED', 'COMPENSATING'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  COMPENSATING: ['COMPENSATED', 'FAILED'],
  COMPENSATED: [],
};

/** Valid step state transitions keyed by current state. */
export const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  PENDING: ['RUNNING', 'SKIPPED', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING_FOR_HUMAN', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_HUMAN: ['RUNNING', 'FAILED', 'CANCELLED'],
  RETRY_WAIT: ['RUNNING', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  SKIPPED: [],
};

export function isValidRunTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isValidStepTransition(from: StepState, to: StepState): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function isTerminalStepState(state: StepState): boolean {
  return TERMINAL_STEP_STATES.has(state);
}
