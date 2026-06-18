import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SamplesStore } from '../../src/runtime/samplesStore';

describe('SamplesStore', () => {
  let store: SamplesStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samples-test-'));
    store = new SamplesStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('creates store with default directory', () => {
      const defaultStore = new SamplesStore();
      expect(defaultStore).toBeDefined();
    });

    it('creates store with custom directory', () => {
      expect(store).toBeDefined();
    });

    it('creates store with tenant isolation', () => {
      const tenantStore = new SamplesStore(tmpDir, 'tenant-1');
      expect(tenantStore).toBeDefined();
    });
  });

  describe('recordLLMCall', () => {
    it('records an LLM call', async () => {
      const callId = await store.recordLLMCall(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] },
        { content: 'response', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
        { provider: 'openai', durationMs: 500, attemptNumber: 1 },
      );
      expect(callId).toBeDefined();
      expect(callId).toMatch(/^call_/);
    });

    it('records a failed LLM call', async () => {
      const callId = await store.recordLLMCall(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'test' }] },
        null,
        { provider: 'openai', durationMs: 100, attemptNumber: 1, error: 'rate_limit' },
      );
      expect(callId).toBeDefined();
    });

    it('records with task ID for code extraction', async () => {
      const callId = await store.recordLLMCall(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'write a function' }] },
        {
          content: '```python\ndef hello():\n    pass\n```',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        },
        { provider: 'openai', durationMs: 1000, attemptNumber: 1, taskId: 'HumanEval/1' },
      );
      expect(callId).toBeDefined();
    });
  });

  describe('recordVerification', () => {
    it('records a verification result', async () => {
      await store.recordVerification(
        'implement a function',
        'function hello() { return "world"; }',
        {
          passed: true,
          confidence: 0.95,
          signalCount: 3,
          tokensUsed: 100,
          stagesRun: [1, 2, 3],
        },
      );
      // No error means success
    });

    it('records failed verification', async () => {
      await store.recordVerification('fix the bug', 'broken code', {
        passed: false,
        confidence: 0.2,
        signalCount: 1,
        tokensUsed: 50,
        stagesRun: [1],
        skipReason: 'low confidence',
      });
    });
  });

  describe('recordRunManifest', () => {
    it('records a run manifest', async () => {
      await store.recordRunManifest('run-123', {
        task: 'test task',
        status: 'completed',
        duration: 5000,
      });
      // No error means success
    });
  });
});
