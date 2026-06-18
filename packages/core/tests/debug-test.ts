import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SubAgentExecutor } from '../src/ultimate/subAgentExecutor';
import { StateCheckpointer } from '../src/runtime/stateCheckpointer';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { MockLLMProvider } from '../src/runtime/mockLLMProvider';
import { ModelRouter, resetModelRouter } from '../src/runtime/modelRouter';
import { resetHumanApprovalManager } from '../src/ultimate/humanApprovalManager';

describe('debug', () => {
  it('captures error stack', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-'));
    resetHumanApprovalManager();
    resetModelRouter();
    const provider = new MockLLMProvider('test', { defaultResponse: 'completed task' });
    const router = new ModelRouter();
    const runtime = new AgentRuntime({ maxRetries: 0, timeoutMs: 5000, maxStepsPerRun: 2 }, router);
    runtime.registerProvider('test', provider);
    const executor = new SubAgentExecutor(runtime);
    const checkpointer = new StateCheckpointer(tmpDir);
    executor.setCheckpointer(checkpointer);
    executor.setRunId('run-debug');
    const errors: any[] = [];

    executor.setApprovalGate(null);
    const node: any = {
      id: 'free-1',
      goal: 'list the files',
      context: { availableTools: [] },
      subtasks: [],
      dependencies: [],
      isAtomic: true,
      status: 'PENDING',
      estimatedDurationMs: 100,
    };
    await executor.executeNode(node, 'proj-1', {}, errors);

    console.log('NODE STATUS:', node.status);
    console.log('NODE RESULT:', node.result?.slice(0, 500));
    console.log(
      'ERROR MSGS:',
      JSON.stringify(
        errors.map((e) => ({
          nodeId: e.nodeId,
          message: e.message,
          stack: e.stack?.split('\n').slice(0, 5).join(' | '),
        })),
      ),
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
