import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  DefaultIMOutboundDispatcher,
  resetIMOutboundDispatcher,
} from '../../src/im/imOutboundDispatcher';
import { resetIMProviderRegistry } from '../../src/im/imProviderRegistry';
import type { IMProvider, IMReply } from '../../src/im';
import type { IMWebhookConfig } from '../../src/im/imOutboundDispatcher';

const fakeProvider: IMProvider = {
  id: 'fake',
  name: 'Fake',
  verify: () => true,
  parseMessage: () => ({ text: 'hi', senderId: 'u1', conversationId: 'c1' }),
  formatReply: (reply) => ({ body: reply.text }),
  stripMention: (t) => t,
  sendMessage: async () => {},
};

describe('DefaultIMOutboundDispatcher', () => {
  beforeEach(() => {
    resetIMProviderRegistry();
  });

  it('sends via provider sendMessage', async () => {
    let called = false;
    const provider: IMProvider = {
      ...fakeProvider,
      sendMessage: async (conversationId, reply) => {
        called = true;
        assert.equal(conversationId, 'c1');
        assert.equal(reply.text, 'hello');
      },
    };
    const registry = resetIMProviderRegistry();
    registry.register(provider);

    const cfg: IMWebhookConfig = {
      id: 'id-1',
      platform: 'fake',
      name: 'test',
      secret: 's',
      agentId: 'a',
      enabled: true,
      createdAt: new Date().toISOString(),
      outbound: { token: 't' },
    };

    const dispatcher = resetIMOutboundDispatcher({ findById: () => cfg });
    await dispatcher.send('id-1', { text: 'hello', conversationId: 'c1' });
    assert.equal(called, true);
  });

  it('skips when config disabled', async () => {
    const registry = resetIMProviderRegistry();
    registry.register(fakeProvider);
    const cfg: IMWebhookConfig = {
      id: 'id-1',
      platform: 'fake',
      name: 'test',
      secret: 's',
      agentId: 'a',
      enabled: false,
      createdAt: new Date().toISOString(),
    };
    const dispatcher = resetIMOutboundDispatcher({ findById: () => cfg });
    await dispatcher.send('id-1', { text: 'hello' });
  });

  it('skips when provider has no sendMessage', async () => {
    const provider: IMProvider = {
      ...fakeProvider,
      sendMessage: undefined,
    };
    const registry = resetIMProviderRegistry();
    registry.register(provider);
    const cfg: IMWebhookConfig = {
      id: 'id-1',
      platform: 'fake',
      name: 'test',
      secret: 's',
      agentId: 'a',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const dispatcher = resetIMOutboundDispatcher({ findById: () => cfg });
    await dispatcher.send('id-1', { text: 'hello' });
  });

  it('catches sendMessage errors without propagating', async () => {
    const provider: IMProvider = {
      ...fakeProvider,
      sendMessage: async () => {
        throw new Error('Network failure');
      },
    };
    const registry = resetIMProviderRegistry();
    registry.register(provider);
    const cfg: IMWebhookConfig = {
      id: 'id-1',
      platform: 'fake',
      name: 'test',
      secret: 's',
      agentId: 'a',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const dispatcher = resetIMOutboundDispatcher({ findById: () => cfg });
    // Should not throw — error is caught and logged internally
    await dispatcher.send('id-1', { text: 'hello', conversationId: 'c1' });
  });

  it('skips when config is not found by source', async () => {
    const registry = resetIMProviderRegistry();
    registry.register(fakeProvider);
    const dispatcher = resetIMOutboundDispatcher({ findById: () => undefined });
    // Should not throw — silently skips
    await dispatcher.send('id-missing', { text: 'hello' });
  });

  it('falls back to config id when reply has no conversationId', async () => {
    let capturedConvId = '';
    const provider: IMProvider = {
      ...fakeProvider,
      sendMessage: async (conversationId) => {
        capturedConvId = conversationId;
      },
    };
    const registry = resetIMProviderRegistry();
    registry.register(provider);
    const cfg: IMWebhookConfig = {
      id: 'cfg-fallback-id',
      platform: 'fake',
      name: 'test',
      secret: 's',
      agentId: 'a',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    const dispatcher = resetIMOutboundDispatcher({ findById: () => cfg });
    // Reply without conversationId — should use cfg.id as fallback
    await dispatcher.send('cfg-fallback-id', { text: 'hello' });
    assert.equal(capturedConvId, 'cfg-fallback-id');
  });
});
