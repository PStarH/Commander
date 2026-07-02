/**
 * reportingEndpoints — REST API for the builtin-reporting plugin.
 *
 * Control plane:
 *   GET  /api/reporting/status   — plugin registration + enable state
 *   POST /api/reporting/enable   — enable the builtin-reporting plugin
 *   POST /api/reporting/disable  — disable the builtin-reporting plugin
 *
 * Data plane (works regardless of plugin enable state):
 *   POST /api/reporting/render   — render a WarRoom HTML report
 *
 * Note: the existing POST /api/runtime/render-report endpoint in
 * runtimeEndpoints.ts remains the primary rendering entry point and
 * imports directly from @commander/core. This router adds plugin
 * lifecycle control + a convenience render endpoint.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';
import { getHookManager, getHTMLReportRenderer, createWarRoomHTMLReport } from '@commander/core';

const REPORTING_PLUGIN_NAME = 'builtin-reporting';

const renderSchema = z.object({
  projectName: z.string().min(1),
  operationCodename: z.string().min(1),
  health: z.enum(['GREEN', 'AMBER', 'RED']).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  narrative: z.string().optional(),
  topAgents: z
    .array(
      z.object({
        name: z.string(),
        completed: z.number(),
      }),
    )
    .optional(),
  missionSummary: z.record(z.string(), z.number()).optional(),
  recentEvents: z
    .array(
      z.object({
        timestamp: z.string(),
        level: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export function createReportingRouter(): Router {
  const router = Router();

  // ── Control plane ────────────────────────────────────────────────────

  router.get('/api/reporting/status', (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      const registered = hm.hasPlugin(REPORTING_PLUGIN_NAME);
      const enabled = hm.isEnabled(REPORTING_PLUGIN_NAME);
      res.json({
        plugin: REPORTING_PLUGIN_NAME,
        registered,
        enabled,
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/reporting/enable', (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(REPORTING_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Reporting plugin is not registered' });
        return;
      }
      const ok = hm.enable(REPORTING_PLUGIN_NAME);
      res.json({ plugin: REPORTING_PLUGIN_NAME, enabled: true, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  router.post('/api/reporting/disable', (_req: Request, res: Response) => {
    try {
      const hm = getHookManager();
      if (!hm.hasPlugin(REPORTING_PLUGIN_NAME)) {
        res.status(404).json({ error: 'Reporting plugin is not registered' });
        return;
      }
      const ok = hm.disable(REPORTING_PLUGIN_NAME);
      res.json({ plugin: REPORTING_PLUGIN_NAME, enabled: false, ok });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── Data plane ───────────────────────────────────────────────────────

  router.post(
    '/api/reporting/render',
    validateBody(renderSchema),
    (req: Request, res: Response) => {
      try {
        const report = createWarRoomHTMLReport({
          projectName: req.body.projectName,
          operationCodename: req.body.operationCodename,
          health: req.body.health ?? 'GREEN',
          metrics: req.body.metrics ?? {},
          narrative: req.body.narrative ?? '',
          topAgents: req.body.topAgents ?? [],
          missionSummary: req.body.missionSummary ?? {},
          recentEvents: req.body.recentEvents,
        });
        const renderer = getHTMLReportRenderer();
        const html = renderer.render(report);
        res.type('text/html').send(html);
      } catch (error) {
        res.status(500).json({ error: toErrorMessage(error) });
      }
    },
  );

  return router;
}
