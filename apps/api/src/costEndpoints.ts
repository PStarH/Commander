import { Router } from 'express';
import { getTokenSentinel } from '@commander/core';
import type { CostSummary, CostRecord, BudgetAlert } from '@commander/core';

export function createCostRouter(): Router {
  const router = Router();

  // ── Cost summary (total, per-model, per-agent) ─────────────────────────
  router.get('/api/cost/summary', (_req, res) => {
    const sentinel = getTokenSentinel();
    const summary: CostSummary = sentinel.getCostSummary();
    res.json(summary);
  });

  // ── Cost records (recent LLM calls) ────────────────────────────────────
  router.get('/api/cost/records', (req, res) => {
    const sentinel = getTokenSentinel();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const rawRunId = req.query.runId as string | undefined;
    const runId =
      rawRunId && /^[a-zA-Z0-9_-]+$/.test(rawRunId) && rawRunId.length < 128 ? rawRunId : undefined;

    let records: CostRecord[] = sentinel.getCosts(runId);
    // Sort newest first, apply limit
    records = records.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);

    res.json({ records, total: records.length });
  });

  // ── Budget status (monthly usage + alerts) ─────────────────────────────
  router.get('/api/cost/budget', (_req, res) => {
    const sentinel = getTokenSentinel();
    const monthlyUsed = sentinel.getMonthlyCostUsd();
    const monthlyLimit = sentinel.getMonthlyLimitUsd();
    const alerts: BudgetAlert[] = sentinel.getAlerts();

    res.json({
      monthlyUsed,
      monthlyLimit,
      usagePercent: monthlyLimit > 0 ? Math.round((monthlyUsed / monthlyLimit) * 100) : 0,
      alertCount: alerts.length,
      alerts: alerts.slice(-20), // Last 20 alerts
    });
  });

  return router;
}
