import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  IMProviderRegistry,
  resetIMProviderRegistry,
} from '../../src/im/imProviderRegistry';
import type { IMProvider } from '../../src/im';

const fakeProvider: IMProvider = {
  id: 'fake',
  name: 'Fake',
  verify: () => true,
  parseMessage: () => ({ text: 'hi', senderId: 'u1', conversationId: 'c1' }),
  formatReply: (reply) => ({ body: reply.text }),
  stripMention: (t) => t,
};

describe('IMProviderRegistry', () => {
  beforeEach(() => {
    resetIMProviderRegistry();
  });

  it('registers and resolves a provider', () => {
    const registry = new IMProviderRegistry();
    registry.register(fakeProvider);
    assert.equal(registry.resolve('fake')?.id, 'fake');
  });

  it('throws on duplicate registration', () => {
    const registry = new IMProviderRegistry();
    registry.register(fakeProvider);
    assert.throws(() => registry.register(fakeProvider), /already registered/);
  });

  it('unregisters a provider', () => {
    const registry = new IMProviderRegistry();
    registry.register(fakeProvider);
    assert.equal(registry.unregister('fake'), true);
    assert.equal(registry.resolve('fake'), undefined);
  });

  it('lists providers', () => {
    const registry = new IMProviderRegistry();
    registry.register(fakeProvider);
    assert.equal(registry.list().length, 1);
  });

  it('reset clears singleton', () => {
    const r1 = resetIMProviderRegistry();
    r1.register(fakeProvider);
    const r2 = resetIMProviderRegistry();
    assert.equal(r2.resolve('fake'), undefined);
  });
});
