import type { BenchmarkModule, Task } from '../types';
import { ReversibilityGate } from '../../../security/reversibilityGate';

interface ReversibilityTask extends Task {
  toolName: string;
  args?: Record<string, unknown>;
  expected: (output: string) => boolean;
}

const taskSuite: ReversibilityTask[] = [
  {
    id: 'read-file',
    prompt: 'Reversible read',
    toolName: 'read_file',
    args: { path: 'README.md' },
    expected: (out) => out === 'allowed',
  },
  {
    id: 'list-directory',
    prompt: 'Reversible list',
    toolName: 'list_directory',
    expected: (out) => out === 'allowed',
  },
  {
    id: 'search-code',
    prompt: 'Reversible search',
    toolName: 'search_code',
    args: { query: 'foo' },
    expected: (out) => out === 'allowed',
  },
  {
    id: 'git-push',
    prompt: 'Irreversible git push',
    toolName: 'git_push',
    expected: (out) => out === 'requires_approval',
  },
  {
    id: 'shell-execute',
    prompt: 'Irreversible shell',
    toolName: 'shell_execute',
    args: { command: 'rm -rf /' },
    expected: (out) => out === 'requires_approval',
  },
  {
    id: 'python-execute',
    prompt: 'Irreversible python',
    toolName: 'python_execute',
    args: { code: 'import os; os.system("curl...")' },
    expected: (out) => out === 'requires_approval',
  },
  {
    id: 'web-fetch',
    prompt: 'Irreversible web fetch',
    toolName: 'web_fetch',
    args: { url: 'https://example.com' },
    expected: (out) => out === 'requires_approval',
  },
  {
    id: 'mcp-tool',
    prompt: 'Irreversible MCP',
    toolName: 'mcp__some_tool',
    expected: (out) => out === 'requires_approval',
  },
];

const noUsage = { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 };

export const reversibilityGateModule: BenchmarkModule = {
  id: 'reversibilityGate',
  name: 'Reversibility Gate',
  description:
    'Validates that the ReversibilityGate classifies reversible tools as allowed and irreversible tools as requiring approval.',
  path: 'security/reversibilityGate.ts',
  baselineFactory: () => ({
    evaluate: async () => ({ allowed: true, requiresHumanApproval: false }),
  }),
  treatmentFactory: () => {
    const gate = new ReversibilityGate();
    return {
      evaluate: async (task: ReversibilityTask) =>
        gate.evaluate(task.toolName, task.args ?? {}),
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      evaluate: (t: ReversibilityTask) => Promise<{ allowed: boolean; requiresHumanApproval: boolean }>;
    };
    const decision = await impl.evaluate(task as ReversibilityTask);
    const output = decision.allowed ? 'allowed' : 'requires_approval';
    return { output, tokenUsage: noUsage, latencyMs: 1 };
  },
  taskSuite: taskSuite as unknown as Task[],
  metrics: ['successRate'],
};
