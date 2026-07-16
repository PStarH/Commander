/**
 * net-isolation.test.ts — WS9 §4.3 cross-tenant NET isolation live-fire.
 *
 * Closes D.1 §3 (outbound network isolation + SSRF defense).
 *
 * The OutboundNetworkPolicy is a per-process fetch interceptor. WS9
 * exercises it through three vectors per spec §4.3:
 *
 *   NET-1: A and B have different allowlists; A cannot reach B's allowed domain.
 *   NET-2: A's workload attempts SSRF to 169.254.169.254 / private net.
 *   NET-3: A tries host network as fallback — rejected by policy.
 *
 * All three assertions exercise the real OutboundNetworkPolicy.check() path
 * and emit `evidenceLevel=simulated` artifacts unless a real multi-process
 * network path is exercised (in-process OutboundNetworkPolicy checks alone
 * are not live/SOC evidence).
 * not a mock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OutboundNetworkPolicy } from '../../src/security/outboundNetworkPolicy';
import {
  writePass,
  writeBreach,
  TENANT_A,
  TENANT_B,
} from './_evidence';

// ─── NET-1: per-tenant allowlists ───────────────────────────────────────

describe('WS9 NET-1: per-tenant outbound allowlist isolation', () => {
  let policyA: OutboundNetworkPolicy;
  let policyB: OutboundNetworkPolicy;

  beforeEach(() => {
    // Tenant A's allowlist — openai + internal tools.
    policyA = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: ['api.openai.com', 'localhost', '127.0.0.1'],
      blocklist: [],
    });
    // Tenant B's allowlist — anthropic only.
    policyB = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: ['api.anthropic.com', 'localhost', '127.0.0.1'],
      blocklist: [],
    });
  });

  afterEach(() => {
    policyA?.uninstall?.();
    policyB?.uninstall?.();
  });

  it('A cannot reach a domain only on B\'s allowlist', () => {
    const artifacts: string[] = [];

    // A's policy blocks anthropic (B-only).
    const aToAnthropic = policyA.check('https://api.anthropic.com/v1/messages');
    expect(aToAnthropic.allowed).toBe(false);

    // B's policy blocks openai (A-only).
    const bToOpenai = policyB.check('https://api.openai.com/v1/chat');
    expect(bToOpenai.allowed).toBe(false);

    // Both still reach their own allowed domains.
    expect(policyA.check('https://api.openai.com/v1/chat').allowed).toBe(true);
    expect(policyB.check('https://api.anthropic.com/v1/messages').allowed).toBe(true);

    try {
      writePass(
        'NET-1',
        `Per-tenant OutboundNetworkPolicy: A→api.anthropic.com denied (${aToAnthropic.reason}); B→api.openai.com denied (${bToOpenai.reason}). Each tenant only reaches its own allowlist.`,
        artifacts,
      );
    } catch (err) {
      writeBreach(
        'NET-1',
        `Cross-tenant allowlist breach: A reached B's domain or vice versa. ${(err as Error).message ?? ''}`,
        artifacts,
      );
      throw err;
    }
  });
});

// ─── NET-2: SSRF to 169.254.169.254 + private network ────────────────────

describe('WS9 NET-2: SSRF to link-local / private network blocked + audited', () => {
  let policy: OutboundNetworkPolicy;

  beforeEach(() => {
    policy = new OutboundNetworkPolicy({
      enabled: true,
      // OpenAI allowlist — but SSRF defense must reject private IPs even
      // when they somehow end up on the allowlist (defense-in-depth).
      allowlist: ['api.openai.com', 'localhost'],
      blocklist: [],
      blockPrivateIPs: true,
      auditLog: true,
    });
  });

  afterEach(() => {
    policy?.uninstall?.();
  });

  it('blocks 169.254.169.254, 10.x, 192.168.x, 172.16-31.x', () => {
    const artifacts: string[] = [];
    const ssrfTargets = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://169.254.169.254/computeMetadata/v1/',
      'http://10.0.0.1/admin',
      'http://192.168.1.1/router',
      'http://172.16.0.1/internal',
      'http://172.31.255.255/internal',
    ];

    const failures: string[] = [];
    for (const url of ssrfTargets) {
      const res = policy.check(url);
      if (res.allowed) {
        failures.push(`${url} was allowed (${res.reason ?? 'no reason'})`);
      }
    }

    try {
      expect(failures).toHaveLength(0);
      // Audit log captures each rejected SSRF attempt via the installed
      // fetch interceptor; here we verify the policy decision path directly.
      // The decision-level rejection is the load-bearing assertion — the
      // audit hook is verified separately in tests/security/outboundNetworkPolicy.test.ts.
      const reasons = ssrfTargets.map((u) => policy.check(u)).map((r) => r.reason ?? '');
      expect(reasons.every((r) => /private IP|not in allowlist/i.test(r))).toBe(true);

      writePass(
        'NET-2',
        `SSRF defense blocked ${ssrfTargets.length} private-network targets (169.254.169.254 metadata, 10/8, 192.168/16, 172.16/12). All decisions recorded 'private IP blocked (SSRF defense)' or 'not in allowlist'.`,
        artifacts,
      );
    } catch (err) {
      writeBreach(
        'NET-2',
        `SSRF breach: ${failures.join('; ')}. ${(err as Error).message ?? ''}`,
        artifacts,
      );
      throw err;
    }
  });
});

// ─── NET-3: host network as fallback rejected ───────────────────────────

describe('WS9 NET-3: host network fallback rejected', () => {
  let policy: OutboundNetworkPolicy;

  beforeEach(() => {
    policy = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: [], // empty — no outbound allowed except through proxy
      blocklist: [],
      blockPrivateIPs: true,
      auditLog: true,
    });
  });

  afterEach(() => {
    policy?.uninstall?.();
  });

  it('rejects host network (127.0.0.1, 0.0.0.0, ::1) and external domains', () => {
    const artifacts: string[] = [];
    const fallbackTargets = [
      'http://127.0.0.1:5432/pg', // host PG as fallback
      'http://0.0.0.0:8080/', // host network binding
      'http://[::1]:6379/redis', // IPv6 loopback
      'https://attacker.com/exfil', // external domain (not allowlisted)
    ];

    const failures: string[] = [];
    for (const url of fallbackTargets) {
      const res = policy.check(url);
      if (res.allowed) {
        failures.push(`${url} was allowed`);
      }
    }

    try {
      expect(failures).toHaveLength(0);
      writePass(
        'NET-3',
        `Host network fallback rejected: empty-allowlist policy denied 127.0.0.1, 0.0.0.0, [::1], and external attacker.com. Default network blocked; external egress requires explicit allowlist entry.`,
        artifacts,
      );
    } catch (err) {
      writeBreach(
        'NET-3',
        `Host network fallback breach: ${failures.join('; ')}. ${(err as Error).message ?? ''}`,
        artifacts,
      );
      throw err;
    }
  });
});
