import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import { LeaseManager } from '../../src/atr/leaseManager';
import {
  installProcessCrashHandlers,
  isShuttingDown,
  resetCrashHandlersForTesting,
} from '../../src/runtime/processCrashSafety';

function newLeaseManager(): LeaseManager {
  return new LeaseManager({ filePath: ':memory:', defaultTtlSeconds: 30, defaultHolder: 'test' });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-crash-'));
}

describe('ProcessCrashSafety — reversibility tier 1.1', () => {
  let lm: LeaseManager;
  let dlq: DeadLetterQueue;
  let tmp: string;
  let activeRuns: Set<string>;
  let leaseTokens: Map<string, string>;
  let fencingEpochs: Map<string, number>;
  let tenantIds: Map<string, string>;

  beforeEach(() => {
    lm = newLeaseManager();
    tmp = tempDir();
    dlq = new DeadLetterQueue(tmp);
    activeRuns = new Set();
    leaseTokens = new Map();
    fencingEpochs = new Map();
    tenantIds = new Map();
    resetCrashHandlersForTesting();
  });

  afterEach(() => {
    lm.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    resetCrashHandlersForTesting();
  });

  it('installProcessCrashHandlers is idempotent', () => {
    const deps = { dlq, leaseManager: lm, activeRunIds: () => activeRuns };
    installProcessCrashHandlers(deps);
    installProcessCrashHandlers(deps);
    assert.strictEqual(isShuttingDown(), false);
  });

  it('records DLQ entry on uncaughtException', () => {
    const deps = {
      dlq,
      leaseManager: lm,
      activeRunIds: () => activeRuns,
      leaseTokenFor: (id: string) => leaseTokens.get(id),
      fencingEpochFor: (id: string) => fencingEpochs.get(id),
      tenantIdFor: (id: string) => tenantIds.get(id),
    };
    installProcessCrashHandlers(deps);
    activeRuns.add('run-1');

    process.emit('uncaughtException', new Error('synthetic crash'));

    const entries = dlq.readEntries('execution', 100);
    const crashEntries = entries.filter(
      (e) =>
        e.tags.includes('crash') && e.tags.includes('uncaughtException') && e.runId === 'run-1',
    );
    assert.ok(crashEntries.length > 0, 'DLQ should have crash entry for run-1');
    assert.match(crashEntries[0].errorMessage, /synthetic crash/);
  });

  it('records DLQ entry on unhandledRejection', () => {
    const deps = { dlq, leaseManager: lm, activeRunIds: () => activeRuns };
    installProcessCrashHandlers(deps);
    activeRuns.add('run-2');

    process.emit('unhandledRejection', new Error('async failure'));

    const entries = dlq.readEntries('execution', 100);
    const crashEntries = entries.filter(
      (e) => e.runId === 'run-2' && e.tags.includes('unhandledRejection'),
    );
    assert.ok(crashEntries.length > 0, 'DLQ should have unhandledRejection entry for run-2');
  });

  it('releases lease and aborts scheduler for crashed run', () => {
    const deps = {
      dlq,
      leaseManager: lm,
      activeRunIds: () => activeRuns,
      leaseTokenFor: (id: string) => leaseTokens.get(id),
      fencingEpochFor: (id: string) => fencingEpochs.get(id),
      tenantIdFor: (id: string) => tenantIds.get(id),
    };
    installProcessCrashHandlers(deps);

    const runId = 'run-3';
    const token = lm.acquire(runId, { tenantId: 'tenant-a' });
    assert.ok(token, 'lease acquired');
    leaseTokens.set(runId, token.leaseToken);
    fencingEpochs.set(runId, token.fencingEpoch);
    tenantIds.set(runId, 'tenant-a');
    activeRuns.add(runId);

    process.emit('uncaughtException', new Error('crash'));

    const validateResult = lm.validate(runId, token.leaseToken, token.fencingEpoch);
    assert.strictEqual(
      validateResult,
      null,
      'lease should be released after crash (validate returns null)',
    );
  });

  it('skips reentry — only one shutdown sequence runs', () => {
    let shutdownCount = 0;
    const deps = { dlq, leaseManager: lm, activeRunIds: () => activeRuns };
    installProcessCrashHandlers(deps);
    activeRuns.add('run-4');

    const origExit = process.exit;
    process.exit = (() => {
      shutdownCount++;
    }) as never;

    try {
      process.emit('uncaughtException', new Error('first'));
      process.emit('unhandledRejection', new Error('second'));
      process.emit('SIGTERM');
      process.emit('SIGINT');
    } finally {
      process.exit = origExit;
    }

    assert.strictEqual(isShuttingDown(), true, 'shutting down after first event');
  });
});
