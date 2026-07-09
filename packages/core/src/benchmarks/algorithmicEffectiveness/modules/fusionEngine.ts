import { FusionEngine } from '../../../swarm/fusionEngine';
import type { SwarmNode } from '../../../swarm/types';
import type { BenchmarkModule, Task } from '../types';

interface FusionTask extends Task {
  nodes: SwarmNode[];
}

function makeNode(
  id: string,
  goal: string,
  output: string,
  dependencies: string[] = [],
): SwarmNode {
  return {
    id,
    goal,
    parentId: null,
    status: 'completed',
    workerOutput: output,
    subNodes: [],
    children: [],
    dependencies,
  };
}

function consensusFrom(nodes: SwarmNode[]): string {
  const outputs = nodes
    .map((n) => n.workerOutput)
    .filter((o): o is string => typeof o === 'string' && o.length > 0);
  const unique = [...new Set(outputs)];
  return unique.join(' | ');
}

const CONFLICT_MARKER = 'CONFLICT';

const taskSuite: FusionTask[] = [
  {
    id: 'consistent-bearer-auth',
    prompt: 'Swarm agrees on the API authentication method.',
    nodes: [
      makeNode('a1', 'auth method', "Set the Authorization header to 'Bearer <token>'."),
      makeNode('a2', 'auth method', "Set the Authorization header to 'Bearer <token>'."),
      makeNode('a3', 'auth method', "Set the Authorization header to 'Bearer <token>'."),
    ],
    expected: (output: string) => output.includes('Bearer'),
  },
  {
    id: 'conflicting-file-edits',
    prompt: 'Two workers edit the same file in incompatible ways.',
    nodes: [
      makeNode('f1', 'auth implementation', 'Add OAuth login to `src/auth.ts`.'),
      makeNode('f2', 'auth implementation', 'Add SAML login to `src/auth.ts`.'),
      makeNode('f3', 'auth implementation', 'Configure session middleware in `src/middleware.ts`.'),
    ],
    expected: (output: string) =>
      output.includes(CONFLICT_MARKER) || output.includes('NO_CONSENSUS'),
  },
  {
    id: 'dependency-cycle',
    prompt: 'Two workers depend on each other, creating a circular dependency.',
    nodes: [
      makeNode('c1', 'step one', 'Completed step one.', ['c2']),
      makeNode('c2', 'step two', 'Completed step two.', ['c1']),
    ],
    expected: (output: string) =>
      output.includes(CONFLICT_MARKER) || output.includes('NO_CONSENSUS'),
  },
  {
    id: 'consistent-docker-deploy',
    prompt: 'Swarm agrees on the deployment method.',
    nodes: [
      makeNode('d1', 'deploy', 'Deploy the service using docker compose.'),
      makeNode('d2', 'deploy', 'Deploy the service using docker compose.'),
      makeNode('d3', 'deploy', 'Deploy the service using docker compose.'),
    ],
    expected: (output: string) => output.includes('docker'),
  },
  {
    id: 'resource-port-conflict',
    prompt: 'Two workers claim the same network port.',
    nodes: [
      makeNode('p1', 'backend port', 'Run the backend on port number 8080.'),
      makeNode('p2', 'gateway port', 'Run the gateway on port number 8080.'),
      makeNode('p3', 'worker port', 'Run the queue worker on port number 8081.'),
    ],
    expected: (output: string) =>
      output.includes(CONFLICT_MARKER) || output.includes('NO_CONSENSUS'),
  },
];

export const fusionEngineModule: BenchmarkModule = {
  id: 'fusionEngine',
  name: 'Fusion Engine',
  description:
    'Validates that FusionEngine conflict detection outperforms naive first-node answer selection in a synthetic swarm.',
  path: 'swarm/fusionEngine.ts',
  baselineFactory: () => ({
    select: (task: FusionTask) => {
      // Naive baseline: trust the first worker, ignore conflicts.
      const first = task.nodes[0];
      return first?.workerOutput ?? '';
    },
  }),
  treatmentFactory: () => {
    const engine = new FusionEngine();
    return {
      select: (task: FusionTask) => {
        const report = engine.analyze(task.nodes, 1);
        if (report.conflicts.length > 0) {
          return CONFLICT_MARKER;
        }
        return consensusFrom(task.nodes);
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as { select: (task: FusionTask) => string };
    const fusionTask = task as unknown as FusionTask;
    const output = impl.select(fusionTask);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
