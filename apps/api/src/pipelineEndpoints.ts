import { Router } from 'express';
import { SequentialPipeline } from '@commander/core';
import { PatternStateMachineFactory, PatternStateMachine } from './patternStateMachine';
import { SequentialExecutor, createMockAgentExecutor } from './sequentialExecutor';
import { AgentBenchmarkRunner, createCommanderHealthCheckBenchmark, visualizeBenchmark } from './agentBenchmarkRunner';

export function createPipelineRouter(): Router {
  const router = Router();

  // Pattern State Machine
  const activeMachines = new Map<string, PatternStateMachine>();

  router.post('/api/state-machine/create', (req, res) => {
    const { pattern } = req.body ?? {};
    if (!pattern) {
      return res.status(400).json({ error: 'pattern is required (orchestrator-worker, hierarchical, swarm, pipeline)' });
    }
    try {
      const machine = PatternStateMachineFactory.create(pattern);
      const machineId = `sm-${Date.now()}`;
      activeMachines.set(machineId, machine);
      res.json({
        machineId,
        pattern,
        currentState: machine.getCurrentState().currentStep,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/state-machine/:machineId/transition', async (req, res) => {
    const { machineId } = req.params;
    const { targetState } = req.body ?? {};
    const machine = activeMachines.get(machineId);
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    if (!targetState) {
      return res.status(400).json({ error: 'targetState is required' });
    }
    try {
      const result = await machine.transition(targetState);
      res.json({ result, currentState: machine.getCurrentState() });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/state-machine/:machineId', (req, res) => {
    const { machineId } = req.params;
    const machine = activeMachines.get(machineId);
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    res.json({ machineId, currentState: machine.getCurrentState() });
  });

  // Sequential Executor
  const pipelineRuns = new Map<string, any>();
  const sequentialExecutor = new SequentialExecutor({
    agentExecutor: createMockAgentExecutor(),
    runContextProvider: (async (ctx: { projectId?: string }) => ({
      projectId: ctx?.projectId ?? 'default',
      run: { runId: 'run', issuedAt: new Date().toISOString() },
      slimSnapshot: {
        project: { id: 'default', codename: 'default', objective: '', status: 'ACTIVE', updatedAt: new Date().toISOString() },
        missionBoard: { running: [], blocked: [], planned: [], done: [] },
        battleMetrics: { health: 'GREEN', runningMissionCount: 0, blockedMissionCount: 0, completedMissionCount: 0, highRiskMissionCount: 0, manualGovernanceMissionCount: 0, logVolume24h: 0, completionRate: 0 },
      },
      recentMemory: [],
      recommendedMemory: { items: [] },
      agentRoster: [],
    })),
  });

  router.post('/api/pipeline/execute', async (req, res) => {
    const { id, name, projectId, steps, input } = req.body ?? {};
    if (!id || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'id and steps[] are required' });
    }
    const now = new Date().toISOString();
    const pipeline = {
      id,
      name: name ?? id,
      projectId: projectId ?? 'default',
      steps: steps.map((s: any, i: number) => ({
        id: s.id ?? `step-${i}`,
        agentId: s.agentId ?? 'agent-default',
        name: s.name ?? `Step ${i + 1}`,
        input: s.input,
        timeoutMs: s.timeoutMs,
        retries: s.retries,
      })),
      createdAt: now,
      updatedAt: now,
    };
    try {
      const run = await sequentialExecutor.execute(pipeline as SequentialPipeline, { input });
      pipelineRuns.set(run.id, run);
      res.json(run);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/api/pipeline/runs/:runId', (req, res) => {
    const run = pipelineRuns.get(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  router.get('/api/pipeline/runs', (_req, res) => {
    res.json(Array.from(pipelineRuns.values()));
  });

  // Agent Benchmark Runner
  router.post('/api/benchmark/run', async (req, res) => {
    const { tasks, maxConcurrency, name: benchName } = req.body ?? {};
    const benchmarkTasks = tasks ?? createCommanderHealthCheckBenchmark();
    const runner = new AgentBenchmarkRunner({
      name: benchName ?? 'Commander Health Check',
      tasks: benchmarkTasks,
      maxConcurrency: maxConcurrency ?? 1,
      executor: { execute: async (prompt: string) => `Benchmark response for: ${prompt}` },
    });
    try {
      const result = await runner.run();
      const visualization = visualizeBenchmark(result);
      res.json({ result, visualization });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/benchmark/health-check-tasks', (_req, res) => {
    const tasks = createCommanderHealthCheckBenchmark();
    res.json({ tasks, count: tasks.length });
  });

  return router;
}
