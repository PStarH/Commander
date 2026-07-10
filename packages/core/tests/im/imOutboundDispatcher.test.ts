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
});
