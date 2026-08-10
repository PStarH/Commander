import type { ModelRequest } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { DeterministicToolModel } from '../src/deterministicModel';

function request(input: ModelRequest['input']): ModelRequest {
  return {
    input,
    systemInstructions: 'Use the requested Commander tool.',
    tools: [],
    outputType: 'text',
    modelSettings: {},
    handoffs: [],
    tracing: false,
  };
}

describe('DeterministicToolModel', () => {
  it('emits one requested function call before returning a final message', async () => {
    const model = new DeterministicToolModel('commander_action_get', { runId: 'run-1' });

    const first = await model.getResponse(request([]));
    expect(first.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        name: 'commander_action_get',
        arguments: JSON.stringify({ runId: 'run-1' }),
      }),
    ]);

    const second = await model.getResponse(
      request([
        {
          type: 'function_call_result',
          name: 'commander_action_get',
          callId: 'commander-call-1',
          status: 'completed',
          output: { type: 'text', text: '{"action":{"runId":"run-1"}}' },
        },
      ]),
    );
    expect(second.output).toEqual([
      expect.objectContaining({ type: 'message', role: 'assistant', status: 'completed' }),
    ]);
  });
});
