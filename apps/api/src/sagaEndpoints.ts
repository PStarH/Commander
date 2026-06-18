import { Router } from 'express';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import {
  CheckpointManager as SagaCheckpointManager,
  ApprovalManager,
  FileSagaStore,
  FileApprovalStore,
  InProcessWorkerPool,
  CompensationScheduler,
  defaultCompensationRetryPolicy,
  SagaCoordinator,
  getSagaExample,
} from '@commander/core/saga';
import { SSEStream, getMessageBus } from '@commander/core';
import type { SagaGraph, SagaStateSnapshot, SagaEvent } from '@commander/core/saga';

const DATA_DIR = process.env.COMMANDER_SAGA_DATA ?? join(process.cwd(), '.commander', 'sagas');

function buildSagaRuntime() {
  const store = new FileSagaStore({ baseDir: DATA_DIR });
  const approvalStore = new FileApprovalStore({ baseDir: DATA_DIR });
  return {
    checkpoint: new SagaCheckpointManager(store),
    approval: new ApprovalManager({ store: approvalStore }),
    compensation: new CompensationScheduler({ retryPolicy: defaultCompensationRetryPolicy() }),
    workerPool: new InProcessWorkerPool(8),
  };
}

function readSnapshot(runId: string): SagaStateSnapshot | undefined {
  const path = join(DATA_DIR, runId, 'snapshot.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as SagaStateSnapshot;
  } catch {
    return undefined;
  }
}

function lookupSagaGraph(sagaName: string): SagaGraph | undefined {
  const example = getSagaExample(sagaName);
  if (!example) return undefined;
  return example.build();
}

function buildTimeline(snapshot: SagaStateSnapshot, events: SagaEvent[]) {
  return events.map((ev) => ({
    kind: ev.kind,
    timestamp: ev.timestamp,
    nodeId: (ev.nodeId as string) ?? undefined,
    name: (ev.name as string) ?? undefined,
    state: snapshot.nodeStates[(ev.nodeId as string) ?? ''] ?? undefined,
    attempt: (ev.attempt as number) ?? undefined,
    error: (ev.error as string) ?? undefined,
  }));
}

export function createSagaRouter(): Router {
  const router = Router();

  router.get('/api/saga/runs', async (_req, res) => {
    if (!existsSync(DATA_DIR)) {
      return res.json({ runs: [] });
    }
    const entries = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const snap = readSnapshot(e.name);
        if (!snap) return { runId: e.name, state: 'UNKNOWN', sagaName: undefined, updatedAt: '' };
        return {
          runId: e.name,
          state: snap.state,
          sagaName: snap.sagaName,
          updatedAt: snap.updatedAt,
        };
      });
    res.json({ runs: entries });
  });

  router.get('/api/saga/runs/:runId', async (req, res) => {
    const { runId } = req.params;
    const runtime = buildSagaRuntime();
    const recovered = await runtime.checkpoint.recover(runId);
    if (!recovered) return res.status(404).json({ error: 'Run not found' });
    res.json({
      runId,
      snapshot: recovered.snapshot,
      events: recovered.allEvents,
      eventsAfterSnapshot: recovered.eventsAfterSnapshot,
    });
  });

  router.get('/api/saga/runs/:runId/timeline', async (req, res) => {
    const { runId } = req.params;
    const runtime = buildSagaRuntime();
    const recovered = await runtime.checkpoint.recover(runId);
    if (!recovered) return res.status(404).json({ error: 'Run not found' });
    res.json({
      runId,
      snapshot: recovered.snapshot,
      timeline: buildTimeline(recovered.snapshot, recovered.allEvents),
    });
  });

  router.post('/api/saga/runs/:runId/resume', async (req, res) => {
    const { runId } = req.params;
    const runtime = buildSagaRuntime();
    const recovered = await runtime.checkpoint.recover(runId);
    if (!recovered) return res.status(404).json({ error: 'Run not found' });

    const sagaName = recovered.snapshot.sagaName;
    if (!sagaName) return res.status(400).json({ error: 'Snapshot missing sagaName' });

    const graph = lookupSagaGraph(sagaName);
    if (!graph) return res.status(400).json({ error: `Unknown saga: ${sagaName}` });

    const coord = await SagaCoordinator.resumeFrom(
      graph,
      recovered,
      runtime.checkpoint,
      runtime.approval,
      runtime,
    );

    const resultPromise = coord.resume();
    res.json({ runId, status: 'resuming', state: coord.state });

    resultPromise
      .then((result) => {
        getMessageBus().publish('saga.completed', 'saga-api', { runId, status: result.status });
      })
      .catch((err) => {
        getMessageBus().publish('saga.failed', 'saga-api', {
          runId,
          error: err?.message ?? String(err),
        });
      });
  });

  router.post('/api/saga/runs/:runId/fork', async (req, res) => {
    const { runId } = req.params;
    const { nodeId, input } = req.body as { nodeId?: string; input?: Record<string, unknown> };
    if (!nodeId) return res.status(400).json({ error: 'nodeId required' });

    const runtime = buildSagaRuntime();
    const recovered = await runtime.checkpoint.recover(runId);
    if (!recovered) return res.status(404).json({ error: 'Run not found' });

    const sagaName = recovered.snapshot.sagaName;
    if (!sagaName) return res.status(400).json({ error: 'Snapshot missing sagaName' });

    const graph = lookupSagaGraph(sagaName);
    if (!graph) return res.status(400).json({ error: `Unknown saga: ${sagaName}` });

    const { coordinator: coord, newRunId } = await SagaCoordinator.forkFrom(
      graph,
      runId,
      nodeId,
      runtime.checkpoint,
      runtime.approval,
      { ...runtime, input },
    );

    const resultPromise = coord.run();
    res.json({ parentRunId: runId, newRunId, forkNodeId: nodeId, status: 'forked' });

    resultPromise
      .then((result) => {
        getMessageBus().publish('saga.completed', 'saga-api', {
          runId: newRunId,
          status: result.status,
        });
      })
      .catch((err) => {
        getMessageBus().publish('saga.failed', 'saga-api', {
          runId: newRunId,
          error: err?.message ?? String(err),
        });
      });
  });

  router.get('/api/saga/stream/:runId', async (req, res) => {
    const { runId } = req.params;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stream = new SSEStream();
    stream.pipe(res);

    const bus = getMessageBus();
    const unsubCompleted = bus.subscribe('saga.completed', (msg) => {
      const payload = msg.payload as { runId?: string; status?: string } | undefined;
      if (payload?.runId === runId) {
        stream.emitStructured('saga.completed', payload);
      }
    });
    const unsubFailed = bus.subscribe('saga.failed', (msg) => {
      const payload = msg.payload as { runId?: string; error?: string } | undefined;
      if (payload?.runId === runId) {
        stream.emitStructured('saga.failed', payload);
      }
    });

    req.on('close', () => {
      unsubCompleted();
      unsubFailed();
      stream.close();
    });
  });

  return router;
}
