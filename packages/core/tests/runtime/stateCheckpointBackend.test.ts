import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FilesystemStateCheckpointBackend,
  createStateCheckpointBackend,
} from '../../src/runtime/stateCheckpointBackend';
import type { CheckpointState } from '../../src/runtime/stateCheckpointer';

function sampleState(runId: string): CheckpointState {
  return {
    runId,
    agentId: 'agent-1',
    timestamp: new Date().toISOString(),
    phase: 'llm_call',
    stepNumber: 1,
    attemptNumber: 1,
    messages: [],
    tokenUsage: { input: 0, output: 0, total: 0 },
    stepDurations: [],
    context: {
      agentId: 'agent-1',
      projectId: 'p1',
      goal: 'test',
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 1000,
    },
    totalDurationMs: 0,
  };
}

describe('StateCheckpointBackend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-backend-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filesystem backend round-trips active and terminal checkpoints', () => {
    const backend = new FilesystemStateCheckpointBackend(tmpDir);
    const state = sampleState('run-fs-1');
    backend.writeActive('run-fs-1', state);
    expect(backend.readActive('run-fs-1')?.phase).toBe('llm_call');

    backend.writeTerminal('run-fs-1', { ...state, phase: 'completed' });
    expect(backend.readActive('run-fs-1')).toBeNull();
    expect(backend.readTerminal('run-fs-1')?.phase).toBe('completed');
  });

  it('createStateCheckpointBackend defaults to filesystem', () => {
    const backend = createStateCheckpointBackend(tmpDir, 'filesystem');
    expect(backend.type).toBe('filesystem');
  });
});
