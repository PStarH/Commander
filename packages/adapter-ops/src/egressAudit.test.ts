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

/**
 * AO-05: the transport gate itself was fail-open — an empty allowlist returned without
 * adjudicating anything, a CIDR-only list did the same, and the URL's scheme was never
 * checked (plaintext http to an allowed host passed). Bare entries also matched any
 * subdomain via `host.endsWith('.' + entry)`.
 */
describe('egress transport gate fail-closed (AO-05)', () => {
  test('empty allowlist denies instead of allowing any host', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://exfil.example/steal', []),
      /ADAPTER_OPS_EGRESS_DENIED: COMMANDER_ADAPTER_EGRESS_ALLOWLIST is empty/,
    );
  });

  test('empty allowlist is allowed only when the caller declares demo openness', () => {
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://exfil.example/steal', [], { allowEmptyAllowlist: true }),
    );
  });

  test('CIDR-only allowlist denies the hostname instead of returning', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://exfil.example/steal', ['10.0.0.0/8']),
      /no hostname entry to adjudicate/,
    );
  });

  test('plaintext http to an allowlisted host is denied', () => {
    assert.throws(
      () => assertEgressUrlAllowed('http://api.github.com/repos', ['api.github.com']),
      /scheme http: is not permitted/,
    );
  });

  test('http stays available for loopback targets', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.doesNotThrow(() =>
        assertEgressUrlAllowed(`http://${host}:8080/health`, [host.replace(/^\[|\]$/g, '')]),
      );
    }
  });

  test('non-http(s) schemes are denied', () => {
    assert.throws(
      () => assertEgressUrlAllowed('file:///etc/passwd', ['api.github.com']),
      /scheme file: is not permitted/,
    );
  });

  test('a bare entry no longer matches arbitrary subdomains', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://attacker.github.com/repos', ['github.com']),
      /ADAPTER_OPS_EGRESS_DENIED: host attacker\.github\.com/,
    );
    assert.doesNotThrow(() => assertEgressUrlAllowed('https://github.com/repos', ['github.com']));
  });

  test('an explicit *. entry still matches subdomains', () => {
    assert.doesNotThrow(() =>
      assertEgressUrlAllowed('https://acme.service-now.com/api', ['*.service-now.com']),
    );
    assert.throws(
      () =>
        assertEgressUrlAllowed('https://service-now.com.evil.example/api', ['*.service-now.com']),
      /ADAPTER_OPS_EGRESS_DENIED/,
    );
  });

  test('a malformed wildcard entry is rejected rather than never matching', () => {
    assert.throws(
      () => assertEgressUrlAllowed('https://api.github.com/x', ['api.*.com']),
      /ADAPTER_OPS_EGRESS_ALLOWLIST_INVALID/,
    );
  });
});
