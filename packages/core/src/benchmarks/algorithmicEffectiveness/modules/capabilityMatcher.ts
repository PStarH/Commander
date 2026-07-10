import { CapabilityMatcher } from '../../../runtime/capabilityMatcher';
import type { CapabilityProfile } from '../../../runtime/capabilityMatcher';
import type { BenchmarkModule, Task, LLMClient } from '../types';

interface AgentPool {
  matcher: CapabilityMatcher;
  select: (task: Task) => Promise<string>;
}

/**
 * Benchmark agent pool. The first agent (generalist-alpha) is the naive
 * first-available pick and lacks the specialized capabilities required by the
 * task suite. Later agents are specialists that fully cover specific
 * requirement sets.
 */
const agents: CapabilityProfile[] = [
  {
    agentId: 'generalist-alpha',
    capabilities: ['typescript', 'javascript', 'python', 'debugging', 'testing'],
    tools: ['file_read', 'file_write', 'shell_execute'],
    modelTier: 'standard',
    costPerToken: 0.001,
    qualityScore: 0.8,
    speedScore: 0.8,
    role: 'nucleus',
    specialization: 0.4,
    available: true,
    activeTasks: 0,
    maxConcurrent: 3,
  },
  {
    agentId: 'security-specialist',
    capabilities: ['security', 'vulnerability_analysis', 'docker', 'devops', 'api'],
    tools: ['file_read', 'code_search', 'web_search'],
    modelTier: 'power',
    costPerToken: 0.002,
    qualityScore: 0.9,
    speedScore: 0.6,
    role: 'electron',
    specialization: 0.9,
    available: true,
    activeTasks: 0,
    maxConcurrent: 1,
  },
  {
    agentId: 'data-specialist',
    capabilities: ['sql', 'database', 'data_modeling', 'python'],
    tools: ['file_read', 'shell_execute'],
    modelTier: 'power',
    costPerToken: 0.002,
    qualityScore: 0.88,
    speedScore: 0.65,
    role: 'electron',
    specialization: 0.9,
    available: true,
    activeTasks: 0,
    maxConcurrent: 1,
  },
  {
    agentId: 'frontend-specialist',
    capabilities: ['react', 'css', 'accessibility', 'typescript'],
    tools: ['file_read', 'file_write', 'code_search'],
    modelTier: 'standard',
    costPerToken: 0.001,
    qualityScore: 0.85,
    speedScore: 0.75,
    role: 'electron',
    specialization: 0.85,
    available: true,
    activeTasks: 0,
    maxConcurrent: 1,
  },
  {
    agentId: 'ml-specialist',
    capabilities: ['machine_learning', 'pytorch', 'python', 'data_analysis'],
    tools: ['file_read', 'shell_execute', 'python_execute'],
    modelTier: 'power',
    costPerToken: 0.0025,
    qualityScore: 0.9,
    speedScore: 0.6,
    role: 'electron',
    specialization: 0.95,
    available: true,
    activeTasks: 0,
    maxConcurrent: 1,
  },
];

const expectedAgentByTask: Record<string, string> = {
  'container-security-audit': 'security-specialist',
  'database-schema-design': 'data-specialist',
  'accessible-react-component': 'frontend-specialist',
  'pytorch-classifier': 'ml-specialist',
  'oauth2-api-gateway': 'security-specialist',
};

const taskSuite: Task[] = [
  {
    id: 'container-security-audit',
    prompt:
      'Audit a Dockerfile for known CVEs and recommend a hardened base image.',
    expected: (output: string) =>
      output === expectedAgentByTask['container-security-audit'],
  },
  {
    id: 'database-schema-design',
    prompt:
      'Design a normalized schema and write migration scripts for a PostgreSQL database.',
    expected: (output: string) =>
      output === expectedAgentByTask['database-schema-design'],
  },
  {
    id: 'accessible-react-component',
    prompt:
      'Build an accessible React component with keyboard navigation and ARIA roles.',
    expected: (output: string) =>
      output === expectedAgentByTask['accessible-react-component'],
  },
  {
    id: 'pytorch-classifier',
    prompt:
      'Train a small PyTorch classifier and evaluate its precision and recall.',
    expected: (output: string) =>
      output === expectedAgentByTask['pytorch-classifier'],
  },
  {
    id: 'oauth2-api-gateway',
    prompt:
      'Investigate an OAuth2 misconfiguration in an API gateway deployment.',
    expected: (output: string) =>
      output === expectedAgentByTask['oauth2-api-gateway'],
  },
];

function createFreshMatcher(): CapabilityMatcher {
  const matcher = new CapabilityMatcher();
  // Remove the default nucleus agents so the benchmark uses an isolated pool.
  for (const agent of matcher.getPool()) {
    matcher.removeAgent(agent.agentId);
  }
  for (const agent of agents) {
    matcher.registerAgent(agent);
  }
  return matcher;
}

export const capabilityMatcherModule: BenchmarkModule = {
  id: 'capabilityMatcher',
  name: 'Capability Matcher',
  description:
    'Validates that CapabilityMatcher selects specialized agents that fully cover task requirements, outperforming a naive first-available baseline.',
  path: 'runtime/capabilityMatcher.ts',
  baselineFactory: () => {
    const matcher = createFreshMatcher();
    return {
      matcher,
      select: async () => {
        // Naive strategy: pick the first available agent in insertion order.
        const first = matcher.getAvailableAgents()[0];
        return first?.agentId ?? 'none';
      },
    };
  },
  treatmentFactory: ({ llm }: { llm: LLMClient }) => {
    const matcher = createFreshMatcher();
    return {
      matcher,
      select: async (task: Task) => {
        // Embedding similarity step: scripted LLM maps the natural-language
        // prompt to a structured capability list.
        const response = await llm.complete(task.prompt);
        const requiredCapabilities = JSON.parse(response.text) as string[];

        // Capability coverage step: matcher selects the best specialist.
        const result = await matcher.match({
          requiredCapabilities,
          complexity: 5,
          priority: 5,
          maxAgents: 1,
        });

        return result.agents[0]?.agentId ?? 'none';
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as AgentPool;
    const agentId = await impl.select(task);
    return {
      output: agentId,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
