/**
 * HandoffTool — Agent-to-Agent Task Handoff
 *
 * Allows the LLM to initiate a handoff to another agent, passing context
 * and waiting for acceptance/rejection. Wraps AgentHandoff infrastructure.
 *
 * Research backing: Claude Code's agent handoff pattern, AutoGen's GroupChatManager.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import type { AgentHandoff } from '../runtime/agentHandoff';
import { getGlobalLogger } from '../logging';

export class HandoffTool implements Tool {
  definition: ToolDefinition = {
    name: 'handoff',
    description: 'Hand off the current task to another agent. Passes context, conversation history, and available tools. The target agent receives the handoff as a high-priority inbox message. Use when: the task requires a different expertise, you need to delegate a subtask to a specialist, or you want to transfer control entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgent: { type: 'string', description: 'Target agent ID or name' },
        goal: { type: 'string', description: 'What the target agent should accomplish' },
        context: { type: 'string', description: 'Additional context to pass (current progress, findings, constraints)' },
        tokenBudget: { type: 'number', description: 'Token budget for the target agent (default: 25000)', default: 25000 },
      },
      required: ['toAgent', 'goal'],
    },
    examples: [
      { name: 'handoff', arguments: { toAgent: 'security-expert', goal: 'Review the authentication module for vulnerabilities', context: 'Found 3 potential issues in authManager.ts' } },
    ],
    category: 'development',
  };

  isConcurrencySafe = false;
  isReadOnly = false;

  private handoff: AgentHandoff;
  private agentId: string;

  constructor(handoff: AgentHandoff, agentId: string) {
    this.handoff = handoff;
    this.agentId = agentId;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const toAgent = String(args.toAgent ?? '');
    const goal = String(args.goal ?? '');
    const context = String(args.context ?? '');
    const tokenBudget = Number(args.tokenBudget ?? 25000);

    if (!toAgent) return 'Error: toAgent is required';
    if (!goal) return 'Error: goal is required';

    try {
      const handoffId = `ho_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const result = await this.handoff.request({
        handoffId,
        fromAgent: this.agentId,
        toAgent,
        goal,
        context: {
          messages: context ? [{ role: 'system', content: context }] : [],
          availableTools: [],
          tokenBudget,
        },
      });

      getGlobalLogger().info('HandoffTool', `Handoff initiated: ${handoffId} → ${toAgent}`);

      // Wait for acceptance/rejection (poll with timeout)
      const timeoutMs = 60_000; // 1 minute to accept
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const status = this.handoff.getHandoff(handoffId);
        if (status?.status === 'accepted') {
          return `Handoff accepted by ${toAgent}. Goal: ${goal}\nContext passed: ${context ? 'yes' : 'no'}\nToken budget: ${tokenBudget}`;
        }
        if (status?.status === 'rejected') {
          return `Handoff rejected by ${toAgent}: ${status.response ?? 'no reason given'}`;
        }
        if (status?.status === 'completed') {
          return `Handoff completed by ${toAgent}.\nResult: ${status.response ?? '(no response)'}`;
        }
        if (status?.status === 'failed') {
          return `Handoff failed: ${status.response ?? 'unknown error'}`;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return `Handoff ${handoffId} sent to ${toAgent}. Waiting for acceptance... (use handoff_check to poll status)`;
    } catch (err) {
      return `Error initiating handoff: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * HandoffCheckTool — Check status of a pending handoff
 */
export class HandoffCheckTool implements Tool {
  definition: ToolDefinition = {
    name: 'handoff_check',
    description: 'Check the status of a pending handoff. Returns current status (requested/accepted/rejected/completed/failed) and any response from the target agent.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string', description: 'The handoff ID returned by the handoff tool' },
      },
      required: ['handoffId'],
    },
    examples: [
      { name: 'handoff_check', arguments: { handoffId: 'ho_1234567890_abc' } },
    ],
    category: 'development',
  };

  isConcurrencySafe = true;
  isReadOnly = true;

  private handoff: AgentHandoff;

  constructor(handoff: AgentHandoff) {
    this.handoff = handoff;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const handoffId = String(args.handoffId ?? '');
    if (!handoffId) return 'Error: handoffId is required';

    const status = this.handoff.getHandoff(handoffId);
    if (!status) return `No handoff found with ID: ${handoffId}`;

    const parts = [
      `Handoff: ${handoffId}`,
      `Status: ${status.status}`,
      `From: ${status.fromAgent} → To: ${status.toAgent}`,
      `Goal: ${status.goal}`,
    ];
    if (status.response) parts.push(`Response: ${status.response}`);
    if (status.resolvedAt) parts.push(`Resolved: ${status.resolvedAt}`);

    return parts.join('\n');
  }
}
