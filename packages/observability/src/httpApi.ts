import type { IncomingMessage, ServerResponse } from 'http';
import type { ExecutionTraceRecorder } from '@commander/core';
import type { TraceStore } from '@commander/core';
import type { LiveReplayContext } from './replay';
import type { DatasetStore } from './dataset';
import type { ExperimentRunner, CaseExecutor } from './experimentRunner';
import type { AutoScorer } from './autoScorer';
import type { EvalScorer } from './evalScorer';
import { getGlobalLogger } from '@commander/core';
import {
  sendJson,
  handleListRuns,
  handleGetRun,
  handleGetTimeline,
  handleGetTree,
  handleGetCost,
  handleGetDecisions,
  handleGetSummary,
  handleReplay,
  handleGetAgentRuns,
  handleGetConversationRuns,
  handleSearch,
  handleFeedback,
  handleGetToolMetrics,
  handleCompareTraces,
  handleGetPrompts,
  handleGetSlos,
  handleDatasetsList,
  handleDatasetsCreate,
  handleDatasetById,
  handleDatasetRun,
  handleExperimentsList,
  handleExperimentGet,
  handleAutoScoreConfigGet,
  handleAutoScoreConfigPost,
  handleAutoScoreResultsGet,
  handleAutoScoreResultsDelete,
  handleRubricsList,
  handleRubricsCreate,
} from './httpRoutes';

const log = getGlobalLogger();

export interface ObservabilityDeps {
  recorder: ExecutionTraceRecorder;
  traceStore: TraceStore;
  resolveTenant: (req: IncomingMessage) => string | undefined;
  liveReplayContext?: LiveReplayContext;
  datasetStore?: DatasetStore;
  experimentRunner?: ExperimentRunner;
  autoScorer?: AutoScorer;
  evalScorer?: EvalScorer;
  caseExecutorFactory?: () => CaseExecutor;
}

export interface ObservabilityResult {
  handled: boolean;
  status: number;
}

export async function handleObservabilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ObservabilityDeps,
  segments: string[],
  queryStr: string,
): Promise<ObservabilityResult> {
  const method = req.method ?? 'GET';
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
      return handleListRuns(res, deps, tenantId);
    }

    if (segments[0] === 'runs' && segments.length >= 2) {
      const runId = segments[1]!;
      const action = segments[2];

      if (method === 'GET' && !action) return handleGetRun(res, deps, runId);
      if (method === 'GET' && action === 'timeline') return handleGetTimeline(res, deps, runId);
      if (method === 'GET' && action === 'tree') return handleGetTree(res, deps, runId);
      if (method === 'GET' && action === 'cost') return handleGetCost(res, deps, runId);
      if (method === 'GET' && action === 'decisions') return handleGetDecisions(res, deps, runId);
      if (method === 'GET' && action === 'summary') return handleGetSummary(res, deps, runId);
      if (method === 'POST' && action === 'replay')
        return handleReplay(req, res, deps, runId);
    }

    if (segments[0] === 'runs' && segments.length === 3 && segments[2] === 'feedback' && method === 'POST') {
      return handleFeedback(req, res, deps, segments[1]!);
    }

    if (segments[0] === 'agents' && segments.length === 2 && method === 'GET') {
      return handleGetAgentRuns(res, deps, segments[1]!, tenantId);
    }

    if (segments[0] === 'conversations' && segments.length >= 2 && method === 'GET') {
      return handleGetConversationRuns(res, deps, segments[1]!, tenantId);
    }

    if (segments[0] === 'search' && method === 'GET') {
      return handleSearch(res, deps, tenantId, q);
    }

    if (segments[0] === 'tools' && segments.length === 1 && method === 'GET') {
      return handleGetToolMetrics(res, deps, tenantId);
    }

    if (segments[0] === 'compare' && segments.length === 3 && method === 'GET') {
      return handleCompareTraces(res, deps, segments[1]!, segments[2]!);
    }

    if (segments[0] === 'prompts' && segments.length === 1 && method === 'GET') {
      return handleGetPrompts(res, deps, tenantId);
    }

    if (segments[0] === 'slos' && segments.length === 1 && method === 'GET') {
      return handleGetSlos(res);
    }

    if (segments[0] === 'datasets') {
      if (segments.length === 1 && method === 'GET') return handleDatasetsList(res, deps);
      if (segments.length === 1 && method === 'POST') return handleDatasetsCreate(req, res, deps);
      if (segments.length === 2) return handleDatasetById(req, res, deps, segments[1]!, method);
      if (segments.length === 3 && segments[2] === 'run' && method === 'POST')
        return handleDatasetRun(req, res, deps, segments[1]!);
    }

    if (segments[0] === 'experiments') {
      if (segments.length === 1 && method === 'GET') return handleExperimentsList(res, deps);
      if (segments.length === 2 && method === 'GET')
        return handleExperimentGet(res, deps, segments[1]!);
    }

    if (segments[0] === 'auto-score') {
      if (segments[1] === 'config' && method === 'GET') return handleAutoScoreConfigGet(res, deps);
      if (segments[1] === 'config' && method === 'POST')
        return handleAutoScoreConfigPost(req, res, deps);
      if (segments[1] === 'results' && method === 'GET') return handleAutoScoreResultsGet(res, deps);
      if (segments[1] === 'results' && method === 'DELETE')
        return handleAutoScoreResultsDelete(res, deps);
    }

    if (segments[0] === 'rubrics') {
      if (segments.length === 1 && method === 'GET') return handleRubricsList(res, deps);
      if (segments.length === 1 && method === 'POST') return handleRubricsCreate(req, res, deps);
    }

    sendJson(res, 404, { error: 'Not found' });
    return { handled: true, status: 404 };
  } catch (err) {
    log.error('ObservabilityHttp', 'Handler error', err as Error);
    sendJson(res, 500, { error: 'Internal server error' });
    return { handled: true, status: 500 };
  }
}

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
