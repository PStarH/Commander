import type { IncomingMessage, ServerResponse } from 'http';
import { type TraceStore } from '../runtime/traceStore';
import type { ExecutionTraceRecorder } from '../runtime/executionTrace';
import { type LiveReplayContext } from './replay';
import type { DatasetStore } from './dataset';
import type { ExperimentRunner, CaseExecutor } from './experimentRunner';
import type { AutoScorer } from './autoScorer';
import type { EvalScorer } from './evalScorer';
export interface ObservabilityDeps {
    recorder: ExecutionTraceRecorder;
    traceStore: TraceStore;
    resolveTenant: (req: IncomingMessage) => string | undefined;
    liveReplayContext?: LiveReplayContext;
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
}
export declare function handleObservabilityRequest(req: IncomingMessage, res: ServerResponse, deps: ObservabilityDeps, segments: string[], queryStr: string): Promise<ObservabilityResult>;
export declare const OBSERVABILITY_HTTP_ROUTES: readonly ["GET /api/v1/observability/runs", "GET /api/v1/observability/runs/:runId", "GET /api/v1/observability/runs/:runId/timeline", "GET /api/v1/observability/runs/:runId/tree", "GET /api/v1/observability/runs/:runId/cost", "GET /api/v1/observability/runs/:runId/decisions", "GET /api/v1/observability/runs/:runId/summary", "POST /api/v1/observability/runs/:runId/replay", "POST /api/v1/observability/runs/:runId/feedback", "GET /api/v1/observability/agents/:agentId", "GET /api/v1/observability/conversations/:conversationId", "GET /api/v1/observability/tools", "GET /api/v1/observability/compare/:runIdA/:runIdB", "GET /api/v1/observability/prompts", "GET /api/v1/observability/slos", "GET /api/v1/observability/search"];
//# sourceMappingURL=httpApi.d.ts.map