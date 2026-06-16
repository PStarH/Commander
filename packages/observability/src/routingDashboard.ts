/**
 * P5: Live routing dashboard HTTP handler.
 *
 * Exposes a JSON snapshot of the ε-greedy exploration log at
 * `GET /api/v1/topology/exploration` so operators can watch the
 * router in real time. Sub-routes provide focused views:
 *
 *   GET /api/v1/topology/exploration               (full snapshot, default)
 *   GET /api/v1/topology/exploration/snapshot      (totals + tenants + histogram)
 *   GET /api/v1/topology/exploration/events        (last-N events, default 100)
 *   GET /api/v1/topology/exploration/tenants       (per-tenant aggregates)
 *   GET /api/v1/topology/exploration/histogram     (divergence histogram only)
 *
 * Query parameters (all routes):
 *   - tenantId: filter to a single tenant
 *   - since:    ISO timestamp lower bound (inclusive)
 *   - limit:    cap on returned events (default 100, max 1000)
 *   - divergedOnly: restrict to events where ε-greedy actually diverged
 *
 * Auth + rate limiting are enforced upstream by CommanderHttpServer
 * (Bearer token + per-IP token bucket). Tenant resolution is also
 * upstream via `resolveTenant`; when a tenant-resolved key is in play
 * the response is auto-filtered to that tenant so cross-tenant data
 * is not leaked.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ExplorationEventLog,
  ExplorationEventLogFilter,
  ExplorationSnapshot,
} from '@commander/core';
import type { EpsilonStore } from '@commander/core';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export interface RoutingDashboardDeps {
  eventLog: ExplorationEventLog;
  /**
   * P6: shared ε-greedy override store. Injected by the application
   * (typically `ultimateOrchestrator.getEpsilonStore()`). Required
   * for PUT/GET/DELETE on `/epsilon`. If omitted, those routes
   * return 503.
   */
  epsilonStore?: EpsilonStore;
  /**
   * Resolve the caller tenant from the Authorization header. The HTTP
   * server supplies the same resolver it uses for the rest of the API.
   * When the resolved tenant is set, the snapshot is auto-filtered to
   * that tenant regardless of the `tenantId` query param, so a tenant
   * key can never see another tenant's data.
   */
  resolveTenant: (req: IncomingMessage) => string | undefined;
}

export interface RoutingDashboardResult {
  handled: boolean;
  status: number;
}

export const ROUTING_DASHBOARD_ROUTES = [
  'GET /api/v1/topology/exploration',
  'GET /api/v1/topology/exploration/snapshot',
  'GET /api/v1/topology/exploration/events',
  'GET /api/v1/topology/exploration/tenants',
  'GET /api/v1/topology/exploration/histogram',
  'GET /api/v1/topology/exploration/epsilon',
  'PUT /api/v1/topology/exploration/epsilon',
  'DELETE /api/v1/topology/exploration/epsilon',
] as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseFilter(req: IncomingMessage, q: URLSearchParams): ExplorationEventLogFilter {
  const filter: ExplorationEventLogFilter = {
    limit: parsePositiveInt(q.get('limit'), DEFAULT_LIMIT, MAX_LIMIT),
  };
  const tenantId = q.get('tenantId') ?? undefined;
  if (tenantId) filter.tenantId = tenantId;
  const since = q.get('since');
  if (since) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) {
      throw new HttpDashboardError(400, `Invalid 'since' query param: ${since}`);
    }
    filter.since = since;
  }
  if (q.get('divergedOnly') === 'true' || q.get('divergedOnly') === '1') {
    filter.divergedOnly = true;
  }
  return filter;
}

class HttpDashboardError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function applyAuthTenant(
  req: IncomingMessage,
  filter: ExplorationEventLogFilter,
  resolveTenant: RoutingDashboardDeps['resolveTenant'],
): ExplorationEventLogFilter {
  const authTenant = resolveTenant(req);
  if (authTenant === undefined) return filter;
  // Auth-tenant takes precedence over query-param tenant. A tenant key
  // cannot widen the view by supplying a different `tenantId` query.
  if (filter.tenantId !== undefined && filter.tenantId !== authTenant) {
    throw new HttpDashboardError(
      403,
      `Forbidden: API key belongs to tenant '${authTenant}', ` +
        `cannot request data for tenant '${filter.tenantId}'.`,
    );
  }
  return { ...filter, tenantId: authTenant };
}

export async function handleRoutingDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutingDashboardDeps,
  segments: string[],
  queryStr: string,
): Promise<RoutingDashboardResult> {
  const method = req.method ?? 'GET';

  try {
    const q = new URLSearchParams(queryStr);

    // P6: PUT/DELETE /epsilon are method-routed, not GET. Handle them
    // before the GET-only short-circuit below.
    if (segments[0] === 'exploration' && segments[1] === 'epsilon') {
      if (method === 'PUT') return await handleEpsilonPut(req, res, deps, q);
      if (method === 'DELETE') return handleEpsilonDelete(req, res, deps, q);
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed. Use GET, PUT, or DELETE on /epsilon.' });
        return { handled: true, status: 405 };
      }
      // fall through to the GET dispatch below
    } else if (method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return { handled: true, status: 405 };
    }

    const filter = applyAuthTenant(req, parseFilter(req, q), deps.resolveTenant);

    // Sub-route dispatch. The base path `/api/v1/topology/exploration`
    // returns the full snapshot; the suffixes return focused views.
    const sub = segments[1] ?? 'snapshot';

    switch (sub) {
      case 'snapshot':
      case undefined: {
        const snapshot: ExplorationSnapshot = deps.eventLog.getSnapshot(filter);
        sendJson(res, 200, snapshot);
        return { handled: true, status: 200 };
      }
      case 'events': {
        const snapshot = deps.eventLog.getSnapshot(filter);
        sendJson(res, 200, {
          count: snapshot.recentEvents.length,
          events: snapshot.recentEvents,
          truncated: snapshot.truncated,
          totals: snapshot.totals,
          globalStats: snapshot.globalStats,
        });
        return { handled: true, status: 200 };
      }
      case 'tenants': {
        const snapshot = deps.eventLog.getSnapshot(filter);
        sendJson(res, 200, {
          count: snapshot.tenants.length,
          tenants: snapshot.tenants,
          totals: snapshot.totals,
          globalStats: snapshot.globalStats,
        });
        return { handled: true, status: 200 };
      }
      case 'histogram': {
        const snapshot = deps.eventLog.getSnapshot(filter);
        sendJson(res, 200, {
          count: snapshot.divergenceHistogram.reduce((s, b) => s + b.count, 0),
          buckets: snapshot.divergenceHistogram,
          totals: snapshot.totals,
          globalStats: snapshot.globalStats,
        });
        return { handled: true, status: 200 };
      }
      case 'epsilon': {
        // P6: per-tenant ε-greedy override store. GET lists, PUT sets,
        // DELETE clears. Auth-tenant scoping applies.
        if (method !== 'GET') {
          sendJson(res, 405, {
            error: 'Method not allowed. Use GET to list, PUT to set, DELETE to clear.',
          });
          return { handled: true, status: 405 };
        }
        if (!deps.epsilonStore) {
          sendJson(res, 503, { error: 'Epsilon store not initialized on this server.' });
          return { handled: true, status: 503 };
        }
        const authTenant = deps.resolveTenant(req);
        const requested = q.get('tenantId') ?? undefined;
        if (requested) {
          // Single-tenant lookup
          if (authTenant !== undefined && requested !== authTenant) {
            sendJson(res, 403, {
              error: `Forbidden: cannot view override for tenant '${requested}'.`,
            });
            return { handled: true, status: 403 };
          }
          const entry = deps.epsilonStore.get(requested);
          sendJson(res, 200, {
            override: entry ?? null,
            tenantId: requested,
          });
          return { handled: true, status: 200 };
        }
        // List all overrides
        let entries = deps.epsilonStore.list();
        if (authTenant !== undefined) {
          // Tenant caller sees only their own override
          entries = entries.filter((e) => e.tenantId === authTenant);
        }
        sendJson(res, 200, { count: entries.length, overrides: entries });
        return { handled: true, status: 200 };
      }
      default:
        sendJson(res, 404, { error: `Unknown sub-route: ${sub}` });
        return { handled: true, status: 404 };
    }
  } catch (err) {
    if (err instanceof HttpDashboardError) {
      sendJson(res, err.statusCode, { error: err.message });
      return { handled: true, status: err.statusCode };
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    return { handled: true, status: 500 };
  }
}

/**
 * P6: PUT /api/v1/topology/exploration/epsilon
 * Set a per-tenant ε override. Accepts:
 *   - JSON body: { "tenantId": "X", "epsilon": 0.1 }
 *   - Query params: ?tenantId=X&epsilon=0.1
 * The JSON body wins when both are present. Auth-tenant scoping:
 * a tenant caller can only set their own override; an admin (no
 * tenant) can set any.
 */
async function handleEpsilonPut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutingDashboardDeps,
  q: URLSearchParams,
): Promise<RoutingDashboardResult> {
  if (!deps.epsilonStore) {
    sendJson(res, 503, { error: 'Epsilon store not initialized on this server.' });
    return { handled: true, status: 503 };
  }
  const authTenant = deps.resolveTenant(req);

  // Parse body (best-effort; if empty, fall back to query params)
  let body: { tenantId?: string; epsilon?: number } = {};
  try {
    const raw = await readJsonBody(req);
    if (raw && typeof raw === 'object') {
      body = raw as { tenantId?: string; epsilon?: number };
    }
  } catch {
    /* ignore — fall back to query */
  }

  const tenantId = body.tenantId ?? q.get('tenantId') ?? undefined;
  const epsilonRaw =
    body.epsilon ?? (q.get('epsilon') !== null ? Number(q.get('epsilon')) : undefined);

  if (!tenantId || typeof tenantId !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: tenantId' });
    return { handled: true, status: 400 };
  }
  if (epsilonRaw === undefined || !Number.isFinite(epsilonRaw)) {
    sendJson(res, 400, { error: 'Missing or invalid required field: epsilon (must be a number)' });
    return { handled: true, status: 400 };
  }
  if (authTenant !== undefined && tenantId !== authTenant) {
    sendJson(res, 403, { error: `Forbidden: cannot set override for tenant '${tenantId}'.` });
    return { handled: true, status: 403 };
  }

  const override = deps.epsilonStore.set(tenantId, epsilonRaw);
  sendJson(res, 200, { ok: true, override });
  return { handled: true, status: 200 };
}

/**
 * P6: DELETE /api/v1/topology/exploration/epsilon?tenantId=X
 * Clear a per-tenant ε override. Returns 200 with `{cleared: true}`
 * on success, `{cleared: false}` if there was nothing to clear.
 */
function handleEpsilonDelete(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RoutingDashboardDeps,
  q: URLSearchParams,
): RoutingDashboardResult {
  if (!deps.epsilonStore) {
    sendJson(res, 503, { error: 'Epsilon store not initialized on this server.' });
    return { handled: true, status: 503 };
  }
  const authTenant = deps.resolveTenant(req);
  const tenantId = q.get('tenantId') ?? undefined;
  if (!tenantId) {
    sendJson(res, 400, { error: 'Missing required query param: tenantId' });
    return { handled: true, status: 400 };
  }
  if (authTenant !== undefined && tenantId !== authTenant) {
    sendJson(res, 403, { error: `Forbidden: cannot clear override for tenant '${tenantId}'.` });
    return { handled: true, status: 403 };
  }
  const cleared = deps.epsilonStore.clear(tenantId);
  sendJson(res, 200, { ok: true, cleared, tenantId });
  return { handled: true, status: 200 };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}
