/**
 * Silent failure reporter.
 *
 * Replaces the project's `} catch {}` / `} catch (e) {}` anti-pattern with a
 * single observable hook. Authors keep their intent (silent recovery) but
 * the swallowed error is now logged at debug level via the global Logger,
 * with a 60-second dedup window keyed by (file-context, error.message) so
 * a flood of identical recoverable failures does not produce a flood of
 * identical log lines.
 *
 * Three idioms are supported:
 *   1. import + call:
 *        catch (e) { reportSilentFailure(e, 'agentRuntime.execute:241'); }
 *   2. helper wrapper:
 *        const result = withSilentFailure(() => doThing(), 'subscriber.dispose');
 *   3. async wrapper:
 *        await withSilentFailureAsync(async () => doThingAsync(), 'subscriber.flush');
 *
 * The module must NEVER throw — the global Logger may itself fail in some
 * edge configurations, and the whole point of this reporter is to absorb
 * errors that callers deliberately chose to silence.
 */
import { getGlobalLogger } from './logging';
// ── Dedupe cache ─────────────────────────────────────────────────────────
// Key: `${context}::${msg || 'unknown'}`. Value: last-emitted epoch ms.
// Identical (file:op, error.message) reports are suppressed for a window so
// that, e.g., 10,000 db-close failures during a fleet shutdown don't flood
// logs with 10,000 identical entries.
const dedupeCache = new Map();
/** Time-to-live for a deduplicated entry, in milliseconds. */
const DEDUPE_WINDOW_MS = 60_000;
/** Hard cap on dedupe cache entries (defense against unbounded growth). */
const DEDUPE_CACHE_LIMIT = 5_000;
/** Hackable from tests. */
let dedupeWindowMs = DEDUPE_WINDOW_MS;
/**
 * Test-only: reset the dedupe cache so unit tests asserting "this exact
 * error was logged once" don't see stale entries from prior tests.
 */
export function _resetSilentFailureCacheForTesting() {
    dedupeCache.clear();
}
/** Test-only: override the dedup window. */
export function _setSilentFailureWindowForTesting(ms) {
    dedupeWindowMs = ms;
}
function shortMessage(err) {
    if (err instanceof Error)
        return err.message || err.name;
    if (typeof err === 'string')
        return err;
    try {
        return JSON.stringify(err);
    }
    catch (err) {
        console.warn('[Catch]', err);
        return String(err);
    }
}
function shortStack(err) {
    if (err instanceof Error && err.stack)
        return err.stack.split('\n').slice(0, 3).join(' | ');
    return undefined;
}
/**
 * Record that an error was silently recovered from. Emits a debug-level log
 * via the global Logger. Deduplicates identical reports within
 * `dedupeWindowMs`. Never throws.
 */
export function reportSilentFailure(error, context) {
    let logger;
    try {
        logger = getGlobalLogger();
    }
    catch (err) {
        console.warn('[Catch]', err);
        // Logger itself unavailable — fall through to a no-op. We deliberately
        // do NOT console.error here: the whole point of this module is silence
        // with observability, and a noisy reporter would defeat the contract.
        return;
    }
    let msg;
    try {
        msg = shortMessage(error);
    }
    catch (err) {
        console.warn('[Catch]', err);
        msg = 'unknown';
    }
    const key = `${context}::${msg}`;
    const now = Date.now();
    const last = dedupeCache.get(key);
    if (last !== undefined && now - last < dedupeWindowMs) {
        return; // dedup hit, drop on the floor
    }
    dedupeCache.set(key, now);
    // Cap cache to prevent unbounded growth on long-running processes with many
    // distinct (context, msg) pairs (e.g. per-file paths).
    if (dedupeCache.size > DEDUPE_CACHE_LIMIT) {
        // Drop the oldest 25% in one pass — amortize churn.
        const dropCount = Math.floor(DEDUPE_CACHE_LIMIT / 4);
        let dropped = 0;
        for (const k of dedupeCache.keys()) {
            if (dropped >= dropCount)
                break;
            dedupeCache.delete(k);
            dropped++;
        }
    }
    try {
        logger.debug('BestEffort', `silently recovered in ${context}`, {
            error: msg,
            stack: shortStack(error),
        });
    }
    catch (err) {
        console.warn('[Catch]', err);
        /* logger may throw — never let reporter throw */
    }
}
/**
 * Run a synchronous function and swallow any error it throws. The original
 * exception is observable via reportSilentFailure. Returns the result of fn
 * or `fallback` (default undefined) if fn throws.
 */
export function withSilentFailure(fn, context, fallback) {
    try {
        return fn();
    }
    catch (err) {
        reportSilentFailure(err, context);
        return fallback;
    }
}
/**
 * Async twin of withSilentFailure. Awaits the promise; rejects that turn to
 * a swallowed error + undefined return. Use only where the caller has
 * already chosen silent recovery — this helper magnifies that choice, not
 * replaces it.
 */
export async function withSilentFailureAsync(fn, context, fallback) {
    try {
        return await fn();
    }
    catch (err) {
        reportSilentFailure(err, context);
        return fallback;
    }
}
