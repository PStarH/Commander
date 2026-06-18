"use strict";
/**
 * Saga runtime — shared types.
 *
 * The saga runtime is the user-facing orchestration layer on top of the
 * ATR kernel (RunLedger + IdempotencyStore + LeaseManager). Public API
 * for the saga module.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_IDEMPOTENCY_TTL_SECONDS = exports.DEFAULT_LEASE_TTL_SECONDS = exports.DEFAULT_STEP_TIMEOUT_MS = exports.DEFAULT_RETRY_POLICY = void 0;
/** Default retry policy applied when a step doesn't override. */
exports.DEFAULT_RETRY_POLICY = {
    maxAttempts: 1,
    backoff: 'exponential',
    initialDelayMs: 100,
    maxDelayMs: 30000,
    jitter: 'equal',
};
/** Default step timeout. */
exports.DEFAULT_STEP_TIMEOUT_MS = 30000;
/** Default lease TTL. */
exports.DEFAULT_LEASE_TTL_SECONDS = 60;
/** Default idempotency TTL (7 days). */
exports.DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
