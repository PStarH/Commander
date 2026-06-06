import type { IncomingMessage, ServerResponse } from 'http';
import type { ExecutionTrace, TraceEvent } from '../runtime/types';
import { PersistentTraceStore, type TraceStore } from '../runtime/traceStore';
import type { ExecutionTraceRecorder } from '../runtime/executionTrace';
import { buildTimeline, buildSpanTree } from './timelineBuilder';
import { buildDecisions, decisionsSummary } from './decisionProvenance';
import { getCostModel } from './costModel';
import { dryReplay } from './replay';
import type { CostReport } from './types';
import { getGlobalLogger } from '../logging';

const log = getGlobalLogger();

export interface ObservabilityDeps {
  recorder: ExecutionTraceRecorder;
  traceStore: TraceStore;
  resolveTenant: (req: IncomingMessage) => string | undefined;
}

export interface ObservabilityResult {
  handled: boolean;
  status: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function loadTrace(recorder: ExecutionTraceRecorder, runId: string, store: TraceStore): ExecutionTrace | null {
  const fromRecorder = recorder.getTrace(runId);
  if (fromRecorder && fromRecorder.events.length > 0) return fromRecorder;
  const fromStore = (store as PersistentTraceStore).readTrace?.(runId) ?? [];
  if (fromStore.length === 0) return null;
  return traceFromEvents(runId, fromStore);
}

function traceFromEvents(runId: string, events: TraceEvent[]): ExecutionTrace {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return {
    runId,
    traceId: first.traceId,
    agentId: first.agentId,
    startedAt: first.timestamp,
    completedAt: last ? new Date(new Date(last.timestamp).getTime() + last.durationMs).toISOString() : undefined,
    events,
    summary: summarizeEvents(events),
  };
}

function summarizeEvents(events: TraceEvent[]): ExecutionTrace['summary'] {
  let totalDurationMs = 0, totalTokens = 0, llmCalls = 0, toolExecutions = 0, errors = 0;
  let modelUsed = '';
  for (const e of events) {
    totalDurationMs += e.durationMs;
    if (e.type === 'llm_call') {
      llmCalls++;
      if (e.data.tokenUsage) totalTokens += e.data.tokenUsage.totalTokens ?? 0;
      if (e.data.modelInfo && !modelUsed) modelUsed = e.data.modelInfo.model;
    }
    if (e.type === 'tool_execution') toolExecutions++;
    if (e.type === 'error') errors++;
  }
  return { totalEvents: events.length, totalDurationMs, totalTokens, llmCalls, toolExecutions, errors, modelUsed };
}

function buildCostReport(trace: ExecutionTrace): CostReport {
  const costModel = getCostModel();
  const byModel = new Map<string, { model: string; provider: string; tokens: ReturnType<typeof costModel.emptyTokens>; cost: ReturnType<typeof costModel.emptyCost>; calls: number }>();
  const byTool = new Map<string, { invocations: number; downstreamCost: ReturnType<typeof costModel.emptyCost> }>();
  const byAgent = new Map<string, { tokens: ReturnType<typeof costModel.emptyTokens>; cost: ReturnType<typeof costModel.emptyCost> }>();
  let total = costModel.emptyCost();
  let totalTokens = costModel.emptyTokens();

  const llmBySpan = new Map<string, TraceEvent>();
  for (const e of trace.events) {
    if (e.type === 'llm_call' && e.data.tokenUsage && e.data.modelInfo) {
      const tokens = {
        input: e.data.tokenUsage.promptTokens ?? 0,
        output: e.data.tokenUsage.completionTokens ?? 0,
        cached: 0, reasoning: 0,
        total: e.data.tokenUsage.totalTokens ?? 0,
      };
      const cost = costModel.calculate(e.data.modelInfo.provider, e.data.modelInfo.model, tokens);
      total = costModel.addCost(total, cost);
      totalTokens = costModel.addTokens(totalTokens, tokens);
      const key = `${e.data.modelInfo.provider}:${e.data.modelInfo.model}`;
      const cur = byModel.get(key);
      if (cur) {
        cur.tokens = costModel.addTokens(cur.tokens, tokens);
        cur.cost = costModel.addCost(cur.cost, cost);
        cur.calls++;
      } else {
        byModel.set(key, { model: e.data.modelInfo.model, provider: e.data.modelInfo.provider, tokens, cost, calls: 1 });
      }
      const aCur = byAgent.get(e.agentId);
      if (aCur) {
        aCur.tokens = costModel.addTokens(aCur.tokens, tokens);
        aCur.cost = costModel.addCost(aCur.cost, cost);
      } else {
        byAgent.set(e.agentId, { tokens, cost });
      }
      llmBySpan.set(e.spanId, e);
    }
    if (e.type === 'tool_execution') {
      const toolName = String(e.data.input ?? 'unknown');
      const cur = byTool.get(toolName);
      if (cur) cur.invocations++;
      else byTool.set(toolName, { invocations: 1, downstreamCost: costModel.emptyCost() });
    }
  }

  for (const tool of byTool.values()) {
    let dc = costModel.emptyCost();
    for (const e of trace.events) {
      if (e.type === 'llm_call' && e.data.tokenUsage) {
        const tokens = {
          input: e.data.tokenUsage.promptTokens ?? 0,
          output: e.data.tokenUsage.completionTokens ?? 0,
          cached: 0, reasoning: 0,
          total: e.data.tokenUsage.totalTokens ?? 0,
        };
        const cost = costModel.calculate(
          e.data.modelInfo?.provider ?? 'unknown',
          e.data.modelInfo?.model ?? 'unknown',
          tokens,
        );
        dc = costModel.addCost(dc, cost);
      }
    }
    tool.downstreamCost = dc;
  }

  return {
    runId: trace.runId,
    traceId: trace.traceId,
    total,
    byModel: Array.from(byModel.values()),
    byTool: Array.from(byTool.entries()).map(([toolName, v]) => ({
      toolName, invocations: v.invocations, downstreamCost: v.downstreamCost,
    })),
    byAgent: Array.from(byAgent.entries()).map(([agentId, v]) => ({
      agentId, tokens: v.tokens, cost: v.cost,
    })),
  };
}

function listAllTraces(recorder: ExecutionTraceRecorder, tenantId: string | undefined): Array<{ runId: string; agentId: string; traceId: string; startedAt: string; tenantId?: string; llmCalls: number; toolExecutions: number; totalTokens: number; status: 'running' | 'completed' }> {
  const all = recorder.listTraces(undefined, 1000);
  return all
    .filter((t) => !tenantId || t.tenantId === tenantId)
    .map((t) => ({
      runId: t.runId,
      agentId: t.agentId,
      traceId: t.traceId,
      startedAt: t.startedAt,
      tenantId: t.tenantId,
      llmCalls: t.summary.llmCalls,
      toolExecutions: t.summary.toolExecutions,
      totalTokens: t.summary.totalTokens,
      status: (t.completedAt ? 'completed' : 'running') as 'running' | 'completed',
    }));
}

export async function handleObservabilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  segments: string[],
  queryStr: string,
): Promise<ObservabilityResult> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return { handled: true, status: 405 };
  }

  const tenantId = deps.resolveTenant(req);
  const q = new URLSearchParams(queryStr);

  try {
    if (segments[0] === 'runs' && segments.length === 1) {
      const runs = listAllTraces(deps.recorder, tenantId);
      sendJson(res, 200, { count: runs.length, runs });
      return { handled: true, status: 200 };
    }

    if (segments[0] === 'runs' && segments.length >= 2) {
      const runId = segments[1]!;
      const action = segments[2];

      if (method === 'GET' && !action) {
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        sendJson(res, 200, trace);
        return { handled: true, status: 200 };
      }

      if (method === 'GET' && action === 'timeline') {
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        sendJson(res, 200, buildTimeline(trace));
        return { handled: true, status: 200 };
      }

      if (method === 'GET' && action === 'tree') {
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        sendJson(res, 200, buildSpanTree(trace));
        return { handled: true, status: 200 };
      }

      if (method === 'GET' && action === 'cost') {
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        sendJson(res, 200, buildCostReport(trace));
        return { handled: true, status: 200 };
      }

      if (method === 'GET' && action === 'decisions') {
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        const decisions = buildDecisions(trace);
        sendJson(res, 200, { runId, decisions, summary: decisionsSummary(decisions) });
        return { handled: true, status: 200 };
      }

      if (method === 'POST' && action === 'replay') {
        const body = await readBody(req);
        const trace = loadTrace(deps.recorder, runId, deps.traceStore);
        if (!trace) { sendJson(res, 404, { error: 'Run not found' }); return { handled: true, status: 404 }; }
        const result = dryReplay(trace, body);
        sendJson(res, 200, result);
        return { handled: true, status: 200 };
      }
    }

    if (segments[0] === 'agents' && segments.length === 2 && method === 'GET') {
      const agentId = segments[1]!;
      const all = deps.recorder.listTraces(agentId, 200);
      const filtered = all.filter((t) => !tenantId || t.tenantId === tenantId);
      sendJson(res, 200, { agentId, count: filtered.length, runs: filtered.map((t) => ({
        runId: t.runId, traceId: t.traceId, startedAt: t.startedAt, completedAt: t.completedAt,
        llmCalls: t.summary.llmCalls, toolExecutions: t.summary.toolExecutions, errors: t.summary.errors,
      })) });
      return { handled: true, status: 200 };
    }

    if (segments[0] === 'search' && method === 'GET') {
      const since = q.get('since') ? Date.parse(q.get('since')!) : undefined;
      const limit = Math.min(parseInt(q.get('limit') ?? '50', 10) || 50, 500);
      const all = deps.recorder.listTraces(undefined, 1000)
        .filter((t) => !tenantId || t.tenantId === tenantId)
        .filter((t) => !since || new Date(t.startedAt).getTime() >= since)
        .slice(0, limit);
      sendJson(res, 200, { count: all.length, runs: all.map((t) => ({ runId: t.runId, traceId: t.traceId, agentId: t.agentId, startedAt: t.startedAt })) });
      return { handled: true, status: 200 };
    }

    sendJson(res, 404, { error: 'Not found' });
    return { handled: true, status: 404 };
  } catch (err) {
    log.error('ObservabilityHttp', 'Handler error', err as Error);
    sendJson(res, 500, { error: 'Internal server error' });
    return { handled: true, status: 500 };
  }
}

async function readBody(req: IncomingMessage): Promise<{ runId: string; substitutions: Array<{ target: 'tool_output' | 'llm_response' | 'tool_input'; spanId: string; field?: string; value: unknown }>; reExecuteLlm: boolean }> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : { runId: '', substitutions: [], reExecuteLlm: false });
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export const OBSERVABILITY_HTTP_ROUTES = [
  'GET /api/v1/observability/runs',
  'GET /api/v1/observability/runs/:runId',
  'GET /api/v1/observability/runs/:runId/timeline',
  'GET /api/v1/observability/runs/:runId/tree',
  'GET /api/v1/observability/runs/:runId/cost',
  'GET /api/v1/observability/runs/:runId/decisions',
  'POST /api/v1/observability/runs/:runId/replay',
  'GET /api/v1/observability/agents/:agentId',
  'GET /api/v1/observability/search',
] as const;
