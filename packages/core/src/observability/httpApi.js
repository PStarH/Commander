"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OBSERVABILITY_HTTP_ROUTES = void 0;
exports.handleObservabilityRequest = handleObservabilityRequest;
const timelineBuilder_1 = require("./timelineBuilder");
const decisionProvenance_1 = require("./decisionProvenance");
const executiveSummary_1 = require("./executiveSummary");
const costModel_1 = require("./costModel");
const replay_1 = require("./replay");
const toolMetrics_1 = require("./toolMetrics");
const traceComparison_1 = require("./traceComparison");
const promptVersioning_1 = require("./promptVersioning");
const sloManager_1 = require("./sloManager");
const logging_1 = require("../logging");
const log = (0, logging_1.getGlobalLogger)();
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
function loadTrace(recorder, runId, store) {
    var _a, _b, _c;
    const fromRecorder = recorder.getTrace(runId);
    if (fromRecorder && fromRecorder.events.length > 0)
        return fromRecorder;
    const fromStore = (_c = (_b = (_a = store).readTrace) === null || _b === void 0 ? void 0 : _b.call(_a, runId)) !== null && _c !== void 0 ? _c : [];
    if (fromStore.length === 0)
        return null;
    return traceFromEvents(runId, fromStore);
}
function traceFromEvents(runId, events) {
    const first = events[0];
    const last = events[events.length - 1];
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
function summarizeEvents(events) {
    var _a;
    let totalDurationMs = 0, totalTokens = 0, llmCalls = 0, toolExecutions = 0, errors = 0;
    let modelUsed = '';
    for (const e of events) {
        totalDurationMs += e.durationMs;
        if (e.type === 'llm_call') {
            llmCalls++;
            if (e.data.tokenUsage)
                totalTokens += (_a = e.data.tokenUsage.totalTokens) !== null && _a !== void 0 ? _a : 0;
            if (e.data.modelInfo && !modelUsed)
                modelUsed = e.data.modelInfo.model;
        }
        if (e.type === 'tool_execution')
            toolExecutions++;
        if (e.type === 'error')
            errors++;
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
function buildCostReport(trace) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const costModel = (0, costModel_1.getCostModel)();
    const byModel = new Map();
    const byTool = new Map();
    const byAgent = new Map();
    let total = costModel.emptyCost();
    let totalTokens = costModel.emptyTokens();
    const llmBySpan = new Map();
    for (const e of trace.events) {
        if (e.type === 'llm_call' && e.data.tokenUsage && e.data.modelInfo) {
            const tokens = {
                input: (_a = e.data.tokenUsage.promptTokens) !== null && _a !== void 0 ? _a : 0,
                output: (_b = e.data.tokenUsage.completionTokens) !== null && _b !== void 0 ? _b : 0,
                cached: 0,
                reasoning: 0,
                total: (_c = e.data.tokenUsage.totalTokens) !== null && _c !== void 0 ? _c : 0,
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
            }
            else {
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
            }
            else {
                byAgent.set(e.agentId, { tokens, cost });
            }
            llmBySpan.set(e.spanId, e);
        }
        if (e.type === 'tool_execution') {
            const toolName = String((_d = e.data.input) !== null && _d !== void 0 ? _d : 'unknown');
            const cur = byTool.get(toolName);
            if (cur)
                cur.invocations++;
            else
                byTool.set(toolName, { invocations: 1, downstreamCost: costModel.emptyCost() });
        }
    }
    for (const tool of byTool.values()) {
        let dc = costModel.emptyCost();
        for (const e of trace.events) {
            if (e.type === 'llm_call' && e.data.tokenUsage) {
                const tokens = {
                    input: (_e = e.data.tokenUsage.promptTokens) !== null && _e !== void 0 ? _e : 0,
                    output: (_f = e.data.tokenUsage.completionTokens) !== null && _f !== void 0 ? _f : 0,
                    cached: 0,
                    reasoning: 0,
                    total: (_g = e.data.tokenUsage.totalTokens) !== null && _g !== void 0 ? _g : 0,
                };
                const cost = costModel.calculate((_j = (_h = e.data.modelInfo) === null || _h === void 0 ? void 0 : _h.provider) !== null && _j !== void 0 ? _j : 'unknown', (_l = (_k = e.data.modelInfo) === null || _k === void 0 ? void 0 : _k.model) !== null && _l !== void 0 ? _l : 'unknown', tokens);
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
function listAllTraces(recorder, tenantId) {
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
        status: (t.completedAt ? 'completed' : 'running'),
    }));
}
async function handleObservabilityRequest(req, res, deps, segments, queryStr) {
    var _a, _b, _c, _d, _e, _f, _g;
    const method = (_a = req.method) !== null && _a !== void 0 ? _a : 'GET';
    // Allow GET, POST, PUT, DELETE for CRUD routes. Individual handlers
    // reject methods they don't support.
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return { handled: true, status: 405 };
    }
    const tenantId = deps.resolveTenant(req);
    const q = new URLSearchParams(queryStr);
    try {
        if (segments[0] === 'runs' && segments.length === 1) {
            if (method !== 'GET') {
                sendJson(res, 405, { error: 'Method not allowed' });
                return { handled: true, status: 405 };
            }
            const runs = listAllTraces(deps.recorder, tenantId);
            sendJson(res, 200, { count: runs.length, runs });
            return { handled: true, status: 200 };
        }
        if (segments[0] === 'runs' && segments.length >= 2) {
            const runId = segments[1];
            const action = segments[2];
            if (method === 'GET' && !action) {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, trace);
                return { handled: true, status: 200 };
            }
            if (method === 'GET' && action === 'timeline') {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, (0, timelineBuilder_1.buildTimeline)(trace));
                return { handled: true, status: 200 };
            }
            if (method === 'GET' && action === 'tree') {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, (0, timelineBuilder_1.buildSpanTree)(trace));
                return { handled: true, status: 200 };
            }
            if (method === 'GET' && action === 'cost') {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, buildCostReport(trace));
                return { handled: true, status: 200 };
            }
            if (method === 'GET' && action === 'decisions') {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                const decisions = (0, decisionProvenance_1.buildDecisions)(trace);
                sendJson(res, 200, { runId, decisions, summary: (0, decisionProvenance_1.decisionsSummary)(decisions) });
                return { handled: true, status: 200 };
            }
            if (method === 'GET' && action === 'summary') {
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, (0, executiveSummary_1.buildExecutiveSummary)(trace));
                return { handled: true, status: 200 };
            }
            if (method === 'POST' && action === 'replay') {
                const body = await readBody(req);
                const trace = loadTrace(deps.recorder, runId, deps.traceStore);
                if (!trace) {
                    sendJson(res, 404, { error: 'Run not found' });
                    return { handled: true, status: 404 };
                }
                const liveCtx = deps.liveReplayContext;
                const useLive = !!(body === null || body === void 0 ? void 0 : body.reExecuteLlm) && !!liveCtx;
                const result = useLive && liveCtx
                    ? await (0, replay_1.liveReplay)(trace, body, liveCtx, {
                        ...((body === null || body === void 0 ? void 0 : body.modelOverride) ? { modelOverride: body.modelOverride } : {}),
                        ...(((_b = body === null || body === void 0 ? void 0 : body.onlySpanIds) === null || _b === void 0 ? void 0 : _b.length) ? { onlySpanIds: body.onlySpanIds } : {}),
                    })
                    : (0, replay_1.dryReplay)(trace, body);
                sendJson(res, 200, result);
                return { handled: true, status: 200 };
            }
        }
        if (segments[0] === 'agents' && segments.length === 2 && method === 'GET') {
            const agentId = segments[1];
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
        if (segments[0] === 'conversations' && segments.length >= 2 && method === 'GET') {
            const conversationId = segments[1];
            const all = deps.recorder.listTraces(undefined, 1000);
            const matching = all.filter((t) => {
                const hasConversationEvent = t.events.some((e) => e.data.conversationId === conversationId);
                return hasConversationEvent && (!tenantId || t.tenantId === tenantId);
            });
            const costModel = (0, costModel_1.getCostModel)();
            let totalCost = costModel.emptyCost();
            let totalTokens = costModel.emptyTokens();
            const runs = matching.map((t) => {
                var _a, _b, _c;
                let runCost = costModel.emptyCost();
                let runTokens = costModel.emptyTokens();
                for (const e of t.events) {
                    if (e.type === 'llm_call' && e.data.tokenUsage && e.data.modelInfo) {
                        const tokens = {
                            input: (_a = e.data.tokenUsage.promptTokens) !== null && _a !== void 0 ? _a : 0,
                            output: (_b = e.data.tokenUsage.completionTokens) !== null && _b !== void 0 ? _b : 0,
                            cached: 0,
                            reasoning: 0,
                            total: (_c = e.data.tokenUsage.totalTokens) !== null && _c !== void 0 ? _c : 0,
                        };
                        const cost = costModel.calculate(e.data.modelInfo.provider, e.data.modelInfo.model, tokens);
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
        if (segments[0] === 'search' && method === 'GET') {
            const since = q.get('since') ? Date.parse(q.get('since')) : undefined;
            const limit = Math.min(parseInt((_c = q.get('limit')) !== null && _c !== void 0 ? _c : '50', 10) || 50, 500);
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
        if (segments[0] === 'runs' &&
            segments.length === 3 &&
            segments[2] === 'feedback' &&
            method === 'POST') {
            const runId = segments[1];
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
        if (segments[0] === 'tools' && segments.length === 1 && method === 'GET') {
            const all = deps.recorder
                .listTraces(undefined, 1000)
                .filter((t) => !tenantId || t.tenantId === tenantId);
            const collector = new toolMetrics_1.ToolMetricsCollector();
            for (const trace of all)
                collector.recordFromTrace(trace.events);
            sendJson(res, 200, collector.getSummary());
            return { handled: true, status: 200 };
        }
        if (segments[0] === 'compare' && segments.length === 3 && method === 'GET') {
            const runIdA = segments[1];
            const runIdB = segments[2];
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
            sendJson(res, 200, (0, traceComparison_1.compareTraces)(traceA, traceB));
            return { handled: true, status: 200 };
        }
        if (segments[0] === 'prompts' && segments.length === 1 && method === 'GET') {
            const all = deps.recorder
                .listTraces(undefined, 1000)
                .filter((t) => !tenantId || t.tenantId === tenantId);
            const tracker = new promptVersioning_1.PromptVersionTracker();
            for (const trace of all)
                tracker.recordFromTrace(trace);
            sendJson(res, 200, tracker.getSummary());
            return { handled: true, status: 200 };
        }
        if (segments[0] === 'slos' && segments.length === 1 && method === 'GET') {
            const manager = new sloManager_1.SLOManager();
            sendJson(res, 200, { slos: manager.listSLOs(), status: manager.getStatus() });
            return { handled: true, status: 200 };
        }
        // ────────── P-obs-3: Dataset eval routes ──────────
        if (segments[0] === 'datasets') {
            const ds = deps.datasetStore;
            const runner = deps.experimentRunner;
            if (!ds) {
                sendJson(res, 501, { error: 'DatasetStore not configured' });
                return { handled: true, status: 501 };
            }
            if (segments.length === 1 && method === 'GET') {
                const datasets = ds.list();
                sendJson(res, 200, { count: datasets.length, datasets });
                return { handled: true, status: 200 };
            }
            if (segments.length === 1 && method === 'POST') {
                const body = await readJsonBody(req);
                if (!body || typeof body.name !== 'string' || typeof body.rubricId !== 'string') {
                    sendJson(res, 400, { error: 'Missing required fields: name, rubricId' });
                    return { handled: true, status: 400 };
                }
                const dataset = ds.create({
                    name: body.name,
                    description: body.description,
                    rubricId: body.rubricId,
                    cases: ((_d = body.cases) !== null && _d !== void 0 ? _d : []),
                    id: body.id,
                });
                sendJson(res, 201, { id: dataset.id, name: dataset.name, rubricId: dataset.rubricId });
                return { handled: true, status: 201 };
            }
            if (segments.length === 2) {
                const datasetId = segments[1];
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
                    const updated = ds.update(datasetId, body !== null && body !== void 0 ? body : {});
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
            }
            if (segments.length === 3 && segments[2] === 'run' && method === 'POST') {
                const datasetId = segments[1];
                const body = await readJsonBody(req);
                if (!ds.get(datasetId)) {
                    sendJson(res, 404, { error: 'Dataset not found' });
                    return { handled: true, status: 404 };
                }
                if (!runner) {
                    sendJson(res, 501, { error: 'ExperimentRunner not configured' });
                    return { handled: true, status: 501 };
                }
                const runId = runner.allocateRunId();
                const passThreshold = (_e = body === null || body === void 0 ? void 0 : body.passThreshold) !== null && _e !== void 0 ? _e : 0.5;
                const caseExecutor = (_g = (_f = deps.caseExecutorFactory) === null || _f === void 0 ? void 0 : _f.call(deps)) !== null && _g !== void 0 ? _g : defaultCaseExecutor;
                // Fire-and-forget: start the experiment asynchronously, return 202 immediately
                runner.runWithId(runId, datasetId, caseExecutor, { passThreshold }).then(() => {
                    /* completed */
                }, () => {
                    /* best-effort */
                });
                sendJson(res, 202, { runId, datasetId, status: 'running' });
                return { handled: true, status: 202 };
            }
        }
        if (segments[0] === 'experiments') {
            const runner = deps.experimentRunner;
            if (!runner) {
                sendJson(res, 501, { error: 'ExperimentRunner not configured' });
                return { handled: true, status: 501 };
            }
            if (segments.length === 1 && method === 'GET') {
                const runs = runner.listRuns(50);
                sendJson(res, 200, { count: runs.length, runs });
                return { handled: true, status: 200 };
            }
            if (segments.length === 2 && method === 'GET') {
                const run = runner.getRun(segments[1]);
                if (!run) {
                    sendJson(res, 404, { error: 'Experiment not found' });
                    return { handled: true, status: 404 };
                }
                sendJson(res, 200, run);
                return { handled: true, status: 200 };
            }
        }
        if (segments[0] === 'auto-score') {
            const as = deps.autoScorer;
            if (!as) {
                sendJson(res, 501, { error: 'AutoScorer not configured' });
                return { handled: true, status: 501 };
            }
            if (segments[1] === 'config' && method === 'GET') {
                sendJson(res, 200, as.getConfig());
                return { handled: true, status: 200 };
            }
            if (segments[1] === 'config' && method === 'POST') {
                const body = await readJsonBody(req);
                const applied = as.configure(body !== null && body !== void 0 ? body : {});
                sendJson(res, 200, { applied });
                return { handled: true, status: 200 };
            }
            if (segments[1] === 'results' && method === 'GET') {
                const results = as.getResults(100);
                sendJson(res, 200, { count: results.length, results });
                return { handled: true, status: 200 };
            }
            if (segments[1] === 'results' && method === 'DELETE') {
                as.clearResults();
                sendJson(res, 200, { ok: true });
                return { handled: true, status: 200 };
            }
        }
        if (segments[0] === 'rubrics') {
            const es = deps.evalScorer;
            if (!es) {
                sendJson(res, 501, { error: 'EvalScorer not configured' });
                return { handled: true, status: 501 };
            }
            if (segments.length === 1 && method === 'GET') {
                const rubrics = es.listRubrics();
                sendJson(res, 200, { rubrics });
                return { handled: true, status: 200 };
            }
            if (segments.length === 1 && method === 'POST') {
                const body = await readJsonBody(req);
                if (!body || typeof body.id !== 'string' || typeof body.promptTemplate !== 'string') {
                    sendJson(res, 400, { error: 'Missing required fields: id, promptTemplate' });
                    return { handled: true, status: 400 };
                }
                es.registerRubric(body);
                sendJson(res, 201, { id: body.id, status: 'registered' });
                return { handled: true, status: 201 };
            }
        }
        sendJson(res, 404, { error: 'Not found' });
        return { handled: true, status: 404 };
    }
    catch (err) {
        log.error('ObservabilityHttp', 'Handler error', err);
        sendJson(res, 500, { error: 'Internal server error' });
        return { handled: true, status: 500 };
    }
}
async function readFeedbackBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk.toString('utf-8');
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            }
            catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
async function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk.toString('utf-8');
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : { runId: '', substitutions: [], reExecuteLlm: false });
            }
            catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
/** Generic JSON body parser for non-feedback routes. */
async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk.toString('utf-8');
        });
        req.on('end', () => {
            if (data.length === 0) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(data));
            }
            catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
/** Default case executor that returns a simple result. */
const defaultCaseExecutor = async () => ({
    output: '',
    toolCallsMade: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: 0,
    durationMs: 0,
});
exports.OBSERVABILITY_HTTP_ROUTES = [
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
];
