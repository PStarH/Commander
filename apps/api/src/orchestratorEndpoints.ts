import { Router } from 'express';
import {
  AgentRuntime,
  OpenAIProvider,
  AnthropicProvider,
  createAllTools,
  SSEStream,
  TELOSOrchestrator,
  UltimateOrchestrator,
} from '@commander/core';

let orchInstance: UltimateOrchestrator | null = null;

function getOrchestrator(): UltimateOrchestrator | null {
  if (orchInstance) return orchInstance;
  const runtime = new AgentRuntime();
  const allTools = createAllTools();
  for (const [name, tool] of allTools) runtime.registerTool(name, tool);

  let hasProvider = false;
  if (process.env.OPENAI_API_KEY) {
    runtime.registerProvider('openai', new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
    hasProvider = true;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    runtime.registerProvider(
      'anthropic',
      new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
    );
    hasProvider = true;
  }
  if (!hasProvider) return null;

  const telos = new TELOSOrchestrator(runtime);
  orchInstance = new UltimateOrchestrator(telos, runtime);
  return orchInstance;
}

export function createOrchestratorRouter(): Router {
  const router = Router();

  router.post('/orchestrator/execute', async (req, res) => {
    const { goal, effortLevel, tools } = req.body ?? {};
    if (!goal) return res.status(400).json({ error: 'goal is required' });

    const orch = getOrchestrator();
    if (!orch)
      return res
        .status(503)
        .json({ error: 'No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.' });

    try {
      const result = await orch.execute({
        projectId: 'api',
        agentId: 'orchestrator-api',
        goal,
        contextData: {
          availableTools: tools ?? [
            'web_search',
            'web_fetch',
            'file_read',
            'file_write',
            'file_edit',
            'file_search',
            'file_list',
            'python_execute',
            'shell_execute',
            'git',
          ],
          governanceProfile: { riskLevel: 'LOW' },
        },
        effortLevel: effortLevel || undefined,
      });
      res.json(result);
    } catch (err) {
      // Security: Per Express security best practice — do not leak internal error details.
      console.error('[orchestratorEndpoints] Error:', err);
      res.status(500).json({ error: 'An internal error occurred' });
    }
  });

  router.post('/orchestrator/deliberate', async (req, res) => {
    const { goal } = req.body ?? {};
    if (!goal) return res.status(400).json({ error: 'goal is required' });

    const { deliberate } = await import('@commander/core');
    const plan = deliberate(goal);
    res.json(plan);
  });

  router.get('/orchestrator/stream', (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sse = new SSEStream();
    sse.pipe(res);

    _req.on('close', () => {
      sse.close();
      res.end();
    });
  });

  return router;
}
