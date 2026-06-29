/**
 * Observability HTTP endpoints for the War Room.
 *
 * Mounted at /api/v1/observability. Delegates to the shared handler in
 * packages/core/src/observability/httpApi.ts so the War Room and the core
 * runtime HTTP server expose the same data model (TimelineView, CostReport,
 * DecisionNode, ReplayResult, span tree).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import * as path from 'path';
import {
  handleObservabilityRequest,
  type ObservabilityDeps,
  OBSERVABILITY_HTTP_ROUTES,
} from '@commander/core';
import { getTraceRecorder, PersistentTraceStore } from '@commander/core/runtime';

const traceStore = new PersistentTraceStore(path.join(process.cwd(), '.commander_traces'));
// In-memory recorder is empty in a pure observability process; the handler
// falls back to reading the on-disk NDJSON via PersistentTraceStore.
const recorder = getTraceRecorder(traceStore);
const resolveTenant = (_req: IncomingMessage): string | undefined => undefined;

const deps: ObservabilityDeps = { recorder, traceStore, resolveTenant };

const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;
function isValidRunId(runId: string): boolean {
  return (
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length < 200 &&
    RUN_ID_PATTERN.test(runId)
  );
}

export function createObservabilityRouter(): Router {
  const router = Router();

  router.all(/.*/, async (req: Request, res: Response, _next: NextFunction) => {
    const rel = req.path.replace(/^\/+/, '');
    const segments = rel.length === 0 ? [] : rel.split('/').filter(Boolean);

    // Defense in depth: handler does not validate runId, so reject traversal-style values here.
    if (segments[0] === 'runs' && segments.length >= 2 && !isValidRunId(segments[1]!)) {
      res.status(400).json({ error: 'Invalid runId format' });
      return;
    }

    try {
      const result = await handleObservabilityRequest(
        req,
        res,
        deps,
        segments,
        req.url.split('?')[1] ?? '',
      );
      if (!result.handled && !res.headersSent) {
        res.status(404).json({ error: 'Not found' });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', detail: (err as Error)?.message });
      }
    }
  });

  return router;
}

export { OBSERVABILITY_HTTP_ROUTES };
