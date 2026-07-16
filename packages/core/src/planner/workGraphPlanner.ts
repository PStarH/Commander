/**
 * WorkGraph Planner — Architecture V2 single orchestration entry.
 *
 * Collapses Ultimate / Swarm / Drive / Goal / Company into planner *profiles*
 * that compile a task into a durable WorkGraph. Execution is owned by ATR;
 * this module never talks to providers or tools directly.
 */

export type PlannerProfile =
  | 'run' // default Ultimate-style deliberation → topology → execute
  | 'swarm' // recursive decomposition + parallel
  | 'drive' // autonomous step-by-step
  | 'goal' // multi-round convergence
  | 'company'; // quality gating + memory

export type WorkNodeKind = 'deliberate' | 'decompose' | 'execute' | 'synthesize' | 'gate' | 'human';

export interface WorkNode {
  id: string;
  kind: WorkNodeKind;
  label: string;
  dependsOn: string[];
  /** Profile-specific payload (opaque to the kernel). */
  payload: Record<string, unknown>;
  /** When true, node maps to a durable ATR Run. */
  durable: boolean;
}

export interface WorkGraph {
  graphId: string;
  profile: PlannerProfile;
  goal: string;
  tenantId?: string;
  createdAt: string;
  nodes: WorkNode[];
  metadata: Record<string, unknown>;
}

export interface PlanInput {
  goal: string;
  profile?: PlannerProfile;
  tenantId?: string;
  /** Force topology hint (SINGLE | CHAIN | DISPATCH | ORCHESTRATOR | REVIEW). */
  topologyHint?: string;
  maxAgents?: number;
  metadata?: Record<string, unknown>;
}

const PROFILE_DEFAULTS: Record<
  PlannerProfile,
  { topology: string; maxAgents: number; label: string }
> = {
  run: { topology: 'ORCHESTRATOR', maxAgents: 5, label: 'Standard run' },
  swarm: { topology: 'DISPATCH', maxAgents: 10, label: 'Swarm parallel' },
  drive: { topology: 'CHAIN', maxAgents: 3, label: 'Drive sequential' },
  goal: { topology: 'ORCHESTRATOR', maxAgents: 8, label: 'Goal convergence' },
  company: { topology: 'REVIEW', maxAgents: 6, label: 'Company quality' },
};

function nodeId(prefix: string, i: number): string {
  return `${prefix}_${i}`;
}

const EFFECT_TOOL_PATTERNS = [
  'send_email',
  'forward_email',
  'email_send',
  'post_message',
  'git_push',
  'transfer_money',
  'bank_transfer',
  'delete_file',
  'file_delete',
  'shell_execute',
  'python_execute',
  'mcp__',
  'web_fetch',
];

/**
 * Scan a WorkGraph for any node that references an external side-effect tool
 * in its payload.tools or payload.goal.
 */
export function workGraphContainsEffect(graph: WorkGraph): boolean {
  for (const node of graph.nodes) {
    const payloadTools = node.payload?.tools as string[] | undefined;
    if (Array.isArray(payloadTools)) {
      for (const tool of payloadTools) {
        if (
          typeof tool === 'string' &&
          EFFECT_TOOL_PATTERNS.some((p) => tool === p || tool.startsWith(p))
        ) {
          return true;
        }
      }
    }
    const goal = String(node.payload?.goal ?? '');
    if (EFFECT_TOOL_PATTERNS.some((p) => goal.includes(p))) return true;
  }
  return false;
}

/**
 * Compile a task + profile into a WorkGraph. Pure function — no I/O.
 */
export function planWorkGraph(input: PlanInput): WorkGraph {
  const profile: PlannerProfile = input.profile ?? 'run';
  const defaults = PROFILE_DEFAULTS[profile];
  const topology = input.topologyHint ?? defaults.topology;
  const maxAgents = input.maxAgents ?? defaults.maxAgents;
  const createdAt = new Date().toISOString();
  const graphId = `wg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const nodes: WorkNode[] = [];

  nodes.push({
    id: nodeId('deliberate', 0),
    kind: 'deliberate',
    label: 'Classify task and select topology',
    dependsOn: [],
    payload: { topology, profile, maxAgents },
    durable: false,
  });

  if (profile === 'swarm' || profile === 'goal' || profile === 'company' || topology !== 'SINGLE') {
    nodes.push({
      id: nodeId('decompose', 1),
      kind: 'decompose',
      label: 'Decompose into subtasks',
      dependsOn: [nodeId('deliberate', 0)],
      payload: { strategy: profile === 'drive' ? 'STEP' : 'RECURSIVE', maxAgents },
      durable: false,
    });
  }

  const execDepends = nodes.find((n) => n.kind === 'decompose')?.id ?? nodeId('deliberate', 0);

  nodes.push({
    id: nodeId('execute', 2),
    kind: 'execute',
    label: `${defaults.label} execution`,
    dependsOn: [execDepends],
    payload: { topology, maxAgents, profile },
    durable: true,
  });

  if (profile !== 'drive') {
    nodes.push({
      id: nodeId('synthesize', 3),
      kind: 'synthesize',
      label: 'Synthesize agent outputs',
      dependsOn: [nodeId('execute', 2)],
      payload: { strategy: profile === 'company' ? 'LEAD_SYNTHESIS' : 'ENSEMBLE' },
      durable: false,
    });
  }

  const gateDepends = nodes.find((n) => n.kind === 'synthesize')?.id ?? nodeId('execute', 2);

  nodes.push({
    id: nodeId('gate', 4),
    kind: 'gate',
    label: profile === 'company' ? 'Strict quality gates' : 'Quality gates',
    dependsOn: [gateDepends],
    payload: {
      gates: ['hallucination', 'consistency', 'completeness', 'accuracy', 'safety'],
      strict: profile === 'company',
    },
    durable: false,
  });

  return {
    graphId,
    profile,
    goal: input.goal,
    tenantId: input.tenantId,
    createdAt,
    nodes,
    metadata: {
      topology,
      maxAgents,
      ...input.metadata,
    },
  };
}

/**
 * Map legacy CLI verbs to planner profiles.
 */
export function profileFromCliVerb(verb: string): PlannerProfile {
  switch (verb.toLowerCase()) {
    case 'swarm':
      return 'swarm';
    case 'drive':
      return 'drive';
    case 'goal':
      return 'goal';
    case 'company':
      return 'company';
    case 'run':
    default:
      return 'run';
  }
}

export interface WorkGraphExecutor {
  execute(goal: string, graph: WorkGraph): Promise<unknown>;
}

/**
 * Execute a WorkGraph via an injected executor (strangler facade).
 * The planner never constructs UltimateOrchestrator itself — callers wire
 * the legacy engine until package fission completes.
 */
export async function executeWorkGraph(
  graph: WorkGraph,
  options?: { dryRun?: boolean; executor?: WorkGraphExecutor },
): Promise<{
  graphId: string;
  profile: PlannerProfile;
  status: 'planned' | 'success' | 'failed' | 'partial';
  summary: string;
  result?: unknown;
}> {
  // WS2 §9: the compat shim broker-presence gate is removed. The sole PEP for
  // external side effects is the EffectBroker wired in worker-plane bootstrap;
  // the planner delegates execution to the supplied executor (which routes
  // through the broker) and trusts that wiring. No global bypass remains.

  if (options?.dryRun || !options?.executor) {
    return {
      graphId: graph.graphId,
      profile: graph.profile,
      status: 'planned',
      summary:
        `Planned ${graph.nodes.length} nodes for profile=${graph.profile}` +
        (options?.executor ? '' : ' (no executor — dry plan)'),
    };
  }

  try {
    const result = await options.executor.execute(graph.goal, graph);
    return {
      graphId: graph.graphId,
      profile: graph.profile,
      status: 'success',
      summary: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 500),
      result,
    };
  } catch (err) {
    return {
      graphId: graph.graphId,
      profile: graph.profile,
      status: 'failed',
      summary: (err as Error).message,
    };
  }
}

export class OrchestrationPlanner {
  plan(input: PlanInput): WorkGraph {
    return planWorkGraph(input);
  }

  async run(
    goal: string,
    profile: PlannerProfile = 'run',
    options?: { dryRun?: boolean; tenantId?: string; executor?: WorkGraphExecutor },
  ) {
    const graph = this.plan({ goal, profile, tenantId: options?.tenantId });
    return executeWorkGraph(graph, {
      dryRun: options?.dryRun,
      executor: options?.executor,
    });
  }
}

let plannerSingleton: OrchestrationPlanner | null = null;

export function getOrchestrationPlanner(): OrchestrationPlanner {
  if (!plannerSingleton) plannerSingleton = new OrchestrationPlanner();
  return plannerSingleton;
}
