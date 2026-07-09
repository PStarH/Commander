import { BM25ToolDiscovery } from '../../../runtime/bm25ToolDiscovery';
import type { ToolDefinition } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

interface ToolDiscoveryTask extends Task {
  expectedTool: string;
}

/**
 * A small registry of tools with keyword-rich descriptions.
 * Only a subset is relevant for any given synthetic task.
 */
const tools: ToolDefinition[] = [
  {
    name: 'email/send',
    description:
      'Send an email message to a recipient. Provide subject, body, and recipient address.',
    inputSchema: {},
    category: 'communication',
  },
  {
    name: 'file/read',
    description:
      'Read the contents of a file from the local filesystem. Returns file text or bytes.',
    inputSchema: {},
    category: 'filesystem',
  },
  {
    name: 'shell/exec',
    description: 'Execute a shell command on the local machine. Runs the provided command string.',
    inputSchema: {},
    category: 'system',
  },
  {
    name: 'web/search',
    description: 'Search the web for relevant pages and return a summary of the top results.',
    inputSchema: {},
    category: 'web',
  },
  {
    name: 'calendar/list',
    description: 'List upcoming calendar events and meetings for the configured account.',
    inputSchema: {},
    category: 'productivity',
  },
];

const taskSuite: ToolDiscoveryTask[] = [
  {
    id: 'send-email',
    prompt: 'send an email',
    expectedTool: 'email/send',
    expected: (output: string) => output.includes('email/send'),
  },
  {
    id: 'read-file',
    prompt: 'read a file',
    expectedTool: 'file/read',
    expected: (output: string) => output.includes('file/read'),
  },
  {
    id: 'run-shell',
    prompt: 'run a shell command',
    expectedTool: 'shell/exec',
    expected: (output: string) => output.includes('shell/exec'),
  },
  {
    id: 'search-web',
    prompt: 'search the web',
    expectedTool: 'web/search',
    expected: (output: string) => output.includes('web/search'),
  },
  {
    id: 'list-calendar',
    prompt: 'list calendar events',
    expectedTool: 'calendar/list',
    expected: (output: string) => output.includes('calendar/list'),
  },
];

interface BaselineImpl {
  activeTools: string[];
}

interface TreatmentImpl {
  discovery: BM25ToolDiscovery;
  activeTools: Set<string>;
}

export const bm25ToolDiscoveryModule: BenchmarkModule = {
  id: 'bm25ToolDiscovery',
  name: 'BM25 Tool Discovery',
  description:
    'Validates that BM25-based tool discovery dynamically activates the tools relevant to a task, outperforming a fixed activation baseline.',
  path: 'runtime/bm25ToolDiscovery.ts',
  baselineFactory: () => ({
    // Fixed activation: always enable the same two tools regardless of task.
    activeTools: ['web/search', 'calendar/list'],
  }),
  treatmentFactory: () => {
    const discovery = new BM25ToolDiscovery();
    discovery.registerTools(tools);
    return {
      discovery,
      activeTools: new Set<string>(),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const t = task as ToolDiscoveryTask;

    if ('discovery' in (implementation as TreatmentImpl)) {
      const impl = implementation as TreatmentImpl;
      // Reset activation state so each trial is independent.
      impl.discovery.resetActivations();
      const activations = impl.discovery.discover(t.prompt, impl.activeTools, 3);
      const output = JSON.stringify(activations.map((a) => a.toolName));
      return {
        output,
        tokenUsage: { input: 0, output: 1, total: 1, cached: 0, reasoning: 0 },
        latencyMs: 1,
      };
    }

    const impl = implementation as BaselineImpl;
    const output = JSON.stringify(impl.activeTools);
    return {
      output,
      tokenUsage: { input: 0, output: 1, total: 1, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
