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
/**
 * Test-only: reset the dedupe cache so unit tests asserting "this exact
 * error was logged once" don't see stale entries from prior tests.
 */
export declare function _resetSilentFailureCacheForTesting(): void;
/** Test-only: override the dedup window. */
export declare function _setSilentFailureWindowForTesting(ms: number): void;
/**
 * Record that an error was silently recovered from. Emits a debug-level log
 * via the global Logger. Deduplicates identical reports within
 * `dedupeWindowMs`. Never throws.
 */
export declare function reportSilentFailure(error: unknown, context: string): void;
/**
 * Run a synchronous function and swallow any error it throws. The original
 * exception is observable via reportSilentFailure. Returns the result of fn
 * or `fallback` (default undefined) if fn throws.
 */
export declare function withSilentFailure<T>(fn: () => T, context: string, fallback?: T): T | undefined;
/**
 * Async twin of withSilentFailure. Awaits the promise; rejects that turn to
 * a swallowed error + undefined return. Use only where the caller has
 * already chosen silent recovery — this helper magnifies that choice, not
 * replaces it.
 */
export declare function withSilentFailureAsync<T>(fn: () => T | Promise<T>, context: string, fallback?: T): Promise<T | undefined>;
