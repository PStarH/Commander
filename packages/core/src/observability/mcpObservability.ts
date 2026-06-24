import type { MCPServer } from '../mcp/server';
import type { ExecutionTraceRecorder } from '../runtime/executionTrace';
import type { TraceStore } from '../runtime/traceStore';
import { buildTimeline } from './timelineBuilder';
import { buildExecutiveSummary } from './executiveSummary';
import { buildDecisions, decisionsSummary } from './decisionProvenance';
import { ToolMetricsCollector } from './toolMetrics';
import { compareTraces } from './traceComparison';

interface McpObsDeps {
  recorder: ExecutionTraceRecorder;
  traceStore: TraceStore;
}

function loadTrace(recorder: ExecutionTraceRecorder, runId: string, store: TraceStore) {
  const fromRecorder = recorder.getTrace(runId);
  if (fromRecorder && fromRecorder.events.length > 0) return fromRecorder;
  const fromStore =
    (store as { readTrace?: (runId: string) => unknown[] }).readTrace?.(runId) ?? [];
  if (fromStore.length === 0) return null;
  return fromRecorder;
}

export function registerObservabilityTools(server: MCPServer, deps: McpObsDeps): void {
  server.registerTool(
    {
      name: 'observability_get_timeline',
      description:
        'Get the execution timeline for a run. Returns structured nodes showing LLM calls, tool executions, decisions, and errors.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          runId: { type: 'string', description: 'The run ID to get the timeline for' },
        },
        required: ['runId'],
      },
    },
    async (args) => {
      const trace = loadTrace(deps.recorder, args.runId as string, deps.traceStore);
      if (!trace) return { content: [{ type: 'text', text: `Run ${args.runId} not found` }] };
      const timeline = buildTimeline(trace);
      return { content: [{ type: 'text', text: JSON.stringify(timeline, null, 2) }] };
    },
  );

  server.registerTool(
    {
      name: 'observability_get_summary',
      description:
        'Get an executive summary of a run. Provides a 30-second understanding narrative with cost, tokens, and key events.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          runId: { type: 'string', description: 'The run ID to summarize' },
        },
        required: ['runId'],
      },
    },
    async (args) => {
      const trace = loadTrace(deps.recorder, args.runId as string, deps.traceStore);
      if (!trace) return { content: [{ type: 'text', text: `Run ${args.runId} not found` }] };
      const summary = buildExecutiveSummary(trace);
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    {
      name: 'observability_get_decisions',
      description: 'Get the decision provenance for a run. Shows which tools were chosen and why.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          runId: { type: 'string', description: 'The run ID to get decisions for' },
        },
        required: ['runId'],
      },
    },
    async (args) => {
      const trace = loadTrace(deps.recorder, args.runId as string, deps.traceStore);
      if (!trace) return { content: [{ type: 'text', text: `Run ${args.runId} not found` }] };
      const decisions = buildDecisions(trace);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { runId: args.runId, decisions, summary: decisionsSummary(decisions) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    {
      name: 'observability_compare_runs',
      description:
        'Compare two execution traces side by side. Shows added/removed/modified events, cost delta, and token delta.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          runIdA: { type: 'string', description: 'First run ID (baseline)' },
          runIdB: { type: 'string', description: 'Second run ID (comparison)' },
        },
        required: ['runIdA', 'runIdB'],
      },
    },
    async (args) => {
      const traceA = loadTrace(deps.recorder, args.runIdA as string, deps.traceStore);
      const traceB = loadTrace(deps.recorder, args.runIdB as string, deps.traceStore);
      if (!traceA) return { content: [{ type: 'text', text: `Run ${args.runIdA} not found` }] };
      if (!traceB) return { content: [{ type: 'text', text: `Run ${args.runIdB} not found` }] };
      const comparison = compareTraces(traceA, traceB);
      return { content: [{ type: 'text', text: JSON.stringify(comparison, null, 2) }] };
    },
  );

  server.registerTool(
    {
      name: 'observability_get_tool_metrics',
      description:
        'Get aggregated tool usage metrics across all runs. Shows success rates, invocation counts, and average durations.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    async () => {
      const all = deps.recorder.listTraces(undefined, 1000);
      const collector = new ToolMetricsCollector();
      for (const trace of all) collector.recordFromTrace(trace.events);
      return { content: [{ type: 'text', text: JSON.stringify(collector.getSummary(), null, 2) }] };
    },
  );

  server.registerTool(
    {
      name: 'observability_list_runs',
      description:
        'List all recorded runs with basic metadata (runId, agentId, token usage, status).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max runs to return (default 50)' },
        },
      },
    },
    async (args) => {
      const limit = Math.min((args.limit as number) || 50, 500);
      const all = deps.recorder.listTraces(undefined, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: all.length,
                runs: all.map((t) => ({
                  runId: t.runId,
                  agentId: t.agentId,
                  startedAt: t.startedAt,
                  completedAt: t.completedAt,
                  tokens: t.summary.totalTokens,
                  llmCalls: t.summary.llmCalls,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
