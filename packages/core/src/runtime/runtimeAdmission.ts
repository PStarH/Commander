/**
 * Runtime admission control — wires BackpressureController to HTTP execute
 * and scheduler entry points (M5).
 */

import { getGlobalLogger } from '../logging';
import {
  getGlobalBackpressureController,
  setGlobalBackpressureController,
  BackpressureController,
} from './backpressureController';

export type AdmissionLane = 'http_execute' | 'scheduler' | 'default';

let admissionEnabled = process.env.COMMANDER_ADMISSION_CONTROL !== '0';

export function isAdmissionControlEnabled(): boolean {
  return admissionEnabled;
}

export function setAdmissionControlEnabled(enabled: boolean): void {
  admissionEnabled = enabled;
}

/**
 * Configure the global backpressure controller from environment.
 * Called once during service initialization.
 */
export function bootstrapRuntimeAdmission(): void {
  const maxTokens = Number(process.env.COMMANDER_ADMISSION_MAX_TOKENS ?? '100');
  const refill = Number(process.env.COMMANDER_ADMISSION_REFILL_PER_SEC ?? '50');
  const bufferSize = Number(process.env.COMMANDER_ADMISSION_BUFFER_SIZE ?? '200');

  if (!Number.isFinite(maxTokens) || !Number.isFinite(refill) || maxTokens <= 0 || refill <= 0) {
    getGlobalLogger().warn('RuntimeAdmission', 'Invalid admission config; using defaults');
    return;
  }

  setGlobalBackpressureController(
    new BackpressureController({
      maxTokens,
      refillRatePerSecond: refill,
      bufferSize,
    }),
  );
  getGlobalLogger().info('RuntimeAdmission', 'Admission control configured', {
    maxTokens,
    refillRatePerSecond: refill,
    bufferSize,
  });
}

/**
 * Acquire admission for a runtime operation. Returns false when load-shedding.
 */
export async function acquireRuntimeAdmission(lane: AdmissionLane = 'default'): Promise<boolean> {
  if (!admissionEnabled) return true;
  const granted = await getGlobalBackpressureController().acquire();
  if (!granted) {
    getGlobalLogger().debug('RuntimeAdmission', 'Admission rejected', { lane });
  }
  return granted;
}

/** Scheduler gate — probe capacity without consuming a token. */
export function canAdmitSchedulerWork(): boolean {
  if (!admissionEnabled) return true;
  return getGlobalBackpressureController().canAdmitSync();
}
/** Release an admission token after work completes. */
export function releaseRuntimeAdmission(): void {
  if (!admissionEnabled) return;
  getGlobalBackpressureController().release();
}
