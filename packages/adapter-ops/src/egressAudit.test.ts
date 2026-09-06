/**
 * AUDIT-F1: a CIDR-only egress allowlist must not silently disable the
 * application-layer hostname gate. Before the fix, `10.0.0.0/8` alone passed
 * the daemon startup gate while assertEgressUrlAllowed allowed ANY host.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertEgressAllowlistBeforeDaemonStart, assertEgressUrlAllowed } from './egress.js';

describe('egress allowlist fail-closed (AUDIT-F1)', () => {
  test('empty allowlist refuses daemon start on non-demo cells (baseline behaviour kept)', () => {
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('unspecified', []),
      /EGRESS_ALLOWLIST_REQUIRED/,
    );
  });

  test('CIDR-only allowlist refuses daemon start (baseline hole: started + allow-any-host)', () => {
    // FAILING before the fix: the startup gate accepted the CIDR-only list
    // while the hostname check returned early — allow-any-host with
    // credentials attached.
    assert.throws(
      () => assertEgressAllowlistBeforeDaemonStart('unspecified', ['10.0.0.0/8', 'fd00::/8']),
      /EGRESS_ALLOWLIST_HOST_REQUIRED/,
    );
  });

  test('mixed hostname+CIDR allowlist starts and enforces hostnames', () => {
    assert.doesNotThrow(() =>
      assertEgressAllowlistBeforeDaemonStart('unspecified', ['api.github.com', '10.0.0.0/8']),
    );
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://api.github.com/x', ['api.github.com']),
    );
    assert.throws(
      () => assertEgressUrlAllowed('https://evil.example/x', ['api.github.com']),
      /ADAPTER_OPS_EGRESS_DENIED/,
    );
  });

  test('demo tier keeps its documented openness', () => {
    assert.doesNotThrow(() => assertEgressAllowlistBeforeDaemonStart('demo', []));
  });
});
