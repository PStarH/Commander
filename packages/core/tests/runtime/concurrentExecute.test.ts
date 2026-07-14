/**
 * M2 — concurrent execute() contract: one in-flight run per AgentRuntime instance.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTestRuntime,
  ScriptedLLMProvider,
  makeContext,
  resetGlobalState,
} from './e2eTestHelpers';
import type { LLMRequest, LLMResponse } from '../../src/runtime/types';

export const config = { sequence: { concurrent: false } };

/** Provider that blocks until release() is called — simulates a long-running LLM call. */
class GatedLLMProvider extends ScriptedLLMProvider {
  private gate: Promise<void>;
  private releaseGate!: () => void;

  constructor() {
    super([{ response: 'done', finishReason: 'stop' }]);
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate();
  }

  override async call(request: LLMRequest): Promise<LLMResponse> {
    await this.gate;
    return super.call(request);
  }
}

describe('AgentRuntime concurrent execute() guard', () => {
  beforeEach(() => {
    resetGlobalState();
  });

  it('rejects a second execute() while the first is in flight', async () => {
    const { runtime } = createTestRuntime();
    const gated = new GatedLLMProvider();
    runtime.registerProvider('mock', gated);

    const first = runtime.execute(makeContext({ goal: 'long running task' }));

    // Yield so the first call reaches the gated LLM await
    await new Promise((r) => setTimeout(r, 50));

    const second = await runtime.execute(makeContext({ goal: 'overlapping task' }));
    expect(second.status).toBe('failed');
    expect(second.error).toContain('CONCURRENT_EXECUTE_REJECTED');

    gated.release();
    const firstResult = await first;
    expect(firstResult.status).toBe('success');
  });

  it('allows sequential execute() after the first completes', async () => {
    const { runtime } = createTestRuntime();

    for (let i = 0; i < 2; i++) {
      const provider = new ScriptedLLMProvider([
        { response: `Run ${i} complete.`, finishReason: 'stop' },
      ]);
      runtime.registerProvider('mock', provider);
      const result = await runtime.execute(makeContext({ goal: `task ${i}` }));
      expect(result.status).toBe('success');
    }
  });
});
