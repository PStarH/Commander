import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
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

  afterEach(async () => {
    // Drain all pending writes before removing the temp directory, otherwise
    // drainQueue's appendFile calls race with rmSync and throw unhandled ENOENT.
    if (store) await store.flush();
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
        {
          content: 'response',
          model: 'gpt-4o',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
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
          model: 'gpt-4o',
          finishReason: 'stop',
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

  // ---------------------------------------------------------------------------
  // RQ-SAMPLES: a failed write must be retained and surfaced. The drain used to
  // restart itself from index 0 in `finally` (infinite replay + unhandled
  // rejection on a persistent EIO) while `flush()` cleared the whole queue,
  // so the two paths disagreed about what a failure means.
  // ---------------------------------------------------------------------------
  describe('write-failure durability (RQ-SAMPLES)', () => {
    let failWrites = false;
    let appendAttempts = 0;

    /** Fail every append to llm_calls.ndjson while `failWrites` is set. */
    function installFailingAppend(): void {
      const real = fs.promises.appendFile;
      vi.spyOn(fs.promises, 'appendFile').mockImplementation(((
        file: Parameters<typeof fs.promises.appendFile>[0],
        ...rest: unknown[]
      ) => {
        if (String(file).endsWith('llm_calls.ndjson')) {
          appendAttempts += 1;
          if (failWrites) {
            return Promise.reject(
              Object.assign(new Error('EIO: simulated write failure'), { code: 'EIO' }),
            );
          }
        }
        return (real as (...args: unknown[]) => Promise<void>).call(fs.promises, file, ...rest);
      }) as unknown as typeof fs.promises.appendFile);
    }

    function readLines(fileName: string): string[] {
      const p = path.join(tmpDir, fileName);
      if (!fs.existsSync(p)) return [];
      const content = fs.readFileSync(p, 'utf-8').trim();
      return content ? content.split('\n') : [];
    }

    const verification = {
      passed: true,
      confidence: 0.9,
      signalCount: 2,
      tokensUsed: 10,
      stagesRun: [1],
    };

    beforeEach(() => {
      failWrites = false;
      appendAttempts = 0;
    });

    afterEach(async () => {
      // Never leave a rejected spy in place: the outer afterEach also flushes.
      failWrites = false;
      vi.restoreAllMocks();
      await store.flush().catch(() => undefined);
    });

    it(
      'retains a failed task and retries without replaying committed work',
      { timeout: 10_000 },
      async () => {
        failWrites = true;
        installFailingAppend();

        // task 1 (verifications) → task 2 (llm_calls, fails) → task 3 (verifications)
        void store.recordVerification('goal-1', 'output-1', verification);
        void store.recordLLMCall({ model: 'gpt-4o', messages: [] }, null, {
          provider: 'openai',
          durationMs: 1,
          attemptNumber: 1,
          error: 'boom',
        });
        void store.recordVerification('goal-2', 'output-2', verification);

        // The failure is surfaced to the caller, not swallowed.
        await expect(store.flush()).rejects.toThrow(/EIO/);

        // task 1 committed exactly once; task 2 never reached disk; task 3 is
        // still queued behind it.
        expect(readLines('verifications.ndjson')).toHaveLength(1);
        expect(fs.existsSync(path.join(tmpDir, 'llm_calls.ndjson'))).toBe(false);

        // Explicit retry: task 2 and task 3 land, task 1 is not replayed.
        failWrites = false;
        await store.flush();

        expect(readLines('verifications.ndjson')).toHaveLength(2);
        expect(readLines('llm_calls.ndjson')).toHaveLength(1);
      },
    );

    it(
      'does not spin or emit an unhandled rejection on a persistent failure',
      { timeout: 10_000 },
      async () => {
        const rejections: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
          rejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        failWrites = true;
        installFailingAppend();
        try {
          void store.recordLLMCall({ model: 'gpt-4o', messages: [] }, null, {
            provider: 'openai',
            durationMs: 1,
            attemptNumber: 1,
            error: 'boom',
          });

          // Room for a buggy re-drain loop to demonstrate itself.
          await new Promise((resolve) => setTimeout(resolve, 150));

          expect(appendAttempts).toBe(1);
          expect(rejections).toEqual([]);
        } finally {
          // Restore before the test ends so a spin (if any) terminates.
          failWrites = false;
          process.off('unhandledRejection', onUnhandled);
          await store.flush().catch(() => undefined);
        }
      },
    );

    it('keeps a failed task retryable until an explicit flush succeeds', async () => {
      failWrites = true;
      installFailingAppend();

      void store.recordLLMCall({ model: 'gpt-4o', messages: [] }, null, {
        provider: 'openai',
        durationMs: 1,
        attemptNumber: 1,
      });

      await expect(store.flush()).rejects.toThrow(/EIO/);

      // A later enqueue must not silently restart the failed drain either.
      const attemptsAfterFailure = appendAttempts;
      void store.recordVerification('goal-3', 'output-3', verification);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(appendAttempts).toBe(attemptsAfterFailure);
      expect(readLines('llm_calls.ndjson')).toHaveLength(0);

      failWrites = false;
      await store.flush();
      expect(readLines('llm_calls.ndjson')).toHaveLength(1);
      expect(readLines('verifications.ndjson')).toHaveLength(1);
    });
  });
});
