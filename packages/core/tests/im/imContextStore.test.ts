import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  InMemoryIMContextStore,
  resetIMContextStore,
} from '../../src/im/imContextStore';

describe('InMemoryIMContextStore', () => {
  beforeEach(() => {
    resetIMContextStore();
  });

  it('appends user message and creates context', async () => {
    const s = new InMemoryIMContextStore();
    const ctx = await s.appendUserMessage('slack', 'C1', 'U1', 'hello');
    assert.equal(ctx.messages.length, 1);
    assert.equal(ctx.messages[0].role, 'user');
    assert.equal(ctx.platform, 'slack');
  });

  it('truncates to last 20 messages', async () => {
    const s = new InMemoryIMContextStore();
    for (let i = 0; i < 25; i++) {
      await s.appendUserMessage('slack', 'C1', 'U1', `msg ${i}`);
    }
    const ctx = await s.getContext('slack', 'C1', 'U1');
    assert.equal(ctx?.messages.length, 20);
  });

  it('appends assistant message', async () => {
    const s = new InMemoryIMContextStore();
    await s.appendUserMessage('slack', 'C1', 'U1', 'hello');
    await s.appendAssistantMessage('slack', 'C1', 'U1', 'reply');
    const ctx = await s.getContext('slack', 'C1', 'U1');
    assert.equal(ctx?.messages[1].role, 'assistant');
  });

  it('tracks pending run id', async () => {
    const s = new InMemoryIMContextStore();
    await s.appendUserMessage('slack', 'C1', 'U1', 'hello');
    await s.setPendingRunId('slack', 'C1', 'U1', 'run-1');
    const ctx = await s.getContext('slack', 'C1', 'U1');
    assert.equal(ctx?.pendingRunId, 'run-1');
    await s.clearPendingRunId('slack', 'C1', 'U1');
    assert.equal((await s.getContext('slack', 'C1', 'U1'))?.pendingRunId, undefined);
  });

  it('resets context', async () => {
    const s = new InMemoryIMContextStore();
    await s.appendUserMessage('slack', 'C1', 'U1', 'hello');
    await s.resetContext('slack', 'C1', 'U1');
    assert.equal(await s.getContext('slack', 'C1', 'U1'), undefined);
  });
});
