/**
 * Pure functions for validating state transitions.
 *
 * These helpers are transport- and storage-agnostic and can be used in unit
 * tests, SDK clients, and Gateway validation without importing the kernel.
 */

import { isTerminalRunState, isTerminalStepState, isValidRunTransition, isValidStepTransition, type RunState, type StepState } from './states.js';

export interface TransitionResult {
  ok: boolean;
  from: RunState | StepState;
  to: RunState | StepState;
  reason?: string;
}

export function validateRunTransition(from: RunState, to: RunState): TransitionResult {
  if (isTerminalRunState(from) && from !== to) {
    return { ok: false, from, to, reason: `Run state ${from} is terminal` };
  }
  if (!isValidRunTransition(from, to)) {
    return { ok: false, from, to, reason: `Invalid run transition ${from} -> ${to}` };
  }
  return { ok: true, from, to };
}

export function validateStepTransition(from: StepState, to: StepState): TransitionResult {
  if (isTerminalStepState(from) && from !== to) {
    return { ok: false, from, to, reason: `Step state ${from} is terminal` };
  }
  if (!isValidStepTransition(from, to)) {
    return { ok: false, from, to, reason: `Invalid step transition ${from} -> ${to}` };
  }
  return { ok: true, from, to };
}
