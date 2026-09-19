/**
 * Regression for RCH-08 (goalCompletionVerifier):
 *
 * The gate documented an explicit success signal, but `isVerificationResultSuccessful`
 * returned `true` when neither a success nor a failure word was present (and for
 * empty output), and it treated any truthy JSON field as a pass (`Boolean("no")`).
 * An inconclusive verification was therefore reported as a completed goal.
 *
 * The companion defect in `agentLoopOrchestrator` — an incomplete verification at
 * the attempt budget falls through to the confident early-exit success path — is
 * fixed by gating that path on `verification.isComplete`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoalCompletionVerifier,
  type GoalCompletionVerifyParams,
} from '../../src/runtime/goalCompletionVerifier';

function makeParams(output: unknown, attempt = 0): GoalCompletionVerifyParams {
  return {
    ctx: {
      verificationTool: 'verify',
      agentId: 'agent-1',
      availableTools: ['verify'],
    } as GoalCompletionVerifyParams['ctx'],
    runId: 'run-1',
    routing: { modelId: 'test-model' } as GoalCompletionVerifyParams['routing'],
    steps: [],
    request: { messages: [] } as unknown as GoalCompletionVerifyParams['request'],
    // No tool calls: the gate only runs when the model has stopped calling tools.
    response: {
      content: 'done',
      toolCalls: [],
    } as unknown as GoalCompletionVerifyParams['response'],
    tenantId: 'tenant-1',
    attempt,
  };
}

function verifierReturning(output: unknown, maxRetries = 3): GoalCompletionVerifier {
  return new GoalCompletionVerifier({
    getExecuteTool: () => async () => ({ output }) as never,
    getMaxRetries: () => maxRetries,
  });
}

describe('GoalCompletionVerifier — inconclusive output is not success', () => {
  it('treats an "unable to determine" result as incomplete', async () => {
    const result = await verifierReturning('Unable to determine whether work is complete').verify(
      makeParams('x'),
    );
    assert.equal(result.isComplete, false, 'inconclusive output must not pass');
  });

  it('treats empty output as incomplete', async () => {
    const result = await verifierReturning('').verify(makeParams('x'));
    assert.equal(result.isComplete, false, 'empty output must not pass');
  });

  it('treats unstructured prose with no signal as incomplete', async () => {
    const result = await verifierReturning('The tool ran and produced some output.').verify(
      makeParams('x'),
    );
    assert.equal(result.isComplete, false);
  });

  it('rejects a truthy non-boolean JSON field', async () => {
    for (const payload of ['{"passed":"no"}', '{"success":1}', '{"ok":"maybe"}']) {
      const result = await verifierReturning(payload).verify(makeParams('x'));
      assert.equal(result.isComplete, false, `${payload} must not count as a pass`);
    }
  });

  it('still accepts an explicit success signal', async () => {
    const result = await verifierReturning('All checks passed').verify(makeParams('x'));
    assert.equal(result.isComplete, true);
  });

  it('still accepts an explicit boolean true JSON field', async () => {
    const result = await verifierReturning('{"passed":true}').verify(makeParams('x'));
    assert.equal(result.isComplete, true);
  });

  it('rejects an explicit failure', async () => {
    const result = await verifierReturning('1 test failed').verify(makeParams('x'));
    assert.equal(result.isComplete, false);
  });

  it('returns incomplete WITHOUT feedback once the attempt budget is spent', async () => {
    const result = await verifierReturning('Unable to determine', 2).verify(makeParams('x', 2));
    assert.equal(result.isComplete, false);
    assert.equal(result.feedback, undefined, 'a spent budget yields no feedback');
  });
});
