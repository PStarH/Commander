/**
 * RG-01 / RG-02 — fail-closed contract for the runtime guardian bridge.
 *
 * The enabled semantic review must never approve a tool call unless the
 * provider returned an explicit, well-formed approval. A missing provider,
 * timeout, empty response, unparseable response or thrown error is an
 * UNAVAILABLE review, i.e. a denial, and must be distinguishable from a
 * provider policy denial. The bridge must also not reuse one runtime's
 * approval for another runtime's identical (tool, arguments) call.
 *
 * node:test file — auto-discovered by packages/core/scripts/run-node-tests.mjs.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  initializeRuntimeGuardian,
  reviewToolCall,
  resetRuntimeGuardian,
} from '../../src/runtime/runtimeGuardianBridge';
import type { ToolCall } from '../../src/runtime/types';

interface ProviderCallInput {
  model: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
}

const toolCall: ToolCall = {
  id: 'tc-1',
  name: 'shell_execute',
  arguments: { command: 'rm -rf /tmp/test' },
};

const unavailableMark = 'review unavailable';

/** Provider whose single call either returns `behavior` or throws it. */
function makeProvider(behavior: { content?: string } | Error) {
  let calls = 0;
  const provider = {
    call: async (_input: ProviderCallInput): Promise<{ content?: string }> => {
      calls += 1;
      if (behavior instanceof Error) throw behavior;
      return behavior;
    },
  };
  return { factory: () => provider, calls: () => calls };
}

describe('runtime guardian fail-closed review (RG-01)', () => {
  beforeEach(() => {
    resetRuntimeGuardian();
  });

  it('denies when the provider throws', async () => {
    initializeRuntimeGuardian(() => makeProvider(new Error('provider exploded')).factory(), {
      enabled: true,
    });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, false);
    assert.ok(decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('denies on an empty provider response', async () => {
    initializeRuntimeGuardian(() => makeProvider({ content: '' }).factory(), { enabled: true });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, false);
    assert.ok(decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('denies on a malformed / unparseable provider response', async () => {
    initializeRuntimeGuardian(() => makeProvider({ content: 'Sure, go ahead!' }).factory(), {
      enabled: true,
    });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, false);
    assert.ok(decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('denies on timeout', async () => {
    initializeRuntimeGuardian(
      () => ({
        call: (_input: ProviderCallInput) =>
          new Promise<{ content?: string }>((resolve) => {
            // Resolves long after the guardian timeout. The ref'd timer also
            // keeps the event loop alive so the unref'd guardian timeout fires.
            setTimeout(() => resolve({ content: 'APPROVED: true\nREASON: too late' }), 500);
          }),
      }),
      { enabled: true, timeoutMs: 50 },
    );

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, false);
    assert.ok(decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('denies when the enabled review has no provider', async () => {
    initializeRuntimeGuardian(() => null, { enabled: true });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, false);
    assert.ok(decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('approves only on an explicit valid approval', async () => {
    const provider = makeProvider({ content: 'APPROVED: true\nREASON: scoped temp cleanup' });
    initializeRuntimeGuardian(provider.factory, { enabled: true });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, true);
    assert.equal(decision.reviewed, true);
    assert.equal(decision.reason, 'scoped temp cleanup');
    assert.equal(provider.calls(), 1);
  });

  it('denies on an explicit provider denial', async () => {
    const provider = makeProvider({
      content: 'APPROVED: false\nREASON: recursive root deletion',
    });
    initializeRuntimeGuardian(provider.factory, { enabled: true });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, false);
    assert.equal(decision.reviewed, true);
    assert.equal(decision.reason, 'recursive root deletion');
    // A policy denial is distinguishable from an unavailable review.
    assert.ok(!decision.reason.includes(unavailableMark), `reason was: ${decision.reason}`);
  });

  it('still approves (documented pass-through) when the guardian is explicitly disabled', async () => {
    const provider = makeProvider({ content: 'APPROVED: false\nREASON: would deny' });
    initializeRuntimeGuardian(provider.factory, { enabled: false });

    const decision = await reviewToolCall(toolCall, 'delete a temp dir');

    assert.equal(decision.approved, true);
    assert.equal(decision.reviewed, false);
    assert.equal(provider.calls(), 0);
  });
});

describe('runtime guardian decision identity (RG-02)', () => {
  beforeEach(() => {
    resetRuntimeGuardian();
  });

  it("does not reuse the first runtime's approval for a second runtime with the same tool and arguments", async () => {
    // Runtime A: provider approves the call.
    const runtimeA = makeProvider({ content: 'APPROVED: true\nREASON: runtime A approved' });
    initializeRuntimeGuardian(runtimeA.factory, { enabled: true });
    const first = await reviewToolCall(toolCall, 'goal A');
    assert.equal(first.approved, true);
    assert.equal(runtimeA.calls(), 1);

    // Runtime B re-initializes the module global with its own provider/goal and
    // must get its own review — not runtime A's approval.
    const runtimeB = makeProvider({ content: 'APPROVED: false\nREASON: runtime B denied' });
    initializeRuntimeGuardian(runtimeB.factory, { enabled: true });
    const second = await reviewToolCall(toolCall, 'goal B');

    assert.equal(runtimeB.calls(), 1, "runtime B's provider must actually be consulted");
    assert.equal(second.approved, false);
    assert.equal(second.reviewed, true);
    assert.equal(second.reason, 'runtime B denied');
  });

  it("passes the caller's actual execution goal to the provider", async () => {
    const prompts: string[] = [];
    initializeRuntimeGuardian(
      () => ({
        call: async (input: ProviderCallInput) => {
          prompts.push(input.messages[0].content);
          return { content: 'APPROVED: true\nREASON: ok' };
        },
      }),
      { enabled: true },
    );

    await reviewToolCall(toolCall, 'rotate the staging credentials');

    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes('rotate the staging credentials'));
  });

  it('omits the goal instead of fabricating an absent one', async () => {
    const prompts: string[] = [];
    initializeRuntimeGuardian(
      () => ({
        call: async (input: ProviderCallInput) => {
          prompts.push(input.messages[0].content);
          return { content: 'APPROVED: true\nREASON: ok' };
        },
      }),
      { enabled: true },
    );

    await reviewToolCall(toolCall);

    assert.equal(prompts.length, 1);
    assert.ok(
      !prompts[0].includes('undefined'),
      'prompt must not fabricate "undefined" as the goal',
    );
    assert.ok(!prompts[0].includes('Task goal:'), 'prompt must omit the goal section entirely');
    assert.ok(prompts[0].includes('shell_execute'), 'the tool call itself must still be sent');
  });
});
