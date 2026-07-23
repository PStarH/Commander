import { reportSilentFailure } from '../silentFailureReporter';
import type { IncomingMessage } from 'node:http';
import type { ExecutionTrace, TraceEvent } from '../runtime/types';
import { PersistentTraceStore, type TraceStore } from '../runtime/traceStore';
import type { ExecutionTraceRecorder } from '../runtime/executionTrace';
import { buildTimeline, buildSpanTree } from './timelineBuilder';
import { buildDecisions, decisionsSummary } from './decisionProvenance';
import { buildExecutiveSummary } from './executiveSummary';
import { getCostModel } from './costModel';
import { dryReplay, liveReplay, type LiveReplayContext } from './replay';
import { ToolMetricsCollector } from './toolMetrics';
import { compareTraces } from './traceComparison';
import { PromptVersionTracker } from './promptVersioning';
import { SLOManager, getSLOManager } from './sloManager';
import type { CostReport } from './types';
import type { DatasetStore } from './dataset';
import type { ExperimentRunner, CaseExecutor } from './experimentRunner';
import type { AutoScorer } from './autoScorer';
import type { EvalScorer, EvalRubric } from './evalScorer';
import { getGlobalLogger } from '../logging';

const log = getGlobalLogger();

export interface ObservabilityDeps {
  recorder: ExecutionTraceRecorder;
  traceStore: TraceStore;
  resolveTenant: (req: IncomingMessage) => string | undefined;
  /** Returns a store whose backing data is already scoped to tenantId. */
  resolveTraceStore?: (tenantId: string | undefined) => TraceStore;
  liveReplayContext?: LiveReplayContext;
  // P-obs-3: dataset eval system
  datasetStore?: DatasetStore;
  experimentRunner?: ExperimentRunner;
  autoScorer?: AutoScorer;
  evalScorer?: EvalScorer;
  /** Factory that creates a CaseExecutor for the experiment runner. */
  caseExecutorFactory?: () => CaseExecutor;
}

export interface ObservabilityResult {
  handled: boolean;
  status: number;
  body?: unknown;
}

function makeResult(status: number, body: unknown): ObservabilityResult {
  return { handled: true, status, body };
}

function loadTrace(
  recorder: ExecutionTraceRecorder,
  runId: string,
  store: TraceStore,
  tenantId?: string,
  storeTenantId?: string,
): ExecutionTrace | null {
  const fromRecorder = recorder.getTrace(runId);
  if (
    fromRecorder &&
    fromRecorder.events.length > 0 &&
    (!tenantId || fromRecorder.tenantId === tenantId)
  ) {
    return fromRecorder;
  }
  const fromStore = (store as PersistentTraceStore).readTrace?.(runId) ?? [];
  if (fromStore.length === 0) return null;
  const trace = traceFromEvents(runId, fromStore);
  return !tenantId || trace.tenantId === tenantId || storeTenantId === tenantId ? trace : null;
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

function buildCostReport(trace: ExecutionTrace): CostReport {
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

  const llmBySpan = new Map<string, TraceEvent>();
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

function listAllTraces(
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

export async function handleObservabilityRequest(
  req: IncomingMessage,
  deps: ObservabilityDeps,
  segments: string[],
  queryStr: string,
): Promise<ObservabilityResult> {
  const method = req.method ?? 'GET';
  // Allow GET, POST, PUT, DELETE for CRUD routes. Individual handlers
  // reject methods they don't support.
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
    return makeResult(405, { error: 'Method not allowed' });
  }

  const tenantId = deps.resolveTenant(req);
  const traceStore = deps.resolveTraceStore?.(tenantId) ?? deps.traceStore;
  const storeTenantId = deps.resolveTraceStore && tenantId ? tenantId : undefined;
  const q = new URLSearchParams(queryStr);

  try {
    if (segments[0] === 'runs' && segments.length === 1) {
      if (method !== 'GET') {
        return makeResult(405, { error: 'Method not allowed' });
      }
      const runs = listAllTraces(deps.recorder, tenantId);
      return makeResult(200, { count: runs.length, runs });
    }

    if (segments[0] === 'runs' && segments.length >= 2) {
      const runId = segments[1]!;
      const action = segments[2];

      if (method === 'GET' && !action) {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        return makeResult(200, trace);
      }

      if (method === 'GET' && action === 'timeline') {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        return makeResult(200, buildTimeline(trace));
      }

      if (method === 'GET' && action === 'tree') {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        return makeResult(200, buildSpanTree(trace));
      }

      if (method === 'GET' && action === 'cost') {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        return makeResult(200, buildCostReport(trace));
      }

      if (method === 'GET' && action === 'decisions') {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        const decisions = buildDecisions(trace);
        return makeResult(200, { runId, decisions, summary: decisionsSummary(decisions) });
      }

      if (method === 'GET' && action === 'summary') {
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
        }
        return makeResult(200, buildExecutiveSummary(trace));
      }

      if (method === 'POST' && action === 'replay') {
        const body = await readBody(req);
        const trace = loadTrace(deps.recorder, runId, traceStore, tenantId, storeTenantId);
        if (!trace) {
          return makeResult(404, { error: 'Run not found' });
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
        return makeResult(200, result);
      }
    }

    if (segments[0] === 'agents' && segments.length === 2 && method === 'GET') {
      const agentId = segments[1]!;
      const all = deps.recorder.listTraces(agentId, 200);
      const filtered = all.filter((t) => !tenantId || t.tenantId === tenantId);
      return makeResult(200, {
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
    }

    if (segments[0] === 'conversations' && segments.length >= 2 && method === 'GET') {
      const conversationId = segments[1]!;
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

      return makeResult(200, {
        conversationId,
        count: runs.length,
        runs,
        totalCost,
        totalTokens,
      });
    }

    if (segments[0] === 'search' && method === 'GET') {
      const since = q.get('since') ? Date.parse(q.get('since')!) : undefined;
      const limit = Math.min(parseInt(q.get('limit') ?? '50', 10) || 50, 500);
      const all = deps.recorder
        .listTraces(undefined, 1000)
        .filter((t) => !tenantId || t.tenantId === tenantId)
        .filter((t) => !since || new Date(t.startedAt).getTime() >= since)
        .slice(0, limit);
      return makeResult(200, {
        count: all.length,
        runs: all.map((t) => ({
          runId: t.runId,
          traceId: t.traceId,
          agentId: t.agentId,
          startedAt: t.startedAt,
        })),
      });
    }

    if (
      segments[0] === 'runs' &&
      segments.length === 3 &&
      segments[2] === 'feedback' &&
      method === 'POST'
    ) {
      const runId = segments[1]!;
      const body = await readFeedbackBody(req);
      const trace = deps.recorder.getTrace(runId);
      if (!trace || (tenantId !== undefined && trace.tenantId !== tenantId)) {
        return makeResult(404, { error: 'Run not found' });
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
      return makeResult(200, { ok: true, runId, feedback: body });
    }

    if (segments[0] === 'tools' && segments.length === 1 && method === 'GET') {
      const all = deps.recorder
        .listTraces(undefined, 1000)
        .filter((t) => !tenantId || t.tenantId === tenantId);
      const collector = new ToolMetricsCollector();
      for (const trace of all) collector.recordFromTrace(trace.events);
      return makeResult(200, collector.getSummary());
    }

    if (segments[0] === 'compare' && segments.length === 3 && method === 'GET') {
      const runIdA = segments[1]!;
      const runIdB = segments[2]!;
      const traceA = loadTrace(deps.recorder, runIdA, traceStore, tenantId, storeTenantId);
      const traceB = loadTrace(deps.recorder, runIdB, traceStore, tenantId, storeTenantId);
      if (!traceA) {
        return makeResult(404, { error: `Run ${runIdA} not found` });
      }
      if (!traceB) {
        return makeResult(404, { error: `Run ${runIdB} not found` });
      }
      return makeResult(200, compareTraces(traceA, traceB));
    }

    if (segments[0] === 'prompts' && segments.length === 1 && method === 'GET') {
      const all = deps.recorder
        .listTraces(undefined, 1000)
        .filter((t) => !tenantId || t.tenantId === tenantId);
      const tracker = new PromptVersionTracker();
      for (const trace of all) tracker.recordFromTrace(trace);
      return makeResult(200, tracker.getSummary());
    }

    if (segments[0] === 'slos' && segments.length === 1 && method === 'GET') {
      const manager = getSLOManager();
      return makeResult(200, { slos: manager.listSLOs(), status: manager.getStatus() });
    }

    // ────────── P-obs-3: Dataset eval routes ──────────

    if (segments[0] === 'datasets') {
      const ds = deps.datasetStore;
      const runner = deps.experimentRunner;
      if (!ds) {
        return makeResult(501, { error: 'DatasetStore not configured' });
      }

      if (segments.length === 1 && method === 'GET') {
        const datasets = ds.list();
        return makeResult(200, { count: datasets.length, datasets });
      }

      if (segments.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.name !== 'string' || typeof body.rubricId !== 'string') {
          return makeResult(400, { error: 'Missing required fields: name, rubricId' });
        }
        const dataset = ds.create({
          name: body.name as string,
          description: body.description as string | undefined,
          rubricId: body.rubricId as string,
          cases: (body.cases ?? []) as Array<{ id: string; input: { goal: string } }>,
          id: body.id as string | undefined,
        });
        return makeResult(201, { id: dataset.id, name: dataset.name, rubricId: dataset.rubricId });
      }

      if (segments.length === 2) {
        const datasetId = segments[1]!;
        if (method === 'GET') {
          const dataset = ds.get(datasetId);
          if (!dataset) {
            return makeResult(404, { error: 'Dataset not found' });
          }
          return makeResult(200, dataset);
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          const updated = ds.update(datasetId, body ?? {});
          if (!updated) {
            return makeResult(404, { error: 'Dataset not found' });
          }
          return makeResult(200, updated);
        }
        if (method === 'DELETE') {
          const ok = ds.delete(datasetId);
          if (!ok) {
            return makeResult(404, { error: 'Dataset not found' });
          }
          return makeResult(200, { ok: true });
        }
      }

      if (segments.length === 3 && segments[2] === 'run' && method === 'POST') {
        const datasetId = segments[1]!;
        const body = await readJsonBody(req);
        if (!ds.get(datasetId)) {
          return makeResult(404, { error: 'Dataset not found' });
        }
        if (!runner) {
          return makeResult(501, { error: 'ExperimentRunner not configured' });
        }

        const runId = runner.allocateRunId();
        const passThreshold = (body?.passThreshold as number) ?? 0.5;
        const caseExecutor = deps.caseExecutorFactory?.() ?? defaultCaseExecutor;

        // Fire-and-forget: start the experiment asynchronously, return 202 immediately
        runner.runWithId(runId, datasetId, caseExecutor, { passThreshold }).then(
          () => {
            /* completed */
          },
          () => {
            /* best-effort */
          },
        );

        return makeResult(202, { runId, datasetId, status: 'running' });
      }
    }

    if (segments[0] === 'experiments') {
      const runner = deps.experimentRunner;
      if (!runner) {
        return makeResult(501, { error: 'ExperimentRunner not configured' });
      }

      if (segments.length === 1 && method === 'GET') {
        const runs = runner.listRuns(50);
        return makeResult(200, { count: runs.length, runs });
      }

      if (segments.length === 2 && method === 'GET') {
        const run = runner.getRun(segments[1]!);
        if (!run) {
          return makeResult(404, { error: 'Experiment not found' });
        }
        return makeResult(200, run);
      }
    }

    if (segments[0] === 'auto-score') {
      const as = deps.autoScorer;
      if (!as) {
        return makeResult(501, { error: 'AutoScorer not configured' });
      }

      if (segments[1] === 'config' && method === 'GET') {
        return makeResult(200, as.getConfig());
      }

      if (segments[1] === 'config' && method === 'POST') {
        const body = await readJsonBody(req);
        const applied = as.configure(body ?? {});
        return makeResult(200, { applied });
      }

      if (segments[1] === 'results' && method === 'GET') {
        const results = as.getResults(100);
        return makeResult(200, { count: results.length, results });
      }

      if (segments[1] === 'results' && method === 'DELETE') {
        as.clearResults();
        return makeResult(200, { ok: true });
      }
    }

    if (segments[0] === 'rubrics') {
      const es = deps.evalScorer;
      if (!es) {
        return makeResult(501, { error: 'EvalScorer not configured' });
      }

      if (segments.length === 1 && method === 'GET') {
        const rubrics = es.listRubrics();
        return makeResult(200, { rubrics });
      }

      if (segments.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== 'string' || typeof body.promptTemplate !== 'string') {
          return makeResult(400, { error: 'Missing required fields: id, promptTemplate' });
        }
        es.registerRubric(body as unknown as EvalRubric);
        return makeResult(201, { id: body.id, status: 'registered' });
      }
    }

    return makeResult(404, { error: 'Not found' });
  } catch (err) {
    log.error('ObservabilityHttp', 'Handler error', err as Error);
    return makeResult(500, { error: 'Internal server error' });
  }
}

async function readFeedbackBody(
  req: IncomingMessage,
): Promise<{ rating?: 'positive' | 'negative' | 'neutral'; comment?: string; tags?: string[] }> {
  const body = (req as IncomingMessage & { body?: unknown }).body;
  if (body !== undefined) {
    return typeof body === 'string'
      ? (JSON.parse(body) as ReturnType<typeof readFeedbackBody>)
      : (body as ReturnType<typeof readFeedbackBody>);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reportSilentFailure(err, 'httpApi:726');
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readBody(req: IncomingMessage): Promise<{
  runId: string;
  substitutions: Array<{
    target: 'tool_output' | 'llm_response' | 'tool_input';
    spanId: string;
    field?: string;
    value: unknown;
  }>;
  reExecuteLlm: boolean;
  modelOverride?: string;
  onlySpanIds?: string[];
}> {
  const body = (req as IncomingMessage & { body?: unknown }).body;
  if (body !== undefined) {
    return typeof body === 'string' ? JSON.parse(body) : (body as ReturnType<typeof readBody>);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : { runId: '', substitutions: [], reExecuteLlm: false });
      } catch (err) {
        reportSilentFailure(err, 'httpApi:755');
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Generic JSON body parser for non-feedback routes. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const body = (req as IncomingMessage & { body?: unknown }).body;
  if (body !== undefined) {
    return typeof body === 'string'
      ? (JSON.parse(body) as Record<string, unknown>)
      : (body as Record<string, unknown>);
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
        resolve(JSON.parse(data));
      } catch (err) {
        reportSilentFailure(err, 'httpApi:778');
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Default case executor that returns a simple result. */
const defaultCaseExecutor: CaseExecutor = async () => ({
  output: '',
  toolCallsMade: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  costUsd: 0,
  durationMs: 0,
});

export const OBSERVABILITY_HTTP_ROUTES = [
  'GET /api/v1/observability/runs',
  'GET /api/v1/observability/runs/:runId',
  'GET /api/v1/observability/runs/:runId/timeline',
  'GET /api/v1/observability/runs/:runId/tree',
  'GET /api/v1/observability/runs/:runId/cost',
  'GET /api/v1/observability/runs/:runId/decisions',
  'GET /api/v1/observability/runs/:runId/summary',
  'POST /api/v1/observability/runs/:runId/replay',
  'POST /api/v1/observability/runs/:runId/feedback',
  'GET /api/v1/observability/agents/:agentId',
  'GET /api/v1/observability/conversations/:conversationId',
  'GET /api/v1/observability/tools',
  'GET /api/v1/observability/compare/:runIdA/:runIdB',
  'GET /api/v1/observability/prompts',
  'GET /api/v1/observability/slos',
  'GET /api/v1/observability/search',
] as const;
