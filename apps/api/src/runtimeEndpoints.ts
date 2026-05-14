import express, { Router } from 'express';
import { AgentRuntime } from '@commander/core';
import { getModelRouter } from '@commander/core';
import { getMessageBus } from '@commander/core';
import { getTraceRecorder } from '@commander/core';
import { getMetaLearner } from '@commander/core';
import { getHTMLReportRenderer, createWarRoomHTMLReport } from '@commander/core';
import type { AgentExecutionContext } from '@commander/core';

export function createRuntimeRouter(): Router {
  const router = express.Router();
  router.use(express.json());

  const runtime = new AgentRuntime({ maxRetries: 1, timeoutMs: 30000 });

  // POST /api/runtime/execute — Execute an agent task
  router.post('/execute', async (req, res) => {
    const { agentId, projectId, missionId, goal, contextData, availableTools, tokenBudget } = req.body;

    if (!agentId || !goal) {
      return res.status(400).json({ error: 'agentId and goal are required' });
    }

    const ctx: AgentExecutionContext = {
      agentId,
      projectId: projectId ?? 'default',
      missionId,
      goal,
      contextData: contextData ?? {},
      availableTools: availableTools ?? [],
      maxSteps: 10,
      tokenBudget: tokenBudget ?? 8000,
    };

    try {
      const result = await runtime.execute(ctx);

      // Also record as meta-learner experience
      if (result.status !== 'cancelled') {
        try {
          const learner = getMetaLearner();
          learner.recordExperience({
            id: `exp-${result.runId}`,
            runId: result.runId,
            agentId: result.agentId,
            missionId: result.missionId,
            taskType: 'api_execution',
            modelUsed: 'routed',
            strategyUsed: 'SEQUENTIAL',
            success: result.status === 'success',
            durationMs: result.totalDurationMs,
            tokenCost: result.totalTokenUsage.totalTokens,
            lessons: result.status === 'success' ? [] : [result.error ?? 'unknown error'],
            timestamp: new Date().toISOString(),
          });
        } catch {
          // non-critical
        }
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/runtime/route — Preview routing decision
  router.post('/route', (req, res) => {
    const { goal, tokenBudget, availableTools, contextData } = req.body;

    if (!goal) {
      return res.status(400).json({ error: 'goal is required' });
    }

    const ctx: AgentExecutionContext = {
      agentId: 'preview',
      projectId: 'preview',
      goal,
      contextData: contextData ?? {},
      availableTools: availableTools ?? [],
      maxSteps: 5,
      tokenBudget: tokenBudget ?? 4000,
    };

    const router_instance = getModelRouter();
    const decision = router_instance.route(ctx);
    res.json(decision);
  });

  // GET /api/runtime/traces — List execution traces
  router.get('/traces', (req, res) => {
    const { agentId, limit } = req.query;
    const tracer = getTraceRecorder();
    const traces = tracer.listTraces(
      agentId as string | undefined,
      limit ? parseInt(limit as string, 10) : 50,
    );
    res.json({ traces, count: traces.length });
  });

  // GET /api/runtime/traces/:runId — Get specific trace
  router.get('/traces/:runId', (req, res) => {
    const tracer = getTraceRecorder();
    const trace = tracer.getTrace(req.params.runId);
    if (!trace) {
      return res.status(404).json({ error: 'Trace not found' });
    }
    res.json(trace);
  });

  // GET /api/runtime/traces/summary — Trace summary stats
  router.get('/traces/summary', (_req, res) => {
    const tracer = getTraceRecorder();
    res.json(tracer.getSummary());
  });

  // GET /api/runtime/bus/messages — Message bus history
  router.get('/bus/messages', (req, res) => {
    const { topic, limit } = req.query;
    const bus = getMessageBus();
    const messages = bus.getHistory(
      topic as any,
      limit ? parseInt(limit as string, 10) : undefined,
    );
    res.json({ messages, count: messages.length });
  });

  // GET /api/runtime/bus/topics — Active topics
  router.get('/bus/topics', (_req, res) => {
    const bus = getMessageBus();
    res.json({
      topics: bus.getActiveTopics(),
      subscriberCounts: bus.getAllSubscriberCounts(),
    });
  });

  // GET /api/runtime/learner/stats — Meta-learner statistics
  router.get('/learner/stats', (_req, res) => {
    const learner = getMetaLearner();
    const stats = learner.getStats();
    const suggestions = learner.getSuggestions();
    res.json({ stats, suggestions });
  });

  // POST /api/runtime/render-report — Generate HTML report
  router.post('/render-report', (req, res) => {
    const { projectName, operationCodename, health, metrics, narrative, topAgents, missionSummary, recentEvents } = req.body;

    if (!projectName || !operationCodename) {
      return res.status(400).json({ error: 'projectName and operationCodename are required' });
    }

    const report = createWarRoomHTMLReport({
      projectName,
      operationCodename,
      health: health ?? 'GREEN',
      metrics: metrics ?? {},
      narrative: narrative ?? '',
      topAgents: topAgents ?? [],
      missionSummary: missionSummary ?? {},
      recentEvents,
    });

    const renderer = getHTMLReportRenderer();
    const html = renderer.render(report);
    res.type('text/html').send(html);
  });

  // GET /api/runtime/health — Runtime module health
  router.get('/health', (_req, res) => {
    const runtime_inst = runtime;
    res.json({
      status: 'ok',
      activeRuns: runtime_inst.getActiveRunCount(),
      registeredProviders: [],
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
