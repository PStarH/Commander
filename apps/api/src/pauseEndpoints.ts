import { Router } from 'express';
import { getSharedRuntime } from './sharedRuntime';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_INSTRUCTIONS_LENGTH = 4096;
const RESUME_COOLDOWN_MS = 10_000; // 10s cooldown between resumes of same run

// Track last resume time per run to prevent abuse
const resumeCooldowns: Map<string, number> = new Map();

function isValidRunId(runId: unknown): runId is string {
  return typeof runId === 'string' && runId.length > 0 && runId.length < 128 && RUN_ID_PATTERN.test(runId);
}

function sanitizeInstructions(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  if (input.length > MAX_INSTRUCTIONS_LENGTH) return null;
  // Strip control characters except newlines/tabs
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function createPauseRouter(): Router {
  const router = Router();

  // ── Pause a running execution ──────────────────────────────────────────
  router.post('/runtime/pause', (req, res) => {
    const { runId } = req.body ?? {};
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }

    const runtime = getSharedRuntime();
    const paused = runtime.pauseRun(runId);
    if (!paused) {
      return res.status(404).json({ error: 'Run not found or already completed' });
    }

    res.json({ status: 'pause_signaled', message: 'Pause signal sent. Execution will stop at the next checkpoint.' });
  });

  // ── Resume a paused execution ──────────────────────────────────────────
  router.post('/runtime/resume', async (req, res) => {
    const { runId, userInstructions } = req.body ?? {};
    if (!isValidRunId(runId)) {
      return res.status(400).json({ error: 'runId is required and must be alphanumeric' });
    }

    // Per-run cooldown to prevent rapid resume abuse
    const now = Date.now();
    const lastResume = resumeCooldowns.get(runId) ?? 0;
    if (now - lastResume < RESUME_COOLDOWN_MS) {
      return res.status(429).json({ error: `Please wait ${Math.ceil((RESUME_COOLDOWN_MS - (now - lastResume)) / 1000)}s before resuming again` });
    }
    resumeCooldowns.set(runId, now);

    // Clean old cooldowns periodically
    if (resumeCooldowns.size > 1000) {
      for (const [key, time] of resumeCooldowns) {
        if (now - time > RESUME_COOLDOWN_MS * 10) resumeCooldowns.delete(key);
      }
    }

    const runtime = getSharedRuntime();
    const checkpoint = runtime.resume(runId);

    if (!checkpoint) {
      return res.status(404).json({ error: 'No checkpoint found for this run' });
    }

    if (!runtime.isPaused(runId)) {
      return res.status(400).json({ error: 'Run is not paused' });
    }

    // Sanitize and inject user instructions
    const sanitized = sanitizeInstructions(userInstructions);
    if (sanitized) {
      checkpoint.messages.push({
        role: 'user',
        content: `[User instructions on resume]: ${sanitized}`,
      });
    }

    // Re-execute from checkpoint
    try {
      const ctx = {
        agentId: checkpoint.agentId,
        projectId: checkpoint.context.projectId,
        missionId: checkpoint.missionId,
        goal: checkpoint.context.goal,
        contextData: {},
        availableTools: checkpoint.context.availableTools,
        tokenBudget: checkpoint.context.tokenBudget,
        maxSteps: 50,
      };
      runtime.unpauseRun(runId);

      // Run asynchronously — don't block the response
      runtime.execute(ctx).catch((err) => {
        process.stderr.write(`[Resume] Execution failed for ${runId}: ${(err as Error).message}\n`);
      });

      res.json({
        status: 'resumed',
        message: 'Execution resumed from checkpoint',
        fromPhase: checkpoint.phase,
        stepNumber: checkpoint.stepNumber,
        injectedInstructions: !!sanitized,
      });
    } catch (err) {
      process.stderr.write(`[Resume] Failed for ${runId}: ${(err as Error).message}\n`);
      res.status(500).json({ error: 'Failed to resume execution' });
    }
  });

  // ── List active runs ───────────────────────────────────────────────────
  router.get('/runtime/active', (_req, res) => {
    const runtime = getSharedRuntime();
    const runs = runtime.getActiveRuns();
    res.json({ runs, total: runs.length });
  });

  return router;
}
