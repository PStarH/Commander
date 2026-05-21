/**
 * A2ADelegateTool — lets Commander agents delegate tasks to remote A2A agents.
 *
 * Agents call this tool with an agent label and task description.
 * The tool looks up the agent in A2ADiscoveryManager, sends the task
 * via JSON-RPC, waits for completion, and returns the result.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import type { A2ADiscoveryManager } from '../mcp/a2aClient';

const DEFINITION: ToolDefinition = {
  name: 'a2a_delegate',
  description: 'Delegate a task to a remote A2A-compatible agent. Use this when a task requires specialized capabilities (research, deep analysis, code review) that another agent in the network can handle. Returns the remote agent\'s response.',
  inputSchema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Label of the target A2A agent (e.g., "research-agent", "code-reviewer"). Use "list" to see available agents.',
      },
      task: {
        type: 'string',
        description: 'The task description to send to the remote agent.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for the remote agent to complete before returning (default: true).',
      },
      timeout: {
        type: 'number',
        description: 'Maximum wait time in ms (default: 120000, max: 300000).',
      },
    },
    required: ['agent', 'task'],
  },
};

export class A2ADelegateTool implements Tool {
  readonly definition = DEFINITION;
  readonly isConcurrencySafe = true;
  readonly isReadOnly = false;
  readonly timeout = 300000;
  readonly maxOutputSize = 100000;

  private discoveryManager: A2ADiscoveryManager;

  constructor(discoveryManager: A2ADiscoveryManager) {
    this.discoveryManager = discoveryManager;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const agentLabel = String(args.agent || '');
    const task = String(args.task || '');
    const wait = args.wait !== false;
    const timeout = Math.min(Number(args.timeout) || 120000, 300000);

    if (agentLabel === 'list') {
      const agents = this.discoveryManager.getAllAgents();
      if (agents.length === 0) {
        return 'No A2A agents are currently connected. Configure them in .commander.json under a2a.remoteAgents.';
      }
      return agents.map(a =>
        `- ${a.label}: ${a.card.name} (${a.url}) — ${a.card.description.slice(0, 100)}`
      ).join('\n');
    }

    const agent = this.discoveryManager.getAgent(agentLabel);
    if (!agent) {
      const available = this.discoveryManager.getAllAgents().map(a => a.label).join(', ') || 'none';
      return `Unknown A2A agent "${agentLabel}". Available agents: ${available}. Use agent="list" to see details.`;
    }

    const client = agent.client;

    const message = {
      messageId: `msg_${Date.now()}`,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: task }],
    };

    try {
      const taskResult = await client.sendMessage(message);

      if (!wait) {
        return `Task ${taskResult.id} submitted to "${agentLabel}". Poll with a2a_delegate agent="${agentLabel}" task="tasks/get:${taskResult.id}" or check via the agent's native endpoint.`;
      }

      const completed = await client.waitForTask(taskResult.id, 1000, timeout);

      if (completed.status.state === 'COMPLETED') {
        const artifacts = completed.artifacts ?? [];
        const texts = artifacts.flatMap(a =>
          a.parts.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text)
        );
        const resultText = texts.join('\n\n') || `Task completed with no output artifacts.`;
        return `[A2A "${agentLabel}" completed]\n\n${resultText.slice(0, 50000)}`;
      }

      return `[A2A "${agentLabel}" ${completed.status.state}]\n${completed.status.message || 'No details'}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[A2A "${agentLabel}" error]\n${msg}`;
    }
  }
}
