/**
 * WorkGraph planner unit tests — Architecture V2 orchestrator collapse.
 */

import { describe, it, expect } from 'vitest';
import {
  planWorkGraph,
  profileFromCliVerb,
  OrchestrationPlanner,
  executeWorkGraph,
  workGraphContainsEffect,
  type WorkGraph,
} from '../../src/planner/workGraphPlanner';

function graphWithEffectTool(tool: string): WorkGraph {
  const graph = planWorkGraph({ goal: 'perform side effect', profile: 'run' });
  const executeNode = graph.nodes.find((n) => n.kind === 'execute');
  if (executeNode) {
    executeNode.payload.tools = [tool];
  }
  return graph;
}

describe('WorkGraph planner', () => {
  it('maps CLI verbs to profiles', () => {
    expect(profileFromCliVerb('swarm')).toBe('swarm');
    expect(profileFromCliVerb('drive')).toBe('drive');
    expect(profileFromCliVerb('goal')).toBe('goal');
    expect(profileFromCliVerb('company')).toBe('company');
    expect(profileFromCliVerb('run')).toBe('run');
  });

  it('plans a swarm graph with decompose + execute + synthesize + gate', () => {
    const g = planWorkGraph({ goal: 'audit repo', profile: 'swarm' });
    expect(g.profile).toBe('swarm');
    expect(g.nodes.some((n) => n.kind === 'decompose')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'execute' && n.durable)).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'synthesize')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'gate')).toBe(true);
  });

  it('drive profile skips synthesize', () => {
    const g = planWorkGraph({ goal: 'step through', profile: 'drive' });
    expect(g.nodes.some((n) => n.kind === 'synthesize')).toBe(false);
    expect(g.nodes.some((n) => n.kind === 'execute')).toBe(true);
  });

  it('OrchestrationPlanner dry-runs without executor', async () => {
    const planner = new OrchestrationPlanner();
    const result = await planner.run('hello', 'run', { dryRun: true });
    expect(result.status).toBe('planned');
    expect(result.summary).toMatch(/Planned/);
  });
});

describe('WorkGraph effect admission', () => {
  it('detects side-effect tools in payload.tools', () => {
    const graph = graphWithEffectTool('send_email');
    expect(workGraphContainsEffect(graph)).toBe(true);
  });

  it('detects side-effect tools in payload.goal', () => {
    const graph = planWorkGraph({ goal: 'hello world', profile: 'run' });
    const executeNode = graph.nodes.find((n) => n.kind === 'execute');
    if (executeNode) {
      executeNode.payload.goal = 'transfer_money to vendor';
    }
    expect(workGraphContainsEffect(graph)).toBe(true);
  });

  it('detects mcp__ prefixed tools', () => {
    const graph = graphWithEffectTool('mcp__send_email');
    expect(workGraphContainsEffect(graph)).toBe(true);
  });

  it('allows non-effect WorkGraph to execute', async () => {
    const graph = planWorkGraph({ goal: 'hello world', profile: 'run' });
    const result = await executeWorkGraph(graph, {
      executor: { execute: async () => 'done' },
    });
    expect(result.status).toBe('success');
    expect(result.summary).toBe('done');
  });

  it('dryRun bypasses effect admission check', async () => {
    const graph = graphWithEffectTool('send_email');
    const result = await executeWorkGraph(graph, { dryRun: true });
    expect(result.status).toBe('planned');
  });
});
