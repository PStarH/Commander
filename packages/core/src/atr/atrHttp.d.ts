/**
 * ATR HTTP router — Settlement Layer observability API.
 *
 * Standalone module. Does NOT modify httpServer.ts. Operators can integrate
 * by calling `handleAtrHttpRequest(req, res, deps)` from their existing
 * server's `handleApiRequest` switch.
 *
 * Endpoints (all under /api/v1/atr, all require Bearer auth + tenant
 * resolution upstream of this router):
 *   GET    /api/v1/atr/runs                  — list runs (filter ?state=...)
 *   GET    /api/v1/atr/runs/:runId           — get one run with all actions
 *   POST   /api/v1/atr/runs                  — start a new run (beginRun)
 *   POST   /api/v1/atr/runs/:runId/commit    — commit run
 *   POST   /api/v1/atr/runs/:runId/abort     — abort and compensate
 *   POST   /api/v1/atr/runs/:runId/kill      — force release without compensation
 *   GET    /api/v1/atr/audit                 — recent actions across all runs (audit)
 *   GET    /api/v1/atr/policy/decisions      — recent policy decisions (?runId=&limit=)
 *
 * Auth + rate limiting is the host server's responsibility. This module
 * assumes the request is already authenticated and that `deps.tenantId`
 * has been resolved from the API key.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { ExecutionScheduler } from './scheduler';
export interface AtrHttpDeps {
    scheduler: ExecutionScheduler;
    /**
     * Resolve tenantId from the authenticated request. Returns undefined for
     * single-tenant deployments. MUST come from server-side auth, never from
     * the request body.
     */
    resolveTenant: (req: IncomingMessage) => string | undefined;
}
export interface AtrHttpResult {
    handled: boolean;
    status: number;
}
export declare function handleAtrHttpRequest(req: IncomingMessage, res: ServerResponse, deps: AtrHttpDeps, segments: string[], queryStr: string, opts: {
    maxBodyBytes: number;
}): Promise<AtrHttpResult>;
export declare const ATR_HTTP_ROUTES: readonly ["GET /api/v1/atr/runs", "GET /api/v1/atr/runs/:runId", "POST /api/v1/atr/runs", "POST /api/v1/atr/runs/:runId/commit", "POST /api/v1/atr/runs/:runId/abort", "POST /api/v1/atr/runs/:runId/kill", "GET /api/v1/atr/audit", "GET /api/v1/atr/policy/decisions"];
//# sourceMappingURL=atrHttp.d.ts.map