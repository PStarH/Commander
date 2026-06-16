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
import type { ExecutionScheduler, RunHandle } from './scheduler';
import type { RunState, RunTransaction, CompensableAction } from './types';
import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';
import type { SecurityEvent } from '../security/securityAuditLogger';

const log = getGlobalLogger();

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

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        rejected = true;
        reject(new Error(`Request body too large. Limit is ${maxBytes} bytes.`));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serializeTx(tx: RunTransaction): Record<string, unknown> {
  return {
    runId: tx.runId,
    state: tx.state,
    intentHash: tx.intentHash,
    leaseToken: tx.leaseToken,
    fencingEpoch: tx.fencingEpoch,
    createdAt: tx.createdAt,
    committedAt: tx.committedAt,
    abortedAt: tx.abortedAt,
    error: tx.error,
    tenantId: tx.tenantId,
    metadata: tx.metadata,
    actions: tx.actions.map((a: CompensableAction) => ({
      actionId: a.actionId,
      toolName: a.toolName,
      externalSystem: a.externalSystem,
      args: a.args,
      idempotencyKey: a.idempotencyKey,
      compensable: a.compensable,
      executedAt: a.executedAt,
      compensatedAt: a.compensatedAt,
      result: a.result,
      error: a.error,
      description: a.description,
      tags: a.tags,
    })),
  };
}

function serializeHandle(h: RunHandle): Record<string, unknown> {
  return {
    runId: h.runId,
    state: h.state,
    leaseToken: h.leaseToken,
    fencingEpoch: h.fencingEpoch,
    intentHash: h.intentHash,
    tenantId: h.tenantId,
    metadata: h.metadata,
    createdAt: h.createdAt,
    resumed: h.resumed,
    acquired: h.acquired,
  };
}

export async function handleAtrHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AtrHttpDeps,
  segments: string[],
  queryStr: string,
  opts: { maxBodyBytes: number },
): Promise<AtrHttpResult> {
  const method = req.method ?? 'GET';
  const tenantId = deps.resolveTenant(req);

  try {
    if (segments[0] !== 'atr') return { handled: false, status: 404 };

    if (segments[1] === 'runs') {
      if (method === 'GET' && segments.length === 2) {
        const state = queryStr
          ? (new URLSearchParams(queryStr).get('state') ?? undefined)
          : undefined;
        const runs = deps.scheduler.listRuns({
          state: state as RunState | undefined,
          tenantId,
        });
        sendJson(res, 200, { runs: runs.map(serializeTx) });
        return { handled: true, status: 200 };
      }

      if (method === 'POST' && segments.length === 2) {
        const body = (await readBody(req, opts.maxBodyBytes)) as {
          runId?: string;
          goal: string;
          intent?: string;
          metadata?: Record<string, unknown>;
          ttlSeconds?: number;
          holder?: string;
        };
        if (!body.goal) {
          sendJson(res, 400, { error: 'goal is required' });
          return { handled: true, status: 400 };
        }
        const handle = deps.scheduler.beginRun({
          runId: body.runId,
          goal: body.goal,
          intent: body.intent,
          metadata: body.metadata,
          ttlSeconds: body.ttlSeconds,
          holder: body.holder,
          tenantId,
        });
        sendJson(res, 201, serializeHandle(handle));
        return { handled: true, status: 201 };
      }

      if (segments.length >= 3) {
        const runId = segments[2];
        const action = segments[3];

        if (method === 'GET' && !action) {
          const tx = deps.scheduler.getRun({ runId, tenantId });
          if (!tx) {
            sendJson(res, 404, { error: 'Run not found' });
            return { handled: true, status: 404 };
          }
          sendJson(res, 200, serializeTx(tx));
          return { handled: true, status: 200 };
        }

        if (method === 'POST' && (action === 'commit' || action === 'abort' || action === 'kill')) {
          const body = (await readBody(req, opts.maxBodyBytes)) as {
            leaseToken: string;
            fencingEpoch: number;
            reason?: string;
          };
          if (!body.leaseToken || typeof body.fencingEpoch !== 'number') {
            sendJson(res, 400, { error: 'leaseToken and fencingEpoch are required' });
            return { handled: true, status: 400 };
          }

          if (action === 'commit') {
            const r = deps.scheduler.commitRun({
              runId,
              leaseToken: body.leaseToken,
              fencingEpoch: body.fencingEpoch,
              tenantId,
            });
            sendJson(res, r.committed ? 200 : 409, r);
            return { handled: true, status: r.committed ? 200 : 409 };
          }

          if (action === 'kill') {
            const r = deps.scheduler.killRun({
              runId,
              leaseToken: body.leaseToken,
              fencingEpoch: body.fencingEpoch,
              tenantId,
            });
            sendJson(res, r.killed ? 200 : 409, r);
            return { handled: true, status: r.killed ? 200 : 409 };
          }

          const r = await deps.scheduler.abortRun({
            runId,
            leaseToken: body.leaseToken,
            fencingEpoch: body.fencingEpoch,
            reason: body.reason ?? 'http_abort',
            tenantId,
          });
          sendJson(res, r.aborted ? 200 : 409, r);
          return { handled: true, status: r.aborted ? 200 : 409 };
        }
      }
    }

    if (segments[1] === 'audit' && method === 'GET') {
      const limit = queryStr
        ? Math.min(parseInt(new URLSearchParams(queryStr).get('limit') ?? '100', 10) || 100, 1000)
        : 100;
      const allStates: RunState[] = [
        'PENDING',
        'EXECUTING',
        'VERIFYING',
        'COMMITTED',
        'ABORTED',
        'COMPENSATED',
        'PAUSED',
      ];
      const runs: RunTransaction[] = [];
      for (const s of allStates) {
        const list = deps.scheduler.listRuns({ state: s, tenantId });
        for (const tx of list) {
          const full = deps.scheduler.getRun({ runId: tx.runId, tenantId });
          if (full) runs.push(full);
        }
      }
      const actions = runs
        .flatMap((tx) => tx.actions)
        .slice(-limit)
        .reverse();
      sendJson(res, 200, {
        count: actions.length,
        actions: actions.map((a) => ({
          actionId: a.actionId,
          runId: a.runId,
          toolName: a.toolName,
          externalSystem: a.externalSystem,
          compensable: a.compensable,
          compensatedAt: a.compensatedAt,
          executedAt: a.executedAt,
          error: a.error,
        })),
      });
      return { handled: true, status: 200 };
    }

    if (segments[1] === 'policy' && segments[2] === 'decisions' && method === 'GET') {
      const q = new URLSearchParams(queryStr);
      const runId = q.get('runId') ?? undefined;
      const limit = Math.min(parseInt(q.get('limit') ?? '100', 10) || 100, 1000);
      const severity = q.get('severity') as SecurityEvent['severity'] | null;
      const events = getSecurityAuditLogger().queryEvents({
        runId,
        severity: severity ?? undefined,
        limit,
      });
      const decisions = events
        .filter((e) => typeof e.source === 'string' && e.source.startsWith('PolicyEngine:'))
        .map(serializePolicyDecision);
      sendJson(res, 200, { count: decisions.length, decisions });
      return { handled: true, status: 200 };
    }

    return { handled: false, status: 404 };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'Invalid JSON' || msg.startsWith('Request body too large')) {
      sendJson(res, 400, { error: msg });
      return { handled: true, status: 400 };
    }
    log.error('AtrHttp', 'Handler error', err as Error);
    sendJson(res, 500, { error: 'Internal server error' });
    return { handled: true, status: 500 };
  }
}

function serializePolicyDecision(e: SecurityEvent): Record<string, unknown> {
  return {
    id: e.id,
    timestamp: e.timestamp,
    source: e.source,
    severity: e.severity,
    type: e.type,
    message: e.message,
    runId: e.context?.runId,
    tenantId: e.context?.tenantId,
    details: e.details,
  };
}

export const ATR_HTTP_ROUTES = [
  'GET /api/v1/atr/runs',
  'GET /api/v1/atr/runs/:runId',
  'POST /api/v1/atr/runs',
  'POST /api/v1/atr/runs/:runId/commit',
  'POST /api/v1/atr/runs/:runId/abort',
  'POST /api/v1/atr/runs/:runId/kill',
  'GET /api/v1/atr/audit',
  'GET /api/v1/atr/policy/decisions',
] as const;
