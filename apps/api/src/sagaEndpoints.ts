import {
  reportSilentFailure,
  SSEStream,
  getMessageBus,
  type MessageBusTopic,
} from '@commander/core';
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
  type SagaGraph,
  type SagaStateSnapshot,
  type SagaEvent,
} from '@commander/core/saga';

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
  } catch (err) {
    reportSilentFailure(err, 'sagaEndpoints:38');
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
        // `sagaName` is not part of the core SagaStateSnapshot type but is
        // persisted on disk by older saga writers. Read it as an optional
        // bag-of-record field via a narrow cast — keeps the endpoint
        // backwards-compatible without rewriting the snapshot schema.
        const enriched = snap as SagaStateSnapshot & { sagaName?: string };
        return {
          runId: e.name,
          state: snap.state,
          sagaName: enriched.sagaName,
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

    const sagaName = (recovered.snapshot as { sagaName?: string }).sagaName;
    if (!sagaName) return res.status(400).json({ error: 'Snapshot missing sagaName' });

    const graph = lookupSagaGraph(sagaName);
    if (!graph) return res.status(400).json({ error: `Unknown saga: ${sagaName}` });

    const coord = await (
      SagaCoordinator as unknown as {
        resumeFrom: (
          graph: SagaGraph,
          recovered: unknown,
          checkpoint: unknown,
          approval: unknown,
          runtime: unknown,
        ) => Promise<unknown>;
      }
    ).resumeFrom(graph, recovered, runtime.checkpoint, runtime.approval, runtime);

    const coordinator = coord as unknown as {
      resume: () => Promise<{ status: string }>;
      run: () => Promise<{ status: string }>;
      state: unknown;
    };

    const resultPromise = coordinator.resume();
    res.json({ runId, status: 'resuming', state: coordinator.state });

    const bus = getMessageBus();
    resultPromise
      .then((result: { status: string }) => {
        bus.publish('saga.completed' as MessageBusTopic, 'saga-api', {
          runId,
          status: result.status,
        });
      })
      .catch((err: unknown) => {
        // Security: Log full error server-side; publish sanitized message to bus.
        console.error('[sagaEndpoints] Saga failed:', err);
        bus.publish('saga.failed' as MessageBusTopic, 'saga-api', {
          runId,
          error: 'Saga execution failed',
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

    const sagaName = (recovered.snapshot as { sagaName?: string }).sagaName;
    if (!sagaName) return res.status(400).json({ error: 'Snapshot missing sagaName' });

    const graph = lookupSagaGraph(sagaName);
    if (!graph) return res.status(400).json({ error: `Unknown saga: ${sagaName}` });

    const { coordinator: coord, newRunId } = await (
      SagaCoordinator as unknown as {
        forkFrom: (...args: unknown[]) => Promise<{ coordinator: unknown; newRunId: string }>;
      }
    ).forkFrom(graph, runId, nodeId, runtime.checkpoint, runtime.approval, { ...runtime, input });

    const forked = coord as unknown as {
      run: () => Promise<{ status: string }>;
    };

    const resultPromise = forked.run();
    res.json({ parentRunId: runId, newRunId, forkNodeId: nodeId, status: 'forked' });

    const bus = getMessageBus();
    resultPromise
      .then((result: { status: string }) => {
        bus.publish('saga.completed' as MessageBusTopic, 'saga-api', {
          runId: newRunId,
          status: result.status,
        });
      })
      .catch((err: unknown) => {
        // Security: Log full error server-side; publish sanitized message to bus.
        console.error('[sagaEndpoints] Saga failed:', err);
        bus.publish('saga.failed' as MessageBusTopic, 'saga-api', {
          runId: newRunId,
          error: 'Saga execution failed',
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

    const stream = new (
      SSEStream as unknown as new () => {
        pipe: (r: NodeJS.WritableStream) => void;
        emitStructured: (event: string, payload: unknown) => void;
        close: () => void;
      }
    )();
    stream.pipe(res);

    const bus = getMessageBus();
    const unsubCompleted = bus.subscribe('saga.completed' as MessageBusTopic, (msg) => {
      const payload = msg.payload as { runId?: string; status?: string } | undefined;
      if (payload?.runId === runId) {
        stream.emitStructured('saga.completed', payload);
      }
    });
    const unsubFailed = bus.subscribe('saga.failed' as MessageBusTopic, (msg) => {
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
