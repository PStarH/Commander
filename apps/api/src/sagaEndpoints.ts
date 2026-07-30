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
  FileSagaStore,
  type SagaStateSnapshot,
  type SagaEvent,
} from '@commander/core/saga';

const DATA_DIR = process.env.COMMANDER_SAGA_DATA ?? join(process.cwd(), '.commander', 'sagas');

function buildSagaProjection(): SagaCheckpointManager {
  return new SagaCheckpointManager(new FileSagaStore({ baseDir: DATA_DIR }));
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

function executionRemoved(res: import('express').Response): void {
  res.status(410).json({
    error: {
      code: 'LEGACY_EXECUTION_DISABLED',
      message: 'Process-local saga execution has been removed from the API.',
      replacement: 'POST /v1/runs',
    },
  });
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
    const recovered = await buildSagaProjection().recover(runId);
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
    const recovered = await buildSagaProjection().recover(runId);
    if (!recovered) return res.status(404).json({ error: 'Run not found' });
    res.json({
      runId,
      snapshot: recovered.snapshot,
      timeline: buildTimeline(recovered.snapshot, recovered.allEvents),
    });
  });

  router.use('/api/saga/runs/:runId/resume', (_req, res) => {
    executionRemoved(res);
  });

  router.use('/api/saga/runs/:runId/fork', (_req, res) => {
    executionRemoved(res);
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
