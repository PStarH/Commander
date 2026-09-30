/**
 * `?heartbeatMs=` bounds — web-realtime.md P2 ("heartbeat overflow defeats
 * minimum interval").
 *
 * The SSE router accepted any finite `heartbeatMs >= 5000`. Node coerces a
 * `setInterval` delay above 2^31-1 to **1 ms**, so `?heartbeatMs=2147483648`
 * passed the floor check and then scheduled a ~1000 writes/second loop — exactly
 * the event-loop pinning the floor was meant to prevent. A floor is not a bound.
 *
 * Two layers of proof:
 *   1. `resolveHeartbeatMs` never returns a value outside
 *      `[HEARTBEAT_FLOOR_MS, HEARTBEAT_CEILING_MS]`.
 *   2. The value it returns, handed to a real `setInterval`, is scheduled at
 *      that value — i.e. Node never reinterprets it. The hazard itself is
 *      reproduced in the last case so the test cannot silently stop testing it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_CEILING_MS,
  HEARTBEAT_DEFAULT_MS,
  HEARTBEAT_FLOOR_MS,
  resolveHeartbeatMs,
} from '../src/streamEndpoints';

/** Read the delay Node actually scheduled. */
function scheduledDelay(ms: number): number {
  const timer = setInterval(() => {}, ms);
  const actual = (timer as unknown as { _idleTimeout: number })._idleTimeout;
  clearInterval(timer);
  return actual;
}

describe('SSE heartbeat interval bounds', () => {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  after(() => {
    for (const timer of timers) clearInterval(timer);
  });

  it('the documented floor and ceiling are sane and ordered', () => {
    assert.ok(HEARTBEAT_FLOOR_MS > 0);
    assert.ok(HEARTBEAT_CEILING_MS > HEARTBEAT_FLOOR_MS);
    // The ceiling must stay clear of the setInterval overflow threshold
    // (2^31-1), above which Node silently schedules 1ms.
    assert.ok(HEARTBEAT_CEILING_MS < 2_147_483_647);
    assert.ok(HEARTBEAT_DEFAULT_MS >= HEARTBEAT_FLOOR_MS);
    assert.ok(HEARTBEAT_DEFAULT_MS <= HEARTBEAT_CEILING_MS);
  });

  it('clamps every input into the bounded range', () => {
    const cases: Array<[label: string, raw: unknown, expected: number]> = [
      ['default when absent', undefined, HEARTBEAT_DEFAULT_MS],
      ['documented floor', '5000', HEARTBEAT_FLOOR_MS],
      ['normal override', '25000', 25_000],
      ['the old floor boundary', '4999', HEARTBEAT_DEFAULT_MS],
      ['negative', '-1', HEARTBEAT_DEFAULT_MS],
      ['zero', '0', HEARTBEAT_DEFAULT_MS],
      ['NaN text', 'not-a-number', HEARTBEAT_DEFAULT_MS],
      ['Infinity text', 'Infinity', HEARTBEAT_DEFAULT_MS],
      ['huge finite text', '1e300', HEARTBEAT_DEFAULT_MS],
      ['empty', '', HEARTBEAT_DEFAULT_MS],
      // The regression: both of these used to pass through unchanged and
      // overflow the timer.
      ['2^31-1', '2147483647', HEARTBEAT_CEILING_MS],
      ['2^31', '2147483648', HEARTBEAT_CEILING_MS],
      ['far above 2^31', '99999999999', HEARTBEAT_CEILING_MS],
      // A repeated query parameter arrives as an array, not a string.
      ['repeated param (array)', ['5000', '2147483648'], HEARTBEAT_DEFAULT_MS],
    ];

    for (const [label, raw, expected] of cases) {
      const resolved = resolveHeartbeatMs(raw);
      assert.equal(resolved, expected, `${label}: expected ${expected}, got ${resolved}`);
      assert.ok(
        resolved >= HEARTBEAT_FLOOR_MS && resolved <= HEARTBEAT_CEILING_MS,
        `${label}: ${resolved} is outside [${HEARTBEAT_FLOOR_MS}, ${HEARTBEAT_CEILING_MS}]`,
      );
    }
  });

  it('the resolved value is what the timer is actually scheduled at', () => {
    for (const raw of ['5000', '25000', '2147483647', '2147483648', '99999999999']) {
      const resolved = resolveHeartbeatMs(raw);
      const timer = setInterval(() => {}, resolved);
      timers.push(timer);
      const actual = (timer as unknown as { _idleTimeout: number })._idleTimeout;
      assert.equal(
        actual,
        resolved,
        `?heartbeatMs=${raw} resolved to ${resolved} but was scheduled at ${actual}ms`,
      );
      assert.ok(
        actual >= HEARTBEAT_FLOOR_MS,
        `?heartbeatMs=${raw} scheduled a ${actual}ms interval — below the ${HEARTBEAT_FLOOR_MS}ms floor`,
      );
    }
  });

  it('reproduces the overflow the bound exists to prevent', () => {
    // Not a product assertion — it pins the platform behaviour the fix relies
    // on, so this test fails loudly if Node ever stops coercing the delay and
    // the ceiling could be relaxed.
    assert.equal(
      scheduledDelay(2_147_483_648),
      1,
      'expected Node to coerce an over-range setInterval delay to 1ms',
    );
    // And the bounded value is never in that regime.
    assert.notEqual(scheduledDelay(resolveHeartbeatMs('2147483648')), 1);
  });
});
