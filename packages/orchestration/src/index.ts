/**
 * @commander/orchestration — WorkGraph planner package (Architecture V2).
 * Strangler re-export from @commander/core until fission completes.
 */

export type PlannerProfile =
  | 'run'
  | 'swarm'
  | 'drive'
  | 'goal'
  | 'company';

export type WorkNodeKind = 'deliberate' | 'decompose' | 'execute' | 'synthesize' | 'gate' | 'human';

export interface WorkNode {
  id: string;
  kind: WorkNodeKind;
  label: string;
  dependsOn: string[];
  payload: Record<string, unknown>;
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
    metadata: { topology, maxAgents, ...input.metadata },
  };
}

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
    default:
      return 'run';
  }
}
