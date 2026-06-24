import type { IncomingMessage, ServerResponse } from 'http';
import type { ExecutionTrace, TraceEvent } from '@commander/core';
import { PersistentTraceStore, type TraceStore } from '@commander/core';
import type { ExecutionTraceRecorder } from '@commander/core';
import { buildTimeline, buildSpanTree } from './timelineBuilder';
import { buildDecisions, decisionsSummary } from './decisionProvenance';
import { buildExecutiveSummary } from './executiveSummary';
import { getCostModel } from './costModel';
import { dryReplay, liveReplay, type LiveReplayContext } from './replay';
import { ToolMetricsCollector } from './toolMetrics';
import { compareTraces } from './traceComparison';
import { PromptVersionTracker } from './promptVersioning';
import { SLOManager } from './sloManager';
import type { CostReport } from './types';
import type { DatasetStore } from './dataset';
import type { ExperimentRunner, CaseExecutor } from './experimentRunner';
import type { AutoScorer } from './autoScorer';
import type { EvalScorer, EvalRubric } from './evalScorer';
import type { ObservabilityDeps, ObservabilityResult } from './httpApi';
import { getGlobalLogger } from '@commander/core';

const log = getGlobalLogger();

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function loadTrace(
  recorder: ExecutionTraceRecorder,
  runId: string,
  store: TraceStore,
): ExecutionTrace | null {
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
    completedAt: last
      ? new Date(new Date(last.timestamp).getTime() + last.durationMs).toISOString()
      : undefined,
    events,
    summary: summarizeEvents(events),
  };
}

function summarizeEvents(events: TraceEvent[]): ExecutionTrace['summary'] {
  let totalDurationMs = 0,
    totalTokens = 0,
    llmCalls = 0,
    toolExecutions = 0,
    errors = 0;
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
  return {
    totalEvents: events.length,
    totalDurationMs,
    totalTokens,
    llmCalls,
    toolExecutions,
    errors,
    modelUsed,
  };
}

export function buildCostReport(trace: ExecutionTrace): CostReport {
  const costModel = getCostModel();
  const byModel = new Map<
    string,
    {
      model: string;
      provider: string;
      tokens: ReturnType<typeof costModel.emptyTokens>;
      cost: ReturnType<typeof costModel.emptyCost>;
      calls: number;
    }
  >();
  const byTool = new Map<
    string,
    { invocations: number; downstreamCost: ReturnType<typeof costModel.emptyCost> }
  >();
  const byAgent = new Map<
    string,
    {
      tokens: ReturnType<typeof costModel.emptyTokens>;
      cost: ReturnType<typeof costModel.emptyCost>;
    }
  >();
  let total = costModel.emptyCost();
  let totalTokens = costModel.emptyTokens();

  for (const e of trace.events) {
    if (e.type === 'llm_call' && e.data.tokenUsage && e.data.modelInfo) {
      const tokens = {
        input: e.data.tokenUsage.promptTokens ?? 0,
        output: e.data.tokenUsage.completionTokens ?? 0,
        cached: 0,
        reasoning: 0,
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
        byModel.set(key, {
          model: e.data.modelInfo.model,
          provider: e.data.modelInfo.provider,
          tokens,
          cost,
          calls: 1,
        });
      }
      const aCur = byAgent.get(e.agentId);
      if (aCur) {
        aCur.tokens = costModel.addTokens(aCur.tokens, tokens);
        aCur.cost = costModel.addCost(aCur.cost, cost);
      } else {
        byAgent.set(e.agentId, { tokens, cost });
      }
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
          cached: 0,
          reasoning: 0,
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
      toolName,
      invocations: v.invocations,
      downstreamCost: v.downstreamCost,
    })),
    byAgent: Array.from(byAgent.entries()).map(([agentId, v]) => ({
      agentId,
      tokens: v.tokens,
      cost: v.cost,
    })),
  };
}

export function listAllTraces(
  recorder: ExecutionTraceRecorder,
  tenantId: string | undefined,
): Array<{
  runId: string;
  agentId: string;
  traceId: string;
  startedAt: string;
  tenantId?: string;
  llmCalls: number;
  toolExecutions: number;
  totalTokens: number;
  status: 'running' | 'completed';
}> {
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

// ────────── Route handlers ──────────

type RouteResult = ObservabilityResult;

export function handleListRuns(
  res: ServerResponse,
  deps: ObservabilityDeps,
  tenantId: string | undefined,
): RouteResult {
  const runs = listAllTraces(deps.recorder, tenantId);
  sendJson(res, 200, { count: runs.length, runs });
  return { handled: true, status: 200 };
}

export function handleGetRun(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, trace);
  return { handled: true, status: 200 };
}

export function handleGetTimeline(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, buildTimeline(trace));
  return { handled: true, status: 200 };
}

export function handleGetTree(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, buildSpanTree(trace));
  return { handled: true, status: 200 };
}

export function handleGetCost(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, buildCostReport(trace));
  return { handled: true, status: 200 };
}

export function handleGetDecisions(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  const decisions = buildDecisions(trace);
  sendJson(res, 200, { runId, decisions, summary: decisionsSummary(decisions) });
  return { handled: true, status: 200 };
}

export function handleGetSummary(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): RouteResult {
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, buildExecutiveSummary(trace));
  return { handled: true, status: 200 };
}

export async function handleReplay(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): Promise<RouteResult> {
  const body = await readBody(req);
  const trace = loadTrace(deps.recorder, runId, deps.traceStore);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  const liveCtx = deps.liveReplayContext;
  const useLive = !!body?.reExecuteLlm && !!liveCtx;
  const result =
    useLive && liveCtx
      ? await liveReplay(trace, body, liveCtx, {
          ...(body?.modelOverride ? { modelOverride: body.modelOverride } : {}),
          ...(body?.onlySpanIds?.length ? { onlySpanIds: body.onlySpanIds } : {}),
        })
      : dryReplay(trace, body);
  sendJson(res, 200, result);
  return { handled: true, status: 200 };
}

export function handleGetAgentRuns(
  res: ServerResponse,
  deps: ObservabilityDeps,
  agentId: string,
  tenantId: string | undefined,
): RouteResult {
  const all = deps.recorder.listTraces(agentId, 200);
  const filtered = all.filter((t) => !tenantId || t.tenantId === tenantId);
  sendJson(res, 200, {
    agentId,
    count: filtered.length,
    runs: filtered.map((t) => ({
      runId: t.runId,
      traceId: t.traceId,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      llmCalls: t.summary.llmCalls,
      toolExecutions: t.summary.toolExecutions,
      errors: t.summary.errors,
    })),
  });
  return { handled: true, status: 200 };
}

export function handleGetConversationRuns(
  res: ServerResponse,
  deps: ObservabilityDeps,
  conversationId: string,
  tenantId: string | undefined,
): RouteResult {
  const all = deps.recorder.listTraces(undefined, 1000);
  const matching = all.filter((t) => {
    const hasConversationEvent = t.events.some((e) => e.data.conversationId === conversationId);
    return hasConversationEvent && (!tenantId || t.tenantId === tenantId);
  });

  const costModel = getCostModel();
  let totalCost = costModel.emptyCost();
  let totalTokens = costModel.emptyTokens();
  const runs = matching.map((t) => {
    let runCost = costModel.emptyCost();
    let runTokens = costModel.emptyTokens();
    for (const e of t.events) {
      if (e.type === 'llm_call' && e.data.tokenUsage && e.data.modelInfo) {
        const tokens = {
          input: e.data.tokenUsage.promptTokens ?? 0,
          output: e.data.tokenUsage.completionTokens ?? 0,
          cached: 0,
          reasoning: 0,
          total: e.data.tokenUsage.totalTokens ?? 0,
        };
        const cost = costModel.calculate(
          e.data.modelInfo.provider,
          e.data.modelInfo.model,
          tokens,
        );
        runCost = costModel.addCost(runCost, cost);
        runTokens = costModel.addTokens(runTokens, tokens);
      }
    }
    totalCost = costModel.addCost(totalCost, runCost);
    totalTokens = costModel.addTokens(totalTokens, runTokens);
    return {
      runId: t.runId,
      agentId: t.agentId,
      traceId: t.traceId,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      totalCost: runCost,
      totalTokens: runTokens,
    };
  });

  sendJson(res, 200, {
    conversationId,
    count: runs.length,
    runs,
    totalCost,
    totalTokens,
  });
  return { handled: true, status: 200 };
}

export function handleSearch(
  res: ServerResponse,
  deps: ObservabilityDeps,
  tenantId: string | undefined,
  q: URLSearchParams,
): RouteResult {
  const since = q.get('since') ? Date.parse(q.get('since')!) : undefined;
  const limit = Math.min(parseInt(q.get('limit') ?? '50', 10) || 50, 500);
  const all = deps.recorder
    .listTraces(undefined, 1000)
    .filter((t) => !tenantId || t.tenantId === tenantId)
    .filter((t) => !since || new Date(t.startedAt).getTime() >= since)
    .slice(0, limit);
  sendJson(res, 200, {
    count: all.length,
    runs: all.map((t) => ({
      runId: t.runId,
      traceId: t.traceId,
      agentId: t.agentId,
      startedAt: t.startedAt,
    })),
  });
  return { handled: true, status: 200 };
}

export async function handleFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  runId: string,
): Promise<RouteResult> {
  const body = await readFeedbackBody(req);
  const trace = deps.recorder.getTrace(runId);
  if (!trace) {
    sendJson(res, 404, { error: 'Run not found' });
    return { handled: true, status: 404 };
  }
  deps.recorder.recordEvent(runId, {
    type: 'state_change',
    durationMs: 0,
    data: {
      input: 'feedback',
      output: body,
      feedback: {
        rating: body.rating,
        comment: body.comment,
        tags: body.tags,
        timestamp: new Date().toISOString(),
      },
    },
  });
  sendJson(res, 200, { ok: true, runId, feedback: body });
  return { handled: true, status: 200 };
}

export function handleGetToolMetrics(
  res: ServerResponse,
  deps: ObservabilityDeps,
  tenantId: string | undefined,
): RouteResult {
  const all = deps.recorder
    .listTraces(undefined, 1000)
    .filter((t) => !tenantId || t.tenantId === tenantId);
  const collector = new ToolMetricsCollector();
  for (const trace of all) collector.recordFromTrace(trace.events);
  sendJson(res, 200, collector.getSummary());
  return { handled: true, status: 200 };
}

export function handleCompareTraces(
  res: ServerResponse,
  deps: ObservabilityDeps,
  runIdA: string,
  runIdB: string,
): RouteResult {
  const traceA = loadTrace(deps.recorder, runIdA, deps.traceStore);
  const traceB = loadTrace(deps.recorder, runIdB, deps.traceStore);
  if (!traceA) {
    sendJson(res, 404, { error: `Run ${runIdA} not found` });
    return { handled: true, status: 404 };
  }
  if (!traceB) {
    sendJson(res, 404, { error: `Run ${runIdB} not found` });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, compareTraces(traceA, traceB));
  return { handled: true, status: 200 };
}

export function handleGetPrompts(
  res: ServerResponse,
  deps: ObservabilityDeps,
  tenantId: string | undefined,
): RouteResult {
  const all = deps.recorder
    .listTraces(undefined, 1000)
    .filter((t) => !tenantId || t.tenantId === tenantId);
  const tracker = new PromptVersionTracker();
  for (const trace of all) tracker.recordFromTrace(trace);
  sendJson(res, 200, tracker.getSummary());
  return { handled: true, status: 200 };
}

export function handleGetSlos(res: ServerResponse): RouteResult {
  const manager = new SLOManager();
  sendJson(res, 200, { slos: manager.listSLOs(), status: manager.getStatus() });
  return { handled: true, status: 200 };
}

export function handleDatasetsList(res: ServerResponse, deps: ObservabilityDeps): RouteResult {
  const ds = deps.datasetStore;
  if (!ds) {
    sendJson(res, 501, { error: 'DatasetStore not configured' });
    return { handled: true, status: 501 };
  }
  const datasets = ds.list();
  sendJson(res, 200, { count: datasets.length, datasets });
  return { handled: true, status: 200 };
}

export async function handleDatasetsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
): Promise<RouteResult> {
  const ds = deps.datasetStore;
  if (!ds) {
    sendJson(res, 501, { error: 'DatasetStore not configured' });
    return { handled: true, status: 501 };
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.name !== 'string' || typeof body.rubricId !== 'string') {
    sendJson(res, 400, { error: 'Missing required fields: name, rubricId' });
    return { handled: true, status: 400 };
  }
  const dataset = ds.create({
    name: body.name as string,
    description: body.description as string | undefined,
    rubricId: body.rubricId as string,
    cases: (body.cases ?? []) as Array<{ id: string; input: { goal: string } }>,
    id: body.id as string | undefined,
  });
  sendJson(res, 201, { id: dataset.id, name: dataset.name, rubricId: dataset.rubricId });
  return { handled: true, status: 201 };
}

export async function handleDatasetById(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  datasetId: string,
  method: string,
): Promise<RouteResult> {
  const ds = deps.datasetStore;
  if (!ds) {
    sendJson(res, 501, { error: 'DatasetStore not configured' });
    return { handled: true, status: 501 };
  }
  if (method === 'GET') {
    const dataset = ds.get(datasetId);
    if (!dataset) {
      sendJson(res, 404, { error: 'Dataset not found' });
      return { handled: true, status: 404 };
    }
    sendJson(res, 200, dataset);
    return { handled: true, status: 200 };
  }
  if (method === 'PUT') {
    const body = await readJsonBody(req);
    const updated = ds.update(datasetId, body ?? {});
    if (!updated) {
      sendJson(res, 404, { error: 'Dataset not found' });
      return { handled: true, status: 404 };
    }
    sendJson(res, 200, updated);
    return { handled: true, status: 200 };
  }
  if (method === 'DELETE') {
    const ok = ds.delete(datasetId);
    if (!ok) {
      sendJson(res, 404, { error: 'Dataset not found' });
      return { handled: true, status: 404 };
    }
    sendJson(res, 200, { ok: true });
    return { handled: true, status: 200 };
  }
  sendJson(res, 405, { error: 'Method not allowed' });
  return { handled: true, status: 405 };
}

export async function handleDatasetRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  datasetId: string,
): Promise<RouteResult> {
  const ds = deps.datasetStore;
  const runner = deps.experimentRunner;
  if (!ds) {
    sendJson(res, 501, { error: 'DatasetStore not configured' });
    return { handled: true, status: 501 };
  }
  if (!ds.get(datasetId)) {
    sendJson(res, 404, { error: 'Dataset not found' });
    return { handled: true, status: 404 };
  }
  if (!runner) {
    sendJson(res, 501, { error: 'ExperimentRunner not configured' });
    return { handled: true, status: 501 };
  }

  const body = await readJsonBody(req);
  const runId = runner.allocateRunId();
  const passThreshold = (body?.passThreshold as number) ?? 0.5;
  const caseExecutor = deps.caseExecutorFactory?.() ?? defaultCaseExecutor;

  runner.runWithId(runId, datasetId, caseExecutor, { passThreshold }).then(
    () => {
      /* completed */
    },
    (err) => {
      log.warn('ObservabilityHttp', `Dataset run ${runId} failed`, { error: String(err) });
    },
  );

  sendJson(res, 202, { runId, datasetId, status: 'running' });
  return { handled: true, status: 202 };
}

export function handleExperimentsList(
  res: ServerResponse,
  deps: ObservabilityDeps,
): RouteResult {
  const runner = deps.experimentRunner;
  if (!runner) {
    sendJson(res, 501, { error: 'ExperimentRunner not configured' });
    return { handled: true, status: 501 };
  }
  const runs = runner.listRuns(50);
  sendJson(res, 200, { count: runs.length, runs });
  return { handled: true, status: 200 };
}

export function handleExperimentGet(
  res: ServerResponse,
  deps: ObservabilityDeps,
  experimentId: string,
): RouteResult {
  const runner = deps.experimentRunner;
  if (!runner) {
    sendJson(res, 501, { error: 'ExperimentRunner not configured' });
    return { handled: true, status: 501 };
  }
  const run = runner.getRun(experimentId);
  if (!run) {
    sendJson(res, 404, { error: 'Experiment not found' });
    return { handled: true, status: 404 };
  }
  sendJson(res, 200, run);
  return { handled: true, status: 200 };
}

export function handleAutoScoreConfigGet(
  res: ServerResponse,
  deps: ObservabilityDeps,
): RouteResult {
  const as = deps.autoScorer;
  if (!as) {
    sendJson(res, 501, { error: 'AutoScorer not configured' });
    return { handled: true, status: 501 };
  }
  sendJson(res, 200, as.getConfig());
  return { handled: true, status: 200 };
}

export async function handleAutoScoreConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
): Promise<RouteResult> {
  const as = deps.autoScorer;
  if (!as) {
    sendJson(res, 501, { error: 'AutoScorer not configured' });
    return { handled: true, status: 501 };
  }
  const body = await readJsonBody(req);
  const applied = as.configure(body ?? {});
  sendJson(res, 200, { applied });
  return { handled: true, status: 200 };
}

export function handleAutoScoreResultsGet(
  res: ServerResponse,
  deps: ObservabilityDeps,
): RouteResult {
  const as = deps.autoScorer;
  if (!as) {
    sendJson(res, 501, { error: 'AutoScorer not configured' });
    return { handled: true, status: 501 };
  }
  const results = as.getResults(100);
  sendJson(res, 200, { count: results.length, results });
  return { handled: true, status: 200 };
}

export function handleAutoScoreResultsDelete(
  res: ServerResponse,
  deps: ObservabilityDeps,
): RouteResult {
  const as = deps.autoScorer;
  if (!as) {
    sendJson(res, 501, { error: 'AutoScorer not configured' });
    return { handled: true, status: 501 };
  }
  as.clearResults();
  sendJson(res, 200, { ok: true });
  return { handled: true, status: 200 };
}

export function handleRubricsList(
  res: ServerResponse,
  deps: ObservabilityDeps,
): RouteResult {
  const es = deps.evalScorer;
  if (!es) {
    sendJson(res, 501, { error: 'EvalScorer not configured' });
    return { handled: true, status: 501 };
  }
  const rubrics = es.listRubrics();
  sendJson(res, 200, { rubrics });
  return { handled: true, status: 200 };
}

export async function handleRubricsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
): Promise<RouteResult> {
  const es = deps.evalScorer;
  if (!es) {
    sendJson(res, 501, { error: 'EvalScorer not configured' });
    return { handled: true, status: 501 };
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.id !== 'string' || typeof body.promptTemplate !== 'string') {
    sendJson(res, 400, { error: 'Missing required fields: id, promptTemplate' });
    return { handled: true, status: 400 };
  }
  es.registerRubric(body as unknown as EvalRubric);
  sendJson(res, 201, { id: body.id, status: 'registered' });
  return { handled: true, status: 201 };
}

// ────────── Body parsers ──────────

type RequestWithBody = IncomingMessage & { body?: unknown };

type FeedbackBody = {
  rating?: 'positive' | 'negative' | 'neutral';
  comment?: string;
  tags?: string[];
};

type ReplaySubstitution = {
  target: 'tool_output' | 'llm_response' | 'tool_input';
  spanId: string;
  field?: string;
  value: unknown;
};

type ReplayRequestBody = {
  runId: string;
  substitutions: ReplaySubstitution[];
  reExecuteLlm: boolean;
  modelOverride?: string;
  onlySpanIds?: string[];
};

function hasParsedBody(req: IncomingMessage): req is RequestWithBody & { body: object } {
  const body = (req as RequestWithBody).body;
  return body !== undefined && body !== null && typeof body === 'object' && !Array.isArray(body);
}

async function readFeedbackBody(req: IncomingMessage): Promise<FeedbackBody> {
  if (hasParsedBody(req)) {
    return req.body as FeedbackBody;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as FeedbackBody) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readBody(req: IncomingMessage): Promise<ReplayRequestBody> {
  if (hasParsedBody(req)) {
    return req.body as ReplayRequestBody;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(
          data
            ? (JSON.parse(data) as ReplayRequestBody)
            : { runId: '', substitutions: [], reExecuteLlm: false },
        );
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (hasParsedBody(req)) {
    if (Object.keys(req.body).length === 0) return undefined;
    return req.body as Record<string, unknown>;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      if (data.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const defaultCaseExecutor: CaseExecutor = async () => ({
  output: '',
  toolCallsMade: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  costUsd: 0,
  durationMs: 0,
});
