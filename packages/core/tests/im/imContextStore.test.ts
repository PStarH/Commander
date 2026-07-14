import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { InMemoryIMContextStore, resetIMContextStore } from '../../src/im/imContextStore';

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

  it('appendAssistantMessage silently skips non-existent context', async () => {
    const s = new InMemoryIMContextStore();
    // Should not throw — silently ignores missing context
    await s.appendAssistantMessage('slack', 'C1', 'U1', 'orphan reply');
    const ctx = await s.getContext('slack', 'C1', 'U1');
    assert.equal(ctx, undefined);
  });

  it('setPendingRunId silently skips non-existent context', async () => {
    const s = new InMemoryIMContextStore();
    await s.setPendingRunId('slack', 'C1', 'U1', 'run-ghost');
    // No context was created — the call is a no-op
    assert.equal(await s.getContext('slack', 'C1', 'U1'), undefined);
  });

  it('clearPendingRunId silently skips non-existent context', async () => {
    const s = new InMemoryIMContextStore();
    await s.clearPendingRunId('slack', 'C1', 'U1');
    assert.equal(await s.getContext('slack', 'C1', 'U1'), undefined);
  });

  it('truncates mixed user/assistant messages to last 20', async () => {
    const s = new InMemoryIMContextStore();
    for (let i = 0; i < 15; i++) {
      await s.appendUserMessage('slack', 'C1', 'U1', `user ${i}`);
      await s.appendAssistantMessage('slack', 'C1', 'U1', `assistant ${i}`);
    }
    const ctx = await s.getContext('slack', 'C1', 'U1');
    assert.equal(ctx!.messages.length, 20);
    // The last message should be the most recent assistant message
    assert.equal(ctx!.messages[19].role, 'assistant');
    assert.equal(ctx!.messages[19].text, 'assistant 14');
  });

  it('isolates contexts by thread key', async () => {
    const s = new InMemoryIMContextStore();
    await s.appendUserMessage('slack', 'C1', 'U1', 'msg for U1');
    await s.appendUserMessage('slack', 'C1', 'U2', 'msg for U2');
    const ctx1 = await s.getContext('slack', 'C1', 'U1');
    const ctx2 = await s.getContext('slack', 'C1', 'U2');
    assert.equal(ctx1!.messages.length, 1);
    assert.equal(ctx1!.messages[0].text, 'msg for U1');
    assert.equal(ctx2!.messages.length, 1);
    assert.equal(ctx2!.messages[0].text, 'msg for U2');
  });

  it('getContext returns undefined for unknown key', async () => {
    const s = new InMemoryIMContextStore();
    assert.equal(await s.getContext('teams', 'C99', 'U99'), undefined);
  });
});
