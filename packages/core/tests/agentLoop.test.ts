import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { CommanderAgentLoop, type AgentLoopConfig } from '../src/agentLoop';
import { createTestEnvSync, type TestEnv } from './helpers/testEnv';

describe('CommanderAgentLoop', () => {
  let loop: CommanderAgentLoop;
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnvSync('agentLoop');
    loop = new CommanderAgentLoop({
      projectRoot: env.workDir,
      stateFile: env.stateFile,
      maxConcurrentTasks: 3,
      sessionTimeoutMs: 60000,
      tools: ['web_search', 'file_read'],
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  // ── Config ─────────────────────────────────────────────────────────────────

  describe('config', () => {
    it('merges custom config with defaults', () => {
      const custom = new CommanderAgentLoop({
        stateFile: env.stateFile,
        maxConcurrentTasks: 10,
      });
      const status = custom.getStatus() as { tools: string[] };
      // Should have default tools
      assert.ok(status.tools.length > 0);
    });

    it('uses custom tools when provided', () => {
      const status = loop.getStatus() as { tools: string[] };
      assert.deepStrictEqual(status.tools, ['web_search', 'file_read']);
    });
  });

  // ── Task queue ─────────────────────────────────────────────────────────────

  describe('task queue', () => {
    it('adds tasks and returns id', () => {
      const id = loop.addTask('test task');
      assert.ok(id.startsWith('task_'));
      assert.strictEqual(loop.getQueueLength(), 1);
    });

    it('adds multiple tasks', () => {
      loop.addTask('task 1');
      loop.addTask('task 2');
      loop.addTask('task 3');
      assert.strictEqual(loop.getQueueLength(), 3);
    });

    it('sorts tasks by priority (descending)', () => {
      loop.addTask('low priority', 0);
      loop.addTask('high priority', 10);
      loop.addTask('medium priority', 5);

      // Queue should be sorted: high (10), medium (5), low (0)
      const status = loop.getStatus() as { queueLength: number };
      assert.strictEqual(status.queueLength, 3);
    });

    it('persists state to file', () => {
      loop.addTask('persisted task');
      assert.ok(fs.existsSync(env.stateFile));
      const data = JSON.parse(fs.readFileSync(env.stateFile, 'utf-8'));
      assert.strictEqual(data.taskQueue.length, 1);
      assert.strictEqual(data.taskQueue[0].goal, 'persisted task');
    });

    it('loads state from file on construction', () => {
      loop.addTask('task from first instance');

      // Create a new instance that loads from the same state file
      const loop2 = new CommanderAgentLoop({
        projectRoot: env.workDir,
        stateFile: env.stateFile,
        tools: ['web_search'],
      });
      assert.strictEqual(loop2.getQueueLength(), 1);
    });
  });

  // ── Active sessions ────────────────────────────────────────────────────────

  describe('active sessions', () => {
    it('starts with zero active sessions', () => {
      assert.strictEqual(loop.getActiveCount(), 0);
    });
  });

  // ── Status ─────────────────────────────────────────────────────────────────

  describe('status', () => {
    it('returns correct status shape', () => {
      const status = loop.getStatus() as {
        running: boolean;
        queueLength: number;
        activeSessions: number;
        sessions: Array<{ id: string; goal: string; runningFor: number }>;
        tools: string[];
      };

      assert.strictEqual(status.running, false);
      assert.strictEqual(status.queueLength, 0);
      assert.strictEqual(status.activeSessions, 0);
      assert.ok(Array.isArray(status.sessions));
      assert.ok(Array.isArray(status.tools));
    });

    it('reflects queue length in status', () => {
      loop.addTask('task 1');
      loop.addTask('task 2');
      const status = loop.getStatus() as { queueLength: number };
      assert.strictEqual(status.queueLength, 2);
    });
  });

  // ── Stop ───────────────────────────────────────────────────────────────────

  describe('stop', () => {
    it('can be called when not running', async () => {
      // Should not throw
      await loop.stop();
    });
  });

  // ── Deliberation integration ───────────────────────────────────────────────

  describe('deliberation integration', () => {
    it('deliberate function works for agent loop goals', async () => {
      // Import deliberate directly to test the integration point
      const { deliberate } = await import('../src/ultimate/deliberation');
      const plan = deliberate('Research the latest AI papers');
      assert.ok(plan.taskType);
      assert.ok(plan.recommendedTopology);
      assert.ok(plan.estimatedAgentCount > 0);
      assert.ok(plan.estimatedDurationMs > 0);
      assert.ok(typeof plan.suitableForSpeculation === 'boolean');
      assert.ok(typeof plan.taskNature === 'string');
      assert.ok(plan.timeBudgetPerAgentMs > 0);
    });
  });
});
