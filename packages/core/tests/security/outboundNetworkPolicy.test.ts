import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
  getOutboundNetworkPolicy,
  pinnedHttpFetch,
} from '../../src/security/outboundNetworkPolicy';
import * as http from 'node:http';
import * as dns from 'node:dns';
import type { AddressInfo } from 'node:net';
import { WebhookDispatcher, resetWebhookDispatcher } from '../../src/runtime/webhookDispatcher';
import { safeFetch, SafeFetchError } from '../../src/tools/_utils/httpClient';

describe('OutboundNetworkPolicy', () => {
  let policy: OutboundNetworkPolicy;

  beforeEach(() => {
    resetOutboundNetworkPolicy();
    policy = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: ['api.openai.com', 'api.anthropic.com'],
      blocklist: ['evil.com'],
    });
  });

  afterEach(() => {
    policy.uninstall();
    resetOutboundNetworkPolicy();
  });

  describe('check', () => {
    it('allows URLs in the allowlist', () => {
      expect(policy.check('https://api.openai.com/v1/chat').allowed).toBe(true);
      expect(policy.check('https://api.anthropic.com/v1/messages').allowed).toBe(true);
    });

    it('denies localhost and loopback even if allowlisted', () => {
      const p = new OutboundNetworkPolicy({
        enabled: true,
        allowlist: ['localhost', '127.0.0.1', 'api.openai.com'],
        blocklist: [],
        blockPrivateIPs: true,
      });
      expect(p.check('http://localhost:3000/api').allowed).toBe(false);
      expect(p.check('http://127.0.0.1:3000/api').allowed).toBe(false);
      expect(p.check('http://[::1]/api').allowed).toBe(false);
      expect(p.check('http://[fd00::1]/').allowed).toBe(false);
      expect(p.check('http://metadata.google.internal/').allowed).toBe(false);
    });

    it('default allowlist does not include loopback', () => {
      const p = new OutboundNetworkPolicy({ enabled: true });
      const cfg = p.getConfig();
      expect(cfg.allowlist).not.toContain('localhost');
      expect(cfg.allowlist).not.toContain('127.0.0.1');
      expect(cfg.allowlist).toContain('api.openai.com');
      expect(cfg.allowlist).toContain('apihub.agnes-ai.com');
    });

    it('allows subdomains of allowlisted domains', () => {
      const p = new OutboundNetworkPolicy({
        enabled: true,
        allowlist: ['example.com'],
        blocklist: [],
      });
      expect(p.check('https://api.example.com/path').allowed).toBe(true);
      expect(p.check('https://sub.api.example.com/path').allowed).toBe(true);
    });

    it('blocks URLs not in the allowlist', () => {
      const result = policy.check('https://evil.attacker.com/exfil');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });

    it('blocks URLs in the blocklist (even if allowlisted)', () => {
      const p = new OutboundNetworkPolicy({
        enabled: true,
        allowlist: ['evil.com'],
        blocklist: ['evil.com'],
      });
      const result = p.check('https://evil.com/steal');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocklist');
    });

    it('blocks private IPs for SSRF defense', () => {
      const p = new OutboundNetworkPolicy({
        enabled: true,
        allowlist: ['api.openai.com'],
        blocklist: [],
        blockPrivateIPs: true,
      });
      expect(p.check('http://10.0.0.1/internal').allowed).toBe(false);
      expect(p.check('http://192.168.1.1/admin').allowed).toBe(false);
      expect(p.check('http://172.16.0.1/admin').allowed).toBe(false);
      expect(p.check('http://169.254.169.254/latest/meta-data').allowed).toBe(false);
      expect(p.check('http://100.64.0.1/internal').allowed).toBe(false);
      expect(p.check('http://[fe90::1]/internal').allowed).toBe(false);
      expect(p.check('http://[::]/internal').allowed).toBe(false);
      expect(p.check('http://[ff02::1]/internal').allowed).toBe(false);
      expect(p.check('http://[2001:db8::1]/internal').allowed).toBe(false);
      expect(p.check('http://224.0.0.1/internal').allowed).toBe(false);
    });

    it('blocks private IPs even when explicitly in allowlist', () => {
      const p = new OutboundNetworkPolicy({
        enabled: true,
        allowlist: ['127.0.0.1', 'localhost', '10.0.0.1'],
        blocklist: [],
        blockPrivateIPs: true,
      });
      expect(p.check('http://127.0.0.1:3000/api').allowed).toBe(false);
      expect(p.check('http://localhost:3000/api').allowed).toBe(false);
      expect(p.check('http://10.0.0.1/internal').allowed).toBe(false);
    });

    it('checkAsync allows public allowlisted host (DNS mock)', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '104.18.0.1', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['api.openai.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        const result = await p.checkAsync('https://api.openai.com/v1/chat');
        expect(result.allowed).toBe(true);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkAsync denies when DNS resolves to private IP', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '127.0.0.1', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['evil.example.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        const result = await p.checkAsync('https://evil.example.com/x');
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/private IP|DNS/);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkTargetAsync denies compressed, expanded, and dotted IPv4-mapped private DNS answers', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      const answers = ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1'];
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['rebind.example.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        for (const address of answers) {
          dns.promises.lookup = (async () => [
            { address, family: 6 },
          ]) as typeof dns.promises.lookup;
          const result = await p.checkTargetAsync('https://rebind.example.com/x');
          expect(result.allowed, address).toBe(false);
        }
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkTargetAsync denies non-global IPv6 DNS answers', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      const answers = ['::', 'ff02::1', '100::1', '64:ff9b:1::1', '2001:db8::1', '3fff::1'];
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, blockPrivateIPs: true });
        for (const address of answers) {
          dns.promises.lookup = (async () => [
            { address, family: 6 },
          ]) as typeof dns.promises.lookup;
          const result = await p.checkTargetAsync('https://dns-rebind.example.com/x');
          expect(result.allowed, address).toBe(false);
        }
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkTargetAsync preserves a globally routable IPv6 DNS answer for an authorized target', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '2001:4860:4860::8888', family: 6 },
      ]) as typeof dns.promises.lookup;
      try {
        // The host is deliberately NOT on the allowlist: this exercises the
        // registered per-target authorization path end to end.
        const p = new OutboundNetworkPolicy({ enabled: true, blockPrivateIPs: true });
        p.authorizeTarget('https://public-v6.example.com', { tenantId: 'tenant-a' });
        const result = await p.checkTargetAsync('https://public-v6.example.com/x', {
          tenantId: 'tenant-a',
        });
        expect(result.allowed).toBe(true);
        expect(result.addresses).toEqual(['2001:4860:4860::8888']);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('ssrfCheckedFetch rejects a private DNS answer before connecting', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '127.0.0.1', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, blockPrivateIPs: true });
        await expect(p.ssrfCheckedFetch('https://rebind.example.com/secret')).rejects.toThrow(
          /OUTBOUND_BLOCKED.*private IP/,
        );
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkAsync returns public addresses for pinning', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '104.18.0.1', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['api.openai.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        const result = await p.checkAsync('https://api.openai.com/v1/chat');
        expect(result.allowed).toBe(true);
        expect(result.addresses).toEqual(['104.18.0.1']);
      } finally {
        dns.promises.lookup = original;
      }
    });

    // ── SEC2-03 ────────────────────────────────────────────────────────────
    // This test used to assert `allowed: true` for a NON-allowlisted public
    // host, i.e. it encoded the SSRF-bypass / fail-open behaviour as correct.
    // "Is this destination unsafe?" and "is this destination authorized?" are
    // different questions; a passing SSRF check is not an allowlist pass.
    it('denies a public host that is neither allowlisted nor authorized', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['api.openai.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        const result = await p.checkTargetAsync('https://example.com/hook');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not in allowlist');
        await expect(p.ssrfCheckedFetch('https://example.com/hook')).rejects.toThrow(
          /OUTBOUND_BLOCKED.*not in allowlist/,
        );
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('allows a non-allowlisted public host only via a registered tenant-bound authorization', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({
          enabled: true,
          allowlist: ['api.openai.com'],
          blocklist: [],
          blockPrivateIPs: true,
        });
        // Not registered yet → denied.
        expect((await p.checkTargetAsync('https://example.com/hook')).allowed).toBe(false);

        p.authorizeTarget('https://example.com/hook', { tenantId: 'tenant-a' });

        // Registered for tenant-a → allowed, with the resolved address pinned.
        const allowed = await p.checkTargetAsync('https://example.com/hook', {
          tenantId: 'tenant-a',
        });
        expect(allowed.allowed).toBe(true);
        expect(allowed.addresses).toEqual(['93.184.216.34']);

        // A different tenant must not inherit tenant-a's authorization.
        const otherTenant = await p.checkTargetAsync('https://example.com/hook', {
          tenantId: 'tenant-b',
        });
        expect(otherTenant.allowed).toBe(false);
        expect((await p.checkTargetAsync('https://example.com/hook')).allowed).toBe(false);

        // A different path on the same origin is covered; a different origin is not.
        expect(
          (await p.checkTargetAsync('https://example.com/other', { tenantId: 'tenant-a' })).allowed,
        ).toBe(true);
        expect(
          (await p.checkTargetAsync('https://other.example.com/hook', { tenantId: 'tenant-a' }))
            .allowed,
        ).toBe(false);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('keeps authorizations for the same origin isolated per tenant', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [] });
        p.authorizeTarget('https://shared.example.com/hook-a', { tenantId: 'tenant-a' });
        p.authorizeTarget('https://shared.example.com/hook-b', { tenantId: 'tenant-b' });
        expect(
          (await p.checkTargetAsync('https://shared.example.com/a', { tenantId: 'tenant-a' }))
            .allowed,
        ).toBe(true);
        expect(
          (await p.checkTargetAsync('https://shared.example.com/b', { tenantId: 'tenant-b' }))
            .allowed,
        ).toBe(true);
        expect(
          (await p.checkTargetAsync('https://shared.example.com/c', { tenantId: 'tenant-c' }))
            .allowed,
        ).toBe(false);
        expect(p.revokeTarget('https://shared.example.com/a', 'tenant-a')).toBe(true);
        expect(
          (await p.checkTargetAsync('https://shared.example.com/a', { tenantId: 'tenant-a' }))
            .allowed,
        ).toBe(false);
        expect(
          (await p.checkTargetAsync('https://shared.example.com/b', { tenantId: 'tenant-b' }))
            .allowed,
        ).toBe(true);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('honors explicit disabled passthrough consistently for direct checks and fetches', async () => {
      const p = new OutboundNetworkPolicy({ enabled: false, allowlist: [] });
      const result = await p.checkTargetAsync('https://not-allowlisted.example.com/path');
      expect(result.allowed).toBe(true);
      expect(p.check('https://not-allowlisted.example.com/path').allowed).toBe(true);
      expect((await p.checkAsync('https://not-allowlisted.example.com/path')).allowed).toBe(true);
      const originalFetch = globalThis.fetch;
      const upstream = vi.fn(async () => new Response('ok'));
      globalThis.fetch = upstream as typeof globalThis.fetch;
      try {
        await expect(
          p.ssrfCheckedFetch('https://not-allowlisted.example.com/path'),
        ).resolves.toBeInstanceOf(Response);
        expect(upstream).toHaveBeenCalledOnce();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('keeps the synchronous private-address defense when the allowlist is disabled', async () => {
      // `enabled: false` is passthrough for the ALLOWLIST only. Metadata and
      // literal private/loopback destinations stay refused, on every check path
      // (WS9 NET-3: "even with egress disabled, private IPs are blocked").
      // DNS is deliberately not consulted in this mode, so a public host is
      // allowed without a resolver round-trip — hence these are literal forms.
      const p = new OutboundNetworkPolicy({ enabled: false, allowlist: [] });
      for (const url of [
        'http://127.0.0.1/internal',
        'http://10.0.0.1/internal',
        'http://192.168.1.1/internal',
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'http://[::1]/internal',
        'http://metadata.google.internal/computeMetadata/v1/',
      ]) {
        expect(p.check(url).allowed, `check(${url})`).toBe(false);
        expect((await p.checkAsync(url)).allowed, `checkAsync(${url})`).toBe(false);
        expect((await p.checkTargetAsync(url)).allowed, `checkTargetAsync(${url})`).toBe(false);
        await expect(p.ssrfCheckedFetch(url), `ssrfCheckedFetch(${url})`).rejects.toThrow(
          /OUTBOUND_BLOCKED/,
        );
      }
    });

    it('denies an authorized target whose authorization has expired', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [] });
        p.authorizeTarget('https://hooks.example.com', {
          tenantId: 'tenant-a',
          expiresAt: Date.now() - 1,
        });
        expect(p.isTargetAuthorized('https://hooks.example.com', 'tenant-a')).toBe(false);
        const result = await p.checkTargetAsync('https://hooks.example.com/x', {
          tenantId: 'tenant-a',
        });
        expect(result.allowed).toBe(false);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('applies the SSRF check even to an authorized target', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '127.0.0.1', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [] });
        p.authorizeTarget('https://hooks.example.com', { tenantId: 'tenant-a' });
        await expect(
          p.ssrfCheckedFetch('https://hooks.example.com/x', undefined, { tenantId: 'tenant-a' }),
        ).rejects.toThrow(/OUTBOUND_BLOCKED.*private IP/);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('revokeTarget withdraws a previously registered authorization', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [] });
        p.authorizeTarget('https://hooks.example.com/a', { tenantId: 'tenant-a' });
        expect(p.revokeTarget('https://hooks.example.com/a', 'tenant-b')).toBe(false);
        expect(p.isTargetAuthorized('https://hooks.example.com/a', 'tenant-a')).toBe(true);
        expect(p.revokeTarget('https://hooks.example.com/a', 'tenant-a')).toBe(true);
        expect(p.isTargetAuthorized('https://hooks.example.com/a', 'tenant-a')).toBe(false);
        expect(
          (await p.checkTargetAsync('https://hooks.example.com/a', { tenantId: 'tenant-a' }))
            .allowed,
        ).toBe(false);
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('authorizeTarget rejects non-http(s) origins and an empty tenant', () => {
      const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [] });
      expect(() => p.authorizeTarget('file:///etc/passwd', { tenantId: 'tenant-a' })).toThrow(
        /http\(s\)/,
      );
      expect(() => p.authorizeTarget('not-a-url', { tenantId: 'tenant-a' })).toThrow(/http\(s\)/);
      expect(() => p.authorizeTarget('https://ok.example.com', { tenantId: '   ' })).toThrow(
        /tenantId/,
      );
      expect(() =>
        p.authorizeTarget('https://ok.example.com', { tenantId: 'tenant-a', expiresAt: NaN }),
      ).toThrow(/expiresAt/);
      expect(p.isTargetAuthorized('https://ok.example.com', 'tenant-a')).toBe(false);
    });

    // An explicitly empty allowlist is a policy decision: it means "no
    // destination is allowed" (deny all), NOT "unrestricted". Reading it as
    // unrestricted would turn an explicit empty config into a fail-open state.
    it('treats an explicitly empty allowlist as deny-all', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '93.184.216.34', family: 4 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, allowlist: [], blocklist: [] });
        expect(p.getConfig().allowlist).toEqual([]);
        expect(p.check('https://example.com/hook').allowed).toBe(false);
        const result = await p.checkTargetAsync('https://example.com/hook');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not in allowlist');
        await expect(p.ssrfCheckedFetch('https://example.com/hook')).rejects.toThrow(
          /OUTBOUND_BLOCKED/,
        );
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('handles malformed URLs', () => {
      const result = policy.check('not-a-url');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('malformed URL');
    });
  });

  describe('install / uninstall', () => {
    it('patches globalThis.fetch when installed', () => {
      const original = globalThis.fetch;
      policy.install();
      expect(globalThis.fetch).not.toBe(original);
      expect((globalThis.fetch as unknown as { __outboundPolicy?: boolean }).__outboundPolicy).toBe(
        true,
      );
    });

    it('restores original fetch when uninstalled', () => {
      const original = globalThis.fetch;
      policy.install();
      expect(globalThis.fetch).not.toBe(original);
      policy.uninstall();
      expect(globalThis.fetch).toBe(original);
    });

    it('blocks fetch to non-allowlisted domains', async () => {
      policy.install();
      await expect(fetch('https://evil.attacker.com/exfil')).rejects.toThrow('OUTBOUND_BLOCKED');
    });

    it('allows fetch to allowlisted domains', async () => {
      const url = 'https://api.openai.com/v1/models';
      const originalFetch = globalThis.fetch;
      const upstreamResponse = new Response('{}', { status: 200 });
      const upstreamFetch = vi.fn(async () => upstreamResponse);
      globalThis.fetch = upstreamFetch as typeof globalThis.fetch;

      try {
        expect(policy.check(url).allowed).toBe(true);
        // DNS/private-address enforcement and pinning have dedicated tests above.
        // This case isolates the install wrapper and allowed-request forwarding.
        const checkAsync = vi
          .spyOn(policy, 'checkAsync')
          .mockResolvedValue({ allowed: true, domain: 'api.openai.com' });
        policy.install();

        await expect(fetch(url)).resolves.toBe(upstreamResponse);
        expect(checkAsync).toHaveBeenCalledWith(url);
        expect(upstreamFetch).toHaveBeenCalledOnce();
      } finally {
        policy.uninstall();
        globalThis.fetch = originalFetch;
      }
    });

    it('does not install when disabled', () => {
      const p = new OutboundNetworkPolicy({ enabled: false });
      const original = globalThis.fetch;
      p.install();
      expect(globalThis.fetch).toBe(original);
      p.uninstall();
    });
  });

  describe('audit logs', () => {
    it('records blocked requests in audit log', async () => {
      policy.install();
      try {
        // Trigger a blocked request (patched fetch is async via checkAsync)
        await fetch('https://evil.attacker.com/exfil').catch(() => {});
      } catch {
        // ignore
      }
      const logs = policy.getAuditLogs();
      const blockedLog = logs.find((l) => !l.allowed);
      expect(blockedLog).toBeDefined();
      expect(blockedLog?.domain).toBe('evil.attacker.com');
    });
  });

  describe('runtime configuration', () => {
    it('allowDomain adds to allowlist', () => {
      policy.allowDomain('api.newservice.com');
      expect(policy.check('https://api.newservice.com/v1').allowed).toBe(true);
    });

    it('blockDomain adds to blocklist', () => {
      policy.blockDomain('api.openai.com');
      expect(policy.check('https://api.openai.com/v1').allowed).toBe(false);
    });

    it('updateConfig merges changes', () => {
      policy.updateConfig({ blockPrivateIPs: false });
      const config = policy.getConfig();
      expect(config.blockPrivateIPs).toBe(false);
    });
  });

  describe('singleton', () => {
    it('getOutboundNetworkPolicy returns same instance', () => {
      const p1 = getOutboundNetworkPolicy({ enabled: true });
      const p2 = getOutboundNetworkPolicy();
      expect(p1).toBe(p2);
    });

    it('resetOutboundNetworkPolicy clears singleton', () => {
      const p1 = getOutboundNetworkPolicy({ enabled: true });
      resetOutboundNetworkPolicy();
      const p2 = getOutboundNetworkPolicy({ enabled: false });
      expect(p1).not.toBe(p2);
    });
  });
  // ── pinnedHttpFetch: body-forbidden statuses (SF-01) ──────────────────
  //
  // `new Response(body, { status })` throws for 204/205/304 because those
  // statuses forbid a body. Constructing it inside the socket `end` callback
  // put the throw outside the promise executor and outside any caller's
  // await/catch, so an ordinary empty response (a 204 webhook acknowledgement)
  // became an uncaught exception instead of a resolved request.
  describe('pinnedHttpFetch body-forbidden statuses', () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
    });

    function startServer(status: number, body = ''): Promise<number> {
      return new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end(body);
        });
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    }

    for (const status of [204, 205, 304]) {
      it(`resolves a ${status} response instead of throwing out of the end callback`, async () => {
        const port = await startServer(status);
        const response = await pinnedHttpFetch(`http://127.0.0.1:${port}/webhook`, '127.0.0.1');
        expect(response.status).toBe(status);
        expect(await response.text()).toBe('');
      });
    }

    it('still resolves a 200 response with its body intact', async () => {
      const port = await startServer(200, 'ok-payload');
      const response = await pinnedHttpFetch(`http://127.0.0.1:${port}/hook`, '127.0.0.1');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok-payload');
    });

    it('resolves a HEAD response with an empty body', async () => {
      const port = await startServer(200, 'ignored');
      const response = await pinnedHttpFetch(`http://127.0.0.1:${port}/hook`, '127.0.0.1', {
        method: 'HEAD',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    });
  });
});

// ── LM-17: outbound egress is authorized per target ─────────────────────────
//
// Passing the SSRF check is NOT the same as being on an allowlist. These tests
// pin the consumer-facing behaviour: an ordinary tool fetch must obey the
// allowlist, and the only way to reach a non-allowlisted public destination is
// a server-side, tenant-bound target authorization (which is how customer
// webhooks are delivered).
describe('outbound consumer authorization (LM-17)', () => {
  const originalLookup = dns.promises.lookup;
  const publicLookup = (address: string) =>
    (async () => [{ address, family: 4 }]) as unknown as typeof dns.promises.lookup;

  afterEach(() => {
    dns.promises.lookup = originalLookup;
    resetOutboundNetworkPolicy();
    resetWebhookDispatcher();
  });

  it('safeFetch denies a public host that is neither allowlisted nor authorized', async () => {
    dns.promises.lookup = publicLookup('93.184.216.34');
    const policy = getOutboundNetworkPolicy({ enabled: true, allowlist: [], blocklist: [] });
    // Sanity: the host is public, so the denial is authorization, not SSRF.
    expect((await policy.checkTargetAsync('https://public.example.test/x')).reason).toContain(
      'not in allowlist',
    );

    await expect(safeFetch('https://public.example.test/x')).rejects.toMatchObject({
      name: 'SafeFetchError',
      code: 'unsafe_url',
    });
    await expect(safeFetch('https://public.example.test/x')).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('safeFetch allows a host once it is on the allowlist', async () => {
    dns.promises.lookup = publicLookup('93.184.216.34');
    const policy = getOutboundNetworkPolicy({
      enabled: true,
      allowlist: ['public.example.test'],
      blocklist: [],
    });
    expect((await policy.checkTargetAsync('https://public.example.test/x')).allowed).toBe(true);
    // An unrelated host is still denied through the same decision path.
    expect((await policy.checkTargetAsync('https://other.example.test/x')).allowed).toBe(false);
  });

  it('authorizes a webhook target only for the owning tenant, and withdraws it on deregistration', async () => {
    dns.promises.lookup = publicLookup('93.184.216.34');
    const policy = getOutboundNetworkPolicy({ enabled: true, allowlist: [], blocklist: [] });
    const dispatcher = new WebhookDispatcher('acme');

    // Before registration nothing may reach the customer destination.
    expect(policy.isTargetAuthorized('https://hooks.customer.test', 'acme')).toBe(false);
    expect(
      (await policy.checkTargetAsync('https://hooks.customer.test/wh', { tenantId: 'acme' }))
        .allowed,
    ).toBe(false);

    const webhook = dispatcher.registerWebhook({
      url: 'https://hooks.customer.test/wh',
      events: ['*'],
      enabled: true,
    });

    // Registration is the server-side authorization; the origin is now granted
    // to this tenant only, and for the whole origin rather than one path.
    expect(policy.isTargetAuthorized('https://hooks.customer.test', 'acme')).toBe(true);
    expect(
      (await policy.checkTargetAsync('https://hooks.customer.test/wh', { tenantId: 'acme' }))
        .allowed,
    ).toBe(true);
    expect(
      (await policy.checkTargetAsync('https://hooks.customer.test/other', { tenantId: 'acme' }))
        .allowed,
    ).toBe(true);

    // Tenant B cannot reuse tenant A's destination.
    expect(
      (await policy.checkTargetAsync('https://hooks.customer.test/wh', { tenantId: 'other' }))
        .allowed,
    ).toBe(false);
    // Nor can the same tenant reach a destination it never registered.
    expect(
      (await policy.checkTargetAsync('https://attacker.test/exfil', { tenantId: 'acme' })).allowed,
    ).toBe(false);

    // The authorization is tied to the registry entry, not granted forever.
    expect(dispatcher.deregisterWebhook(webhook.id)).toBe(true);
    expect(policy.isTargetAuthorized('https://hooks.customer.test', 'acme')).toBe(false);
    expect(
      (await policy.checkTargetAsync('https://hooks.customer.test/wh', { tenantId: 'acme' }))
        .allowed,
    ).toBe(false);
  });
});
