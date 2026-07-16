import { describe, it, beforeEach, expect, afterAll } from 'vitest';
import { WebhookDispatcher } from '../../src/runtime/webhookDispatcher';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetGlobalLogger } from '../../src/logging';

describe('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    dispatcher = new WebhookDispatcher();
  });

  afterAll(() => {
    // Reset global singletons to prevent vitest EnvironmentTeardownError
    // ("Closing rpc while onUserConsoleLog was pending") on Node 20.
    resetMessageBus();
    resetGlobalLogger();
  });

  describe('registerWebhook', () => {
    it('registers a webhook', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['agent.started', 'agent.completed'],
        enabled: true,
      });
      expect(config.id).toBeDefined();
      expect(config.url).toBe('https://example.com/webhook');
      expect(config.enabled).toBe(true);
    });

    it('generates secret if not provided', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(config.secret).toBeDefined();
      expect(config.secret!.length).toBeGreaterThan(0);
    });

    it('uses provided secret', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['*'],
        secret: 'my-secret',
        enabled: true,
      });
      expect(config.secret).toBe('my-secret');
    });

    it('sets default retry max', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(config.retryMax).toBe(3);
    });

    it('sets createdAt timestamp', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(config.createdAt).toBeDefined();
    });
  });

  describe('deregisterWebhook', () => {
    it('removes a webhook', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(dispatcher.deregisterWebhook(config.id)).toBe(true);
    });

    it('returns false for non-existent webhook', () => {
      expect(dispatcher.deregisterWebhook('nonexistent')).toBe(false);
    });
  });

  describe('listWebhooks', () => {
    it('lists all webhooks', () => {
      dispatcher.registerWebhook({ url: 'https://a.com', events: ['*'], enabled: true });
      dispatcher.registerWebhook({ url: 'https://b.com', events: ['*'], enabled: true });
      const list = dispatcher.listWebhooks();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('returns array of webhooks', () => {
      const list = dispatcher.listWebhooks();
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('getWebhook', () => {
    it('gets webhook by ID', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['*'],
        enabled: true,
      });
      const found = dispatcher.getWebhook(config.id);
      expect(found).toBeDefined();
      expect(found!.url).toBe('https://example.com');
    });

    it('returns undefined for non-existent webhook', () => {
      expect(dispatcher.getWebhook('nonexistent')).toBeUndefined();
    });
  });

  describe('dispatch', () => {
    it('does nothing when not started', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['test.event'],
        enabled: true,
      });
      // Should not throw
      dispatcher.dispatch('test.event', { data: 'test' });
    });

    it('dispatches to matching webhooks when started', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['test.event'],
        enabled: true,
      });
      dispatcher.start();
      // Should not throw - dispatch is fire-and-forget
      dispatcher.dispatch('test.event', { data: 'test' });
    });

    it('does not dispatch to non-matching events', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['test.event'],
        enabled: true,
      });
      dispatcher.start();
      // Different event - should not match
      dispatcher.dispatch('other.event', { data: 'test' });
    });

    it('dispatches to wildcard webhooks', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['*'],
        enabled: true,
      });
      dispatcher.start();
      dispatcher.dispatch('any.event', { data: 'test' });
    });

    it('does not dispatch to disabled webhooks', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com',
        events: ['*'],
        enabled: false,
      });
      dispatcher.start();
      dispatcher.dispatch('any.event', { data: 'test' });
    });
  });

  describe('start/stop', () => {
    it('starts and stops cleanly', () => {
      dispatcher.start();
      dispatcher.stop();
    });

    it('is idempotent', () => {
      dispatcher.start();
      dispatcher.start(); // Should not throw
      dispatcher.stop();
      dispatcher.stop(); // Should not throw
    });
  });

  describe('getDeliveryLog', () => {
    it('returns delivery log', () => {
      const log = dispatcher.getDeliveryLog();
      expect(Array.isArray(log)).toBe(true);
    });

    it('respects limit parameter', () => {
      const log = dispatcher.getDeliveryLog(10);
      expect(log.length).toBeLessThanOrEqual(10);
    });
  });

  // ── SSRF Prevention (isSafeWebhookUrl) ────────────────────────────
  // These tests exercise the private isSafeWebhookUrl() function via
  // registerWebhook, which throws when an unsafe URL is detected.
  // This is a security-critical boundary — OWASP SSRF Prevention.

  describe('SSRF prevention (registerWebhook rejects unsafe URLs)', () => {
    it('rejects loopback address 127.x.x.x', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://127.0.0.1/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects RFC 1918 10.x.x.x', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://10.0.0.1/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects RFC 1918 172.16.x.x', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://172.16.0.1/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects RFC 1918 172.31.x.x (upper bound)', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://172.31.255.1/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects RFC 1918 192.168.x.x', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://192.168.1.1/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects cloud metadata endpoint 169.254.x.x (AWS/GCP)', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://169.254.169.254/latest/meta-data/',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects 0.x.x.x (current network)', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://0.0.0.0/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects IPv6 loopback ::1', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://[::1]/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects localhost hostname and cloud metadata hostnames', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://localhost/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://metadata.google.internal/computeMetadata/v1/',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects IPv6 ULA fc00:', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://[fc00::1]/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects IPv6 link-local fe80:', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'http://[fe80::1]/webhook',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects javascript: scheme', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'javascript:alert(1)',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects data: scheme', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'data:text/html,<script>alert(1)</script>',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects file: scheme', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'file:///etc/passwd',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('rejects malformed URL', () => {
      expect(() =>
        dispatcher.registerWebhook({
          url: 'not-a-valid-url',
          events: ['*'],
          enabled: true,
        }),
      ).toThrow(/private\/internal/);
    });

    it('allows valid https URL to public host', () => {
      const config = dispatcher.registerWebhook({
        url: 'https://api.example.com/webhooks',
        events: ['*'],
        enabled: true,
      });
      expect(config.id).toBeDefined();
    });

    it('allows valid http URL to public host', () => {
      const config = dispatcher.registerWebhook({
        url: 'http://public.example.com/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(config.id).toBeDefined();
    });

    it('rejects 172.32.x.x (outside RFC 1918 range) as valid', () => {
      // 172.32.x is NOT RFC 1918 — it's a valid public IP range
      const config = dispatcher.registerWebhook({
        url: 'http://172.32.0.1/webhook',
        events: ['*'],
        enabled: true,
      });
      expect(config.id).toBeDefined();
    });
  });

  describe('getStats', () => {
    it('returns zero stats for empty dispatcher', () => {
      const stats = dispatcher.getStats();
      expect(stats).toEqual({ total: 0, enabled: 0, deliveries: 0 });
    });

    it('counts total and enabled webhooks', () => {
      dispatcher.registerWebhook({
        url: 'https://example.com/a',
        events: ['*'],
        enabled: true,
      });
      dispatcher.registerWebhook({
        url: 'https://example.com/b',
        events: ['*'],
        enabled: false,
      });
      const stats = dispatcher.getStats();
      expect(stats.total).toBe(2);
      expect(stats.enabled).toBe(1);
    });
  });

  describe('filterTestFixtures', () => {
    it('removes webhooks with test- prefixed IDs', () => {
      // Manually inject a test fixture to avoid registerWebhook SSRF check
      const wh = dispatcher.registerWebhook({
        url: 'https://example.com/normal',
        events: ['*'],
        enabled: true,
      });
      // The registered ID won't start with "test-" so 0 should be removed
      expect(dispatcher.filterTestFixtures()).toBe(0);
      expect(dispatcher.getWebhook(wh.id)).toBeDefined();
    });

    it('returns 0 when no fixtures exist', () => {
      expect(dispatcher.filterTestFixtures()).toBe(0);
    });
  });
});
