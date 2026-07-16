/**
 * SLO Measurement Test
 *
 * Measures the four task-package-5 SLOs and reports pass/fail:
 *   recovery     < 5s
 *   failover     < 10s
 *   compensation < 30s
 *   dlq          < 60s
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderFallbackChain } from '../../src/runtime/providerFallbackChain';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { RunRecovery } from '../../src/runtime/runRecovery';
import { LeaseManager } from '../../src/atr/leaseManager';
import { resetGlobalEventSourcingEngine } from '../../src/runtime/eventSourcingEngine';
import { resetGlobalDeterminismCapture } from '../../src/runtime/determinismCapture';
import {
  SLO_THRESHOLDS,
  measureLatency,
  createSLOResport,
  saveSLOResport,
  formatSLOSummary,
} from './sloReporter';

describe('E2E: SLO measurements', () => {
  let tmpDir: string;
  let prevWalEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-measure-'));
    // Isolate EventSourcing WAL so full-suite pollution cannot inflate recovery latency.
    prevWalEnv = process.env.COMMANDER_EVENT_SOURCING_WAL;
    process.env.COMMANDER_EVENT_SOURCING_WAL = path.join(tmpDir, 'event-sourcing.wal');
    await resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
  });

  afterEach(async () => {
    await resetGlobalEventSourcingEngine();
    resetGlobalDeterminismCapture();
    if (prevWalEnv === undefined) delete process.env.COMMANDER_EVENT_SOURCING_WAL;
    else process.env.COMMANDER_EVENT_SOURCING_WAL = prevWalEnv;
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('meets all SLO thresholds', async () => {
    const measurements: Array<ReturnType<typeof createSLOResport>['measurements'][number]> = [];

    // 1. Recovery SLO: checkpoint resume (disableReplay avoids scanning a shared WAL)
    {
      const checkpointer = new StateCheckpointer(tmpDir);
      const leaseManager = new LeaseManager({ ttlMs: 60000, maxPerRun: 4 });
      const recovery = new RunRecovery(checkpointer, leaseManager);
      const lease = leaseManager.acquire('run-slo').lease;

      checkpointer.checkpoint({
        runId: 'run-slo',
        agentId: 'agent-1',
        timestamp: new Date().toISOString(),
        phase: 'tool_execution',
        stepNumber: 3,
        attemptNumber: 1,
        messages: [],
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        stepDurations: [100, 200, 150],
        context: {
          agentId: 'agent-1',
          projectId: 'proj-1',
          goal: 'do the thing',
          availableTools: [],
          maxSteps: 10,
          tokenBudget: 1000,
        },
        totalDurationMs: 450,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
      });

      const { durationMs } = await measureLatency(() =>
        recovery.attempt('run-slo', { disableReplay: true }),
      );
      measurements.push({
        id: 'slo-recovery',
        name: 'recovery',
        metric: 'latency_ms',
        thresholdMs: SLO_THRESHOLDS.recovery,
        actualMs: durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. Failover SLO: provider fallback chain
    {
      const chain = new ProviderFallbackChain<string>();
      const { durationMs } = await measureLatency(() =>
        chain.tryProviders([
          {
            name: 'primary',
            attempt: () => Promise.reject(new Error('timeout')),
          },
          {
            name: 'secondary',
            attempt: () => Promise.resolve('ok'),
          },
        ]),
      );
      measurements.push({
        id: 'slo-failover',
        name: 'failover',
        metric: 'latency_ms',
        thresholdMs: SLO_THRESHOLDS.failover,
        actualMs: durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    // 3. Compensation SLO: compensate a batch of actions
    {
      const registry = new CompensationRegistry();
      const actionCount = 50;

      registry.register('noop', async () => ({ success: true }));

      for (let i = 0; i < actionCount; i++) {
        registry.recordAction({
          actionId: `action-${i}`,
          toolName: 'noop',
          args: {},
          description: 'noop compensation',
          tags: [],
        });
      }

      const { durationMs } = await measureLatency(() => registry.compensateAll());
      measurements.push({
        id: 'slo-compensation',
        name: 'compensation',
        metric: 'latency_ms',
        thresholdMs: SLO_THRESHOLDS.compensation,
        actualMs: durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. DLQ SLO: record, flush, and read entries
    {
      const dlqDir = path.join(tmpDir, 'dlq');
      const dlq = new DeadLetterQueue(dlqDir);
      const entryCount = 100;

      for (let i = 0; i < entryCount; i++) {
        dlq.record({
          id: `entry-${i}`,
          category: 'execution',
          runId: 'run-1',
          agentId: 'agent-1',
          timestamp: new Date().toISOString(),
          errorClass: 'transient',
          errorMessage: `error ${i}`,
          retryable: true,
          attemptNumber: 1,
          operationName: 'test-op',
          compensated: false,
          recovered: false,
          tags: [],
        });
      }

      const { durationMs } = await measureLatency(async () => {
        await dlq.flush('execution');
        return await dlq.readEntries('execution', entryCount);
      });

      measurements.push({
        id: 'slo-dlq',
        name: 'dlq',
        metric: 'latency_ms',
        thresholdMs: SLO_THRESHOLDS.dlq,
        actualMs: durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    const report = createSLOResport(measurements);
    const reportPath = saveSLOResport(report);

    // eslint-disable-next-line no-console
    console.log(formatSLOSummary(report));
    // eslint-disable-next-line no-console
    console.log(`SLO report saved to: ${reportPath}`);

    expect(report.summary.failed).toBe(0);
    for (const m of report.measurements) {
      expect(m.passed).toBe(true);
    }
  }, 120000);
});
