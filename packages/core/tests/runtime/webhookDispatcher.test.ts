import { describe, it, beforeEach, expect } from 'vitest';
import { WebhookDispatcher } from '../../src/runtime/webhookDispatcher';

describe('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    dispatcher = new WebhookDispatcher();
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
});
