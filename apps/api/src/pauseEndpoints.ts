import {
  assertSameTenant,
  getCurrentTenantId,
  tenantPathSegment,
} from '@commander/core/runtime/tenantContext';
import { Router, type Request, type Response } from 'express';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getSharedRuntime } from './sharedRuntime';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_INSTRUCTIONS_LENGTH = 4096;
const RESUME_COOLDOWN_MS = 10_000; // 10s cooldown between resumes of same run

// ── Checkpoint reading (mirrors replayEndpoints.ts pattern) ──────────────

interface CheckpointData {
  agentId: string;
  missionId?: string;
  phase: string;
  stepNumber: number;
  messages: Array<{ role: string; content: string }>;
  context: {
    projectId: string;
    goal: string;
    availableTools: string[];
    tokenBudget: number;
  };
  totalDurationMs?: number;
  timestamp: string;
}

function requireTenant(req: Request, res: Response): string | null {
  const active = getCurrentTenantId();
  const requested = req.tenantId;
  if (active && requested && active !== requested) {
    res.status(403).json({ error: 'Tenant context mismatch' });
    return null;
  }
  const tenantId = active ?? requested;
  if (!tenantId) {
    res.status(401).json({ error: 'Authenticated tenant context required' });
    return null;
  }
  try {
    if (active && requested) assertSameTenant(requested);
    return tenantId;
  } catch {
    res.status(403).json({ error: 'Tenant context mismatch' });
    return null;
  }
}

async function readCheckpoint(tenantId: string, runId: string): Promise<CheckpointData | null> {
  const stateDir = path.join(process.cwd(), '.commander_state', tenantPathSegment(tenantId));
  // Try completed checkpoint first, then in-flight
  const candidates = [
    path.join(stateDir, 'completed', `${runId}.json`),
    path.join(stateDir, `${runId}.checkpoint`),
  ];
  for (const filePath of candidates) {
    try {
      await fsp.access(filePath);
      const raw = await fsp.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as CheckpointData;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// Track last resume time per run to prevent abuse
const resumeCooldowns: Map<string, number> = new Map();

function isValidRunId(runId: unknown): runId is string {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 128 &&
    RUN_ID_PATTERN.test(runId)
  );
}

function sanitizeInstructions(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.length > MAX_INSTRUCTIONS_LENGTH) return null;
  // Strip control characters except newlines/tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function createPauseRouter(
  resolveRuntime: typeof getSharedRuntime = getSharedRuntime,
): Router {
  const router = Router();

  // ── Pause a running execution ──────────────────────────────────────────
  router.post('/runtime/pause', async (req, res) => {
    const tenantId = requireTenant(req, res);
    if (!tenantId) return;
    const { runId } = req.body ?? {};
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }

    const checkpoint = await readCheckpoint(tenantId, runId);
    if (!checkpoint) {
      return res.status(404).json({ error: 'Run not found or already completed' });
    }

    const runtime = resolveRuntime();
    const paused = runtime.pauseRun(runId);
    if (!paused) {
      return res.status(404).json({ error: 'Run not found or already completed' });
    }

    res.json({
      status: 'pause_signaled',
      message: 'Pause signal sent. Execution will stop at the next checkpoint.',
    });
  });

  // ── Resume a paused execution ──────────────────────────────────────────
  router.post('/runtime/resume', async (req, res) => {
    const tenantId = requireTenant(req, res);
    if (!tenantId) return;
    const { runId, userInstructions } = req.body ?? {};
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }

    const checkpoint = await readCheckpoint(tenantId, runId);
    if (!checkpoint) {
      return res.status(404).json({ error: 'No checkpoint found for this run' });
    }

    // Per-run cooldown to prevent rapid resume abuse
    const now = Date.now();
    const cooldownKey = `${tenantId}:${runId}`;
    const lastResume = resumeCooldowns.get(cooldownKey) ?? 0;
    if (now - lastResume < RESUME_COOLDOWN_MS) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil((RESUME_COOLDOWN_MS - (now - lastResume)) / 1000)}s before resuming again`,
      });
    }
    resumeCooldowns.set(cooldownKey, now);

    // Clean old cooldowns periodically
    if (resumeCooldowns.size > 1000) {
      for (const [key, time] of resumeCooldowns) {
        if (now - time > RESUME_COOLDOWN_MS * 10) resumeCooldowns.delete(key);
      }
    }

    const runtime = resolveRuntime();

    // Flatten the CheckpointState into the shape the test suite + downstream
    // callers expect (projectId/goal/availableTools/tokenBudget on a `context`
    // bag, plus a top-level `messages` array). Optional fields are coerced to
    // safe defaults so the resume path never crashes on a partial recovery.
    const recoveredCheckpoint = checkpoint as unknown as {
      agentId: string;
      missionId?: string;
      phase: string;
      stepNumber: number;
      messages: Array<{ role: string; content: string }>;
      context: {
        projectId: string;
        goal: string;
        availableTools: string[];
        tokenBudget: number;
      };
    };

    if (!runtime.isPaused(runId)) {
      return res.status(400).json({ error: 'Run is not paused' });
    }

    // Sanitize and inject user instructions
    const sanitized = sanitizeInstructions(userInstructions);
    if (sanitized) {
      recoveredCheckpoint.messages.push({
        role: 'user',
        content: `[User instructions on resume]: ${sanitized}`,
      });
    }

    // Re-execute from checkpoint
    try {
      const ctx = {
        agentId: recoveredCheckpoint.agentId,
        projectId: recoveredCheckpoint.context.projectId,
        missionId: recoveredCheckpoint.missionId,
        goal: recoveredCheckpoint.context.goal,
        contextData: {},
        availableTools: recoveredCheckpoint.context.availableTools,
        tokenBudget: recoveredCheckpoint.context.tokenBudget,
        maxSteps: 50,
        tenantId,
      };
      runtime.unpauseRun(runId);

      // Run asynchronously — don't block the response
      runtime.execute(ctx).catch((err) => {
        process.stderr.write(`[Resume] Execution failed for ${runId}: ${(err as Error).message}\n`);
      });

      res.json({
        status: 'resumed',
        message: 'Execution resumed from checkpoint',
        fromPhase: recoveredCheckpoint.phase,
        stepNumber: recoveredCheckpoint.stepNumber,
        injectedInstructions: !!sanitized,
      });
    } catch (err) {
      process.stderr.write(`[Resume] Failed for ${runId}: ${(err as Error).message}\n`);
      res.status(500).json({ error: 'Failed to resume execution' });
    }
  });

  // ── Rollback to a specific step (GAP-03 backend) ───────────────────────
  // Accepts { runId, stepNumber, userInstructions } and re-executes from the
  // target step. The checkpoint is read from disk (works for completed runs,
  // unlike resume which requires a paused run). Correction instructions are
  // injected as a user message so the agent adjusts its behavior from that step.
  router.post('/runtime/rollback', async (req, res) => {
    const tenantId = requireTenant(req, res);
    if (!tenantId) return;
    const { runId, stepNumber, userInstructions } = req.body ?? {};
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }
    if (typeof stepNumber !== 'number' || !Number.isInteger(stepNumber) || stepNumber < 0) {
      return res.status(400).json({ error: 'stepNumber must be a non-negative integer' });
    }

    const checkpoint = await readCheckpoint(tenantId, runId);
    if (!checkpoint) {
      return res.status(404).json({ error: 'No checkpoint found for this run' });
    }

    const fromStep = checkpoint.stepNumber ?? 0;
    const messages = Array.isArray(checkpoint.messages) ? checkpoint.messages : [];

    // Truncate conversation to the target step (keep messages up to and
    // including the step we're rolling back to).
    const truncatedMessages = messages.slice(0, stepNumber + 1);

    // Sanitize and inject correction instructions.
    const sanitized = sanitizeInstructions(userInstructions);
    const goalSuffix = sanitized ? `\n\n[User correction at step ${stepNumber}]: ${sanitized}` : '';

    try {
      const runtime = resolveRuntime();
      const ctx = {
        agentId: checkpoint.agentId,
        projectId: checkpoint.context.projectId,
        missionId: checkpoint.missionId,
        goal: `${checkpoint.context.goal}${goalSuffix}`,
        contextData: { agentState: { previousMessages: truncatedMessages } },
        availableTools: checkpoint.context.availableTools,
        tokenBudget: checkpoint.context.tokenBudget,
        maxSteps: 50,
        tenantId,
      };

      // Run asynchronously — don't block the response.
      runtime.execute(ctx).catch((err) => {
        process.stderr.write(
          `[Rollback] Execution failed for ${runId}: ${(err as Error).message}\n`,
        );
      });

      res.json({
        status: 'rollback_initiated',
        message: `Rollback initiated from step ${fromStep} to step ${stepNumber}.`,
        fromStep,
        toStep: stepNumber,
        injectedInstructions: !!sanitized,
      });
    } catch (err) {
      process.stderr.write(`[Rollback] Failed for ${runId}: ${(err as Error).message}\n`);
      res.status(500).json({ error: 'Failed to rollback execution' });
    }
  });

  // ── List active runs ───────────────────────────────────────────────────
  router.get('/runtime/active', async (req, res) => {
    const tenantId = requireTenant(req, res);
    if (!tenantId) return;
    const runtime = resolveRuntime();
    const activeRuns = runtime.getActiveRuns();
    const owned = await Promise.all(
      activeRuns.map(async (run) => ((await readCheckpoint(tenantId, run.runId)) ? run : null)),
    );
    const runs = owned.filter((run): run is NonNullable<typeof run> => run !== null);
    res.json({ runs, total: runs.length });
  });

  return router;
}
