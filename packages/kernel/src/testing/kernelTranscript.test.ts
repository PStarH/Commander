import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './inMemoryRepository.js';
import { SqliteKernelRepository } from '../sqlite.js';
import {
  normalizeTranscript,
  runKernelTranscriptScenarios,
  type KernelTranscriptEntry,
} from './kernelTranscript.js';

const clock = { now: () => '2030-01-01T00:00:00.000Z' };
let idCounter = 0;
const ids = { uuid: () => `transcript-id-${++idCounter}` };

describe('kernelTranscript', () => {
  it('runs T1–T8 on InMemory and produces stable digest', async () => {
    idCounter = 0;
    const digestA = normalizeTranscript(
      await runKernelTranscriptScenarios(new InMemoryKernelRepository(), { clock, ids }),
    );
    assert.ok(digestA.length === 64);
    idCounter = 0;
    const digestB = normalizeTranscript(
      await runKernelTranscriptScenarios(new InMemoryKernelRepository(), { clock, ids }),
    );
    assert.equal(digestA, digestB);
  });

  it('normalizeTranscript preserves event order differences', () => {
    const a: KernelTranscriptEntry[] = [
      { kind: 'event', name: 'run.created', payload: { runId: 'a' } },
      { kind: 'step', name: 'claimed', payload: { stepId: 's1' } },
    ];
    const b: KernelTranscriptEntry[] = [
      { kind: 'step', name: 'claimed', payload: { stepId: 's1' } },
      { kind: 'event', name: 'run.created', payload: { runId: 'a' } },
    ];
    assert.notEqual(normalizeTranscript(a), normalizeTranscript(b));
  });

  it('normalizeTranscript does not mask error code differences', () => {
    const denied: KernelTranscriptEntry[] = [
      { kind: 'error', name: 'policy', payload: { code: 'ACTION_POLICY_DENIED' } },
    ];
    const allowed: KernelTranscriptEntry[] = [
      { kind: 'error', name: 'policy', payload: { code: 'ACTION_ALLOWED' } },
    ];
    assert.notEqual(normalizeTranscript(denied), normalizeTranscript(allowed));
  });

  it('T8 pending approval + UNKNOWN survive sqlite reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-transcript-t8-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const worker = { workerId: 'worker-t8', generation: 1 };
    const tenant = 'tenant-t8';
    const writeRepo = new SqliteKernelRepository({ path: dbPath, schedulerMode: true });
    await writeRepo.initialize();
    writeRepo.seedTestWorker(worker.workerId, [tenant], worker.generation);
    await writeRepo.createRun(
      {
        id: 'run-t8',
        tenantId: tenant,
        intentHash: 'i',
        workGraphHash: 'g',
        workGraphVersion: 'v1',
        policySnapshotId: 'p',
        steps: [{ id: 'run-t8-step', kind: 'tool', initialState: 'WAITING_FOR_HUMAN' }],
      },
      'test',
    );
    await writeRepo.createInteraction(
      { runId: 'run-t8', stepId: 'run-t8-step', tenantId: tenant, prompt: 'persist?' },
      'test',
    );
    await writeRepo.createRun(
      {
        id: 'run-t8b',
        tenantId: tenant,
        intentHash: 'i',
        workGraphHash: 'g',
        workGraphVersion: 'v1',
        policySnapshotId: 'p',
        steps: [{ id: 'run-t8b-step', kind: 'agent' }],
      },
      'test',
    );
    const claimed = await writeRepo.claimNextStep({
      workerId: worker.workerId,
      workerGeneration: worker.generation,
      tenantId: tenant,
      capabilities: ['agent'],
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);
    await writeRepo.admitEffect({
      id: 'effect-t8',
      runId: 'run-t8b',
      stepId: claimed!.id,
      tenantId: tenant,
      type: 'connector.github.pull-request.create',
      idempotencyKey: 't8-key',
      policyDecisionId: 'pd',
      request: {},
      lease: claimed!.lease!,
      actor: worker.workerId,
    });
    await writeRepo.markEffectCompletionUnknown({
      effectId: 'effect-t8',
      tenantId: tenant,
      reason: 'crash',
      actor: 'test',
    });
    writeRepo.close();

    const readRepo = new SqliteKernelRepository({ path: dbPath, schedulerMode: true });
    await readRepo.initialize();
    const pending = await readRepo.listInteractions('run-t8', tenant);
    const effect = await readRepo.getEffect('effect-t8', tenant);
    assert.equal(pending.some((i) => i.status === 'pending'), true);
    assert.equal(effect?.state, 'COMPLETION_UNKNOWN');
    readRepo.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
