/**
 * EffectBroker — process-local registry stub (NOT the production PEP).
 *
 * The full admit/execute monopoly lives in `@commander/effect-broker`
 * (worker-plane). This module only stores an optional in-process handle via
 * get/set for readiness probes and local experiments.
 *
 * Claim honesty:
 * - `setEffectBroker` is not wired on the live Gateway path today.
 * - A null registry is expected in `apps/api` and must not be reported as a
 *   hard health failure (see `apps/api/src/healthProbes.ts` → `unknown`).
 * - Production external effects go through worker-plane EffectBroker + kernel
 *   effect ledger; V1 tool paths still use SideEffectGate + ATR (strangler).
 * - `COMMANDER_EFFECT_BROKER_COMPAT=1` is a non-prod audit-logged escape hatch only.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

export interface EffectBroker {
  readonly kind: 'effect_broker';
  admit(req: unknown): unknown;
}

let globalEffectBroker: EffectBroker | null = null;

export function setEffectBroker(broker: EffectBroker | null): void {
  globalEffectBroker = broker;
}

export function getEffectBroker(): EffectBroker | null {
  return globalEffectBroker;
}

/**
 * Returns true only when the explicit compat mode is requested AND the
 * process is running outside production AND outside V2 enforcement mode.
 */
export function isEffectBrokerCompatEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.COMMANDER_V2_MODE === '1') return false;
  return process.env.COMMANDER_EFFECT_BROKER_COMPAT === '1';
}

/**
 * Audit hook invoked whenever the compat bypass is actually used. Always
 * logs a warning and reports a silent failure so that the bypass is visible
 * in logs and telemetry.
 */
export function requireEffectBrokerCompatAudit(): void {
  if (!isEffectBrokerCompatEnabled()) return;
  getGlobalLogger().warn(
    'EffectBroker',
    'COMPAT MODE ENABLED: side effects bypass strict broker enforcement',
    {
      nodeEnv: process.env.NODE_ENV,
      v2Mode: process.env.COMMANDER_V2_MODE,
    },
  );
  reportSilentFailure(new Error('EffectBroker compat mode enabled'), 'effectBroker:compat_audit');
}
