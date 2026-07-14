import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { runWithTenant } from './tenantContext';
import { validateOrThrow, Schemas } from './apiValidation';
import { parseBody, sendJson } from './httpUtils';
import { assertBodyTenant } from './httpTenantGate';
import { acquireRuntimeAdmission, releaseRuntimeAdmission } from './runtimeAdmission';
import { requireMinRole, resolveHttpAuthContext, type HttpAuthContext } from './httpRbacGate';

const DEFAULT_EXECUTE_TOOLS = [
  'web_search',
  'web_fetch',
  'file_read',
  'file_write',
  'file_edit',
  'file_search',
  'file_list',
  'python_execute',
  'shell_execute',
  'memory_store',
  'memory_recall',
  'memory_list',
  'git',
  'browser_search',
  'browser_fetch',
] as const;

export interface RuntimeSessionEntry {
  runtime: AgentRuntimeInterface;
  lastAccessedAt: number;
}

export interface HttpExecuteRouteDeps {
  maxBodyBytes: number;
  maxSessions: number;
  runtimes: Map<string, RuntimeSessionEntry>;
  tenantApiKeyHashes: ReadonlyMap<string, string>;
  createRuntime: (provider: string) => AgentRuntimeInterface;
  evictStaleSessions: () => void;
  requireTenant: (req: IncomingMessage, res: ServerResponse) => string | undefined;
  resolveAuth?: (req: IncomingMessage) => HttpAuthContext;
}

/**
 * POST /api/v1/execute — run an agent turn against a session runtime.
 * Returns true when handled.
 */
export async function handleExecuteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpExecuteRouteDeps,
): Promise<boolean> {
  if ((req.method ?? 'GET') !== 'POST') return false;

  const rawBody = await parseBody(req, deps.maxBodyBytes);
  const body = validateOrThrow<{
    prompt: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    outputSchema?: Record<string, unknown>;
    maxTokens?: number;
    temperature?: number;
    runtimeId?: string;
    tools?: string[];
    tenantId?: string;
  }>(rawBody, Schemas.execute);

  const tenantId = deps.requireTenant(req, res);
  if (res.writableEnded) return true;
  if (!assertBodyTenant(req, res, tenantId, body, deps.tenantApiKeyHashes)) {
    return true;
  }

  const authCtx = deps.resolveAuth?.(req) ?? resolveHttpAuthContext(req, deps.tenantApiKeyHashes);
  if (!requireMinRole(res, authCtx, 'developer', 'POST /api/v1/execute')) {
    return true;
  }

  if (!(await acquireRuntimeAdmission('http_execute'))) {
    sendJson(res, 503, {
      error: 'Service temporarily unavailable — admission control rejected request.',
    });
    return true;
  }

  const sessionId = body.sessionId ?? `session_${Date.now()}`;
  let entry = deps.runtimes.get(sessionId);
  if (!entry) {
    if (deps.runtimes.size >= deps.maxSessions) deps.evictStaleSessions();
    if (deps.runtimes.size >= deps.maxSessions) {
      releaseRuntimeAdmission();
      sendJson(res, 429, {
        error: 'Maximum sessions reached. Please reuse an existing session.',
      });
      return true;
    }
    const runtime = deps.createRuntime(body.provider ?? 'openai');
    entry = { runtime, lastAccessedAt: Date.now() };
    deps.runtimes.set(sessionId, entry);
  }
  entry.lastAccessedAt = Date.now();

  try {
    const result = await runWithTenant(tenantId, async () =>
      entry!.runtime.execute({
        agentId: `http-${sessionId}`,
        projectId: 'http-api',
        goal: body.prompt,
        availableTools: [...DEFAULT_EXECUTE_TOOLS],
        maxSteps: 50,
        tokenBudget: 100000,
        outputSchema: body.outputSchema,
        contextData: {},
        tenantId,
      }),
    );

    sendJson(res, 200, {
      sessionId,
      status: result.status,
      summary: result.summary,
      steps: result.steps?.length,
    });
  } finally {
    releaseRuntimeAdmission();
  }
  return true;
}
