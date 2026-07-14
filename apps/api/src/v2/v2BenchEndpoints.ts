/**
 * V2 benchmark endpoints — Layer B live benchmark harness.
 *
 * These routes provide a minimal in-memory run/effect ledger so that the
 * bench-v2-live.ts harness can seed runs, wait for drain, and audit anomalies.
 * They are intentionally simple and isolated from production durable execution.
 */
import { Router, type Request, type Response } from 'express';

interface Run {
  runId: string;
  tenantId: string;
  intentHash: string;
  state: 'pending' | 'claimed' | 'completed' | 'STALE_COMPLETED';
  claimedBy?: string[];
}

interface Effect {
  runId: string;
  tenantId: string;
  status: 'PENDING' | 'APPLIED' | 'RECONCILED';
}

const runs = new Map<string, Run>();
const effects = new Map<string, Effect>();

export function createV2BenchRouter(): Router {
  const router = Router();

  router.post('/runs/batch', (req: Request, res: Response) => {
    const batch = Array.isArray(req.body) ? req.body : [];
    for (const item of batch) {
      if (!item || typeof item.runId !== 'string') continue;
      runs.set(item.runId, {
        runId: item.runId,
        tenantId: String(item.tenantId ?? 'unknown'),
        intentHash: String(item.intentHash ?? ''),
        state: 'pending',
        claimedBy: [],
      });
    }
    res.json({ ok: true, inserted: batch.length });
  });

  router.get('/runs/status', (_req: Request, res: Response) => {
    let pending = 0;
    let completed = 0;
    for (const r of runs.values()) {
      if (r.state === 'pending') pending++;
      if (r.state === 'completed' || r.state === 'STALE_COMPLETED') completed++;
    }
    res.json({ pending, completed, total: runs.size });
  });

  router.get('/runs', (_req: Request, res: Response) => {
    res.json(Array.from(runs.values()));
  });

  router.get('/effects', (_req: Request, res: Response) => {
    res.json(Array.from(effects.values()));
  });

  router.get('/bench/anomalies', (_req: Request, res: Response) => {
    const runById = new Map<string, Run>();
    for (const r of runs.values()) runById.set(r.runId, r);

    const claims = new Map<string, Set<string>>();
    for (const r of runs.values()) {
      for (const holder of r.claimedBy ?? []) {
        if (!claims.has(r.runId)) claims.set(r.runId, new Set());
        claims.get(r.runId)!.add(holder);
      }
    }

    let duplicateClaims = 0;
    for (const holders of claims.values()) {
      if (holders.size > 1) duplicateClaims++;
    }

    let tenantLeaks = 0;
    let unknownEffects = 0;
    for (const e of effects.values()) {
      const run = runById.get(e.runId);
      if (!run) {
        unknownEffects++;
        continue;
      }
      if (run.tenantId !== e.tenantId) tenantLeaks++;
    }

    const staleCompletions = Array.from(runs.values()).filter(
      (r) => r.state === 'STALE_COMPLETED',
    ).length;
    const reconciledEffects = Array.from(effects.values()).filter(
      (e) => e.status === 'RECONCILED',
    ).length;

    res.json({
      ok: true,
      duplicateClaims,
      staleCompletions,
      tenantLeaks,
      unknownEffects,
      reconciledEffects,
    });
  });

  return router;
}
