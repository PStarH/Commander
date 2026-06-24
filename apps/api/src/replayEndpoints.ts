import { Router } from 'express';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

interface ReplayRunSummary {
  runId: string;
  agentId: string;
  missionId?: string;
  goal?: string;
  model?: string;
  status: 'completed' | 'failed';
  phase: string;
  startedAt: string;
  completedAt?: string;
  totalEvents: number;
  totalTokens: number;
  durationMs: number;
  stepCount: number;
}

interface TraceEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  agentId: string;
  type: string;
  timestamp: string;
  durationMs: number;
  data: Record<string, unknown>;
  parentSpanId?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function findBaseDirs(): { stateDir: string; tracesDir: string; samplesDir: string } {
  const cwd = process.cwd();
  return {
    stateDir: path.join(cwd, '.commander_state'),
    tracesDir: path.join(cwd, '.commander_traces'),
    samplesDir: path.join(cwd, '.commander_samples'),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    await fsp.access(filePath);
    return JSON.parse(await fsp.readFile(filePath, 'utf-8')) as T;
  } catch (err) {
    console.warn('[Catch]', err);
    return null;
  }
}

async function readNdjsonFile(filePath: string): Promise<TraceEvent[]> {
  try {
    await fsp.access(filePath);
    const raw = (await fsp.readFile(filePath, 'utf-8')).trim();
    if (!raw) return [];
    const events: TraceEvent[] = [];
    for (const line of raw.split('\n')) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        console.warn('[Catch]', err);
        /* skip corrupt lines */
      }
    }
    return events;
  } catch (err) {
    console.warn('[Catch]', err);
    return [];
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function isValidRunId(runId: string): boolean {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

// ── Router ─────────────────────────────────────────────────────────────────

export function createReplayRouter(): Router {
  const router = Router();

  // ── List all completed runs ────────────────────────────────────────────
  router.get('/api/replay/runs', async (_req, res) => {
    const { stateDir, tracesDir, samplesDir } = findBaseDirs();
    const completedDir = path.join(stateDir, 'completed');

    const runs: ReplayRunSummary[] = [];

    // Scan completed checkpoints
    try {
      let files: string[] = [];
      try {
        files = (await fsp.readdir(completedDir)).filter((f) => f.endsWith('.json'));
      } catch (err) {
        console.warn('[Catch]', err);
        /* dir may not exist */
      }
      for (const file of files) {
        const runId = file.replace(/\.json$/, '');
        const checkpoint = await readJsonFile<any>(path.join(completedDir, file));
        if (!checkpoint) continue;

        const [events, manifest] = await Promise.all([
          readNdjsonFile(path.join(tracesDir, `${runId}.ndjson`)),
          readJsonFile<any>(path.join(samplesDir, 'runs', `${runId}.json`)),
        ]);

        const totalTokens = events.reduce((sum, e) => {
          const usage = e.data?.tokenUsage as any;
          return sum + (usage?.totalTokens ?? 0);
        }, 0);

        runs.push({
          runId,
          agentId: checkpoint.agentId ?? manifest?.agentId ?? 'unknown',
          missionId: checkpoint.missionId ?? manifest?.missionId,
          goal: checkpoint.context?.goal ?? manifest?.goal,
          model: manifest?.model,
          status: checkpoint.phase === 'completed' ? 'completed' : 'failed',
          phase: checkpoint.phase,
          startedAt: manifest?.timestamp ?? checkpoint.timestamp,
          completedAt:
            checkpoint.phase === 'completed' || checkpoint.phase === 'failed'
              ? checkpoint.timestamp
              : undefined,
          totalEvents: events.length,
          totalTokens,
          durationMs: checkpoint.totalDurationMs ?? 0,
          stepCount: checkpoint.stepNumber ?? 0,
        });
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* ignore scan errors */
    }

    // Also scan in-flight checkpoints (not yet completed)
    try {
      let files: string[] = [];
      try {
        files = (await fsp.readdir(stateDir)).filter((f) => f.endsWith('.checkpoint'));
      } catch (err) {
        console.warn('[Catch]', err);
        /* dir may not exist */
      }
      for (const file of files) {
        const runId = file.replace(/\.checkpoint$/, '');
        if (runs.some((r) => r.runId === runId)) continue;

        const [checkpoint, events] = await Promise.all([
          readJsonFile<any>(path.join(stateDir, file)),
          readNdjsonFile(path.join(tracesDir, `${runId}.ndjson`)),
        ]);
        if (!checkpoint) continue;

        runs.push({
          runId,
          agentId: checkpoint.agentId ?? 'unknown',
          missionId: checkpoint.missionId,
          goal: checkpoint.context?.goal,
          status: checkpoint.phase === 'failed' ? 'failed' : 'completed',
          phase: checkpoint.phase,
          startedAt: checkpoint.timestamp,
          totalEvents: events.length,
          totalTokens: 0,
          durationMs: checkpoint.totalDurationMs ?? 0,
          stepCount: checkpoint.stepNumber ?? 0,
        });
      }
    } catch (err) {
      console.warn('[Catch]', err);
      /* ignore */
    }

    // Sort by timestamp descending
    runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

    res.json({ runs, total: runs.length });
  });

  // ── Get single run detail ──────────────────────────────────────────────
  router.get('/api/replay/runs/:runId', async (req, res) => {
    const { stateDir, tracesDir, samplesDir } = findBaseDirs();
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    // Try completed checkpoint first, then in-flight
    let checkpoint = await readJsonFile<any>(path.join(stateDir, 'completed', `${runId}.json`));
    let status: 'completed' | 'failed' = 'completed';
    if (!checkpoint) {
      checkpoint = await readJsonFile<any>(path.join(stateDir, `${runId}.checkpoint`));
      status = 'completed'; // in-flight
    }
    if (checkpoint && checkpoint.phase === 'failed') status = 'failed';

    if (!checkpoint) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const [manifest, events] = await Promise.all([
      readJsonFile<any>(path.join(samplesDir, 'runs', `${runId}.json`)),
      readNdjsonFile(path.join(tracesDir, `${runId}.ndjson`)),
    ]);

    const totalTokens = events.reduce((sum, e) => {
      const usage = e.data?.tokenUsage as any;
      return sum + (usage?.totalTokens ?? 0);
    }, 0);

    const run: ReplayRunSummary = {
      runId,
      agentId: checkpoint.agentId ?? manifest?.agentId ?? 'unknown',
      missionId: checkpoint.missionId ?? manifest?.missionId,
      goal: checkpoint.context?.goal ?? manifest?.goal,
      model: manifest?.model,
      status,
      phase: checkpoint.phase,
      startedAt: manifest?.timestamp ?? checkpoint.timestamp,
      completedAt:
        checkpoint.phase === 'completed' || checkpoint.phase === 'failed'
          ? checkpoint.timestamp
          : undefined,
      totalEvents: events.length,
      totalTokens,
      durationMs: checkpoint.totalDurationMs ?? 0,
      stepCount: checkpoint.stepNumber ?? 0,
    };

    res.json({ run, checkpoint: { ...checkpoint, messages: undefined } });
  });

  // ── Get trace events for a run ─────────────────────────────────────────
  router.get('/api/replay/runs/:runId/events', async (req, res) => {
    const { tracesDir } = findBaseDirs();
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    const events = await readNdjsonFile(path.join(tracesDir, `${runId}.ndjson`));

    const typeFilter = req.query.type as string | undefined;
    const filtered = typeFilter ? events.filter((e) => e.type === typeFilter) : events;

    res.json({ events: filtered, total: filtered.length });
  });

  // ── Get checkpoint (full conversation history) ─────────────────────────
  router.get('/api/replay/runs/:runId/checkpoint', async (req, res) => {
    const { stateDir } = findBaseDirs();
    const { runId } = req.params;
    if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid runId format' });

    let checkpoint = await readJsonFile<any>(path.join(stateDir, 'completed', `${runId}.json`));
    if (!checkpoint) {
      checkpoint = await readJsonFile<any>(path.join(stateDir, `${runId}.checkpoint`));
    }

    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    res.json(checkpoint);
  });

  return router;
}
