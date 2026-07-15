/**
 * WS3 — Enterprise API surface freeze.
 *
 * Two middlewares cooperate to enforce the §2/§8 invariants of
 * spec/ws3-gateway-v1-only.md:
 *
 *   1. `enterpriseRouteFreeze` — in the enterprise profile, any product route
 *      outside `/v1` (and outside the ops allowlist) is rejected with 410 Gone
 *      before it reaches a business handler. The response carries
 *      `x-legacy: true` and a `Deprecation` header so clients can migrate.
 *   2. `legacyHeader` — in the standard profile the same routes are still
 *      served (for local/dev compatibility) but tagged `x-legacy: true` so the
 *      deprecation is visible. In the enterprise profile it is a no-op for
 *      reachable paths (the freeze already 410'd the legacy ones, and `/v1`/
 *      ops paths must not be marked legacy).
 *
 * The ops allowlist (`/health`, `/ready`, `/metrics`, `/system`, `/health/detailed`)
 * is never legacy and never frozen — these are infrastructure probes, not
 * product routes. `/v1` is the enterprise product surface.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isEnterpriseProfile } from './profileSignal';

/**
 * Paths that remain reachable in the enterprise profile even though they are
 * not under `/v1`. These are operational/infrastructure endpoints, not product
 * routes, so freezing them would break liveness/readiness/metrics scraping.
 */
const OPS_PREFIXES = ['/health', '/ready', '/metrics', '/system'];

/**
 * Whether a request path is reachable under the enterprise profile.
 *
 * `/v1` (the frozen product surface) and the ops allowlist pass; every other
 * product path is rejected. The check is prefix-based so sub-paths
 * (`/v1/runs/:id/events`, `/health/detailed`) are covered.
 */
export function isEnterpriseReachablePath(path: string): boolean {
  if (path === '/v1' || path.startsWith('/v1/')) return true;
  return OPS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Enterprise-profile route freeze. Mount this BEFORE product routers. In the
 * enterprise profile it short-circuits any non-reachable path with 410 Gone.
 * In the standard profile it is a pass-through (the x-legacy header is added
 * separately by `legacyHeader`).
 */
export function enterpriseRouteFreeze(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isEnterpriseProfile()) return next();
    if (isEnterpriseReachablePath(req.path)) return next();
    // Frozen legacy product route — reject before any handler runs.
    res.set('x-legacy', 'true');
    res.set('Deprecation', 'true');
    res.status(410).json({
      error: {
        code: 'GONE',
        message:
          'This route is frozen in the enterprise profile. Use the /v1 API surface (see /v1/openapi.json).',
      },
    });
  };
}

/**
 * x-legacy response header injector for the standard profile.
 *
 * In the standard profile, non-`/v1` product routes are still served for dev
 * compatibility but tagged `x-legacy: true` to signal deprecation. `/v1` and
 * ops paths are never tagged. In the enterprise profile this is a no-op: the
 * freeze already 410'd legacy routes, and tagging reachable paths would be
 * incorrect.
 */
export function legacyHeader(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // In enterprise profile the freeze handles legacy marking; do not tag
    // reachable /v1 or ops paths here.
    if (!isEnterpriseProfile() && !isEnterpriseReachablePath(req.path)) {
      // Set synchronously before next(): the header value depends only on the
      // request path (known at middleware time), so it can be applied ahead of
      // the handler. Listening on 'finish' would fire after headers are sent.
      res.setHeader('x-legacy', 'true');
    }
    next();
  };
}
