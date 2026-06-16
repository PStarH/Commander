/**
 * HandoffTool — Agent-to-Agent Task Handoff
 *
 * Allows the LLM to initiate a handoff to another agent, passing a typed
 * WorkOrder and a compressed ContextSummary instead of full chat history.
 * Wraps AgentHandoff infrastructure.
 *
 * Research backing: Claude Code's agent handoff pattern, AutoGen's GroupChatManager.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
import { AgentHandoff } from '../runtime/agentHandoff';
import { getGlobalLogger } from '../logging';

export class HandoffTool implements Tool {
  definition: ToolDefinition = {
    name: 'handoff',
    description: 'Hand off the current task to another agent using a structured work order and compressed context summary (no full history). The target agent receives the handoff as a high-priority inbox message. Use when: the task requires different expertise, you need to delegate a subtask, or you want to transfer control entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgent: { type: 'string', description: 'Target agent ID or name' },
        goal: { type: 'string', description: 'What the target agent should accomplish' },
        completedSteps: { type: 'array', items: { type: 'string' }, description: 'Steps already completed by the sending agent' },
        remainingTasks: { type: 'array', items: { type: 'string' }, description: 'Steps remaining for the receiving agent' },
        artifacts: { type: 'array', items: { type: 'object' }, description: 'Artifacts produced so far (name, type, reference)' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints or guardrails the receiving agent must respect' },
        contextSummary: { type: 'string', description: 'Optional free-form context summary (if omitted, a ≤500-token summary is generated from messages)' },
        messages: { type: 'array', items: { type: 'object' }, description: 'Conversation messages used to generate a context summary when contextSummary is omitted' },
        includeFullMessages: { type: 'boolean', description: 'Include full message history (not recommended; costs more tokens)' },
        tokenBudget: { type: 'number', description: 'Token budget for the target agent (default: 25000)', default: 25000 },
      },
      required: ['toAgent', 'goal'],
    },
    examples: [
      { name: 'handoff', arguments: { toAgent: 'security-expert', goal: 'Review the authentication module for vulnerabilities', completedSteps: ['Scanned authManager.ts'], remainingTasks: ['Check 3 potential issues'], constraints: ['Do not modify files without approval'] } },
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
    const tokenBudget = Number(args.tokenBudget ?? 25000);

    if (!toAgent) return 'Error: toAgent is required';
    if (!goal) return 'Error: goal is required';

    const completedSteps = Array.isArray(args.completedSteps) ? args.completedSteps.map(String) : [];
    const remainingTasks = Array.isArray(args.remainingTasks) ? args.remainingTasks.map(String) : [goal];
    const artifacts = Array.isArray(args.artifacts)
      ? args.artifacts.map((a) => {
          if (a && typeof a === 'object') return a as { name: string; type: string; reference: string };
          return { name: String(a), type: 'unknown', reference: String(a) };
        })
      : [];
    const constraints = Array.isArray(args.constraints) ? args.constraints.map(String) : [];
    const includeFullMessages = Boolean(args.includeFullMessages);

    const rawMessages = Array.isArray(args.messages)
      ? args.messages.map((m) => {
          if (m && typeof m === 'object') return m as { role: string; content: string };
          return { role: 'system', content: String(m) };
        })
      : [];

    try {
      const handoffId = `ho_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const handoffContext = AgentHandoff.createHandoffContext({
        goal,
        completedSteps,
        remainingTasks,
        artifacts,
        constraints,
        messages: rawMessages,
        includeFullMessages,
      });

      // If the caller supplied an explicit context summary, override the generated one
      if (args.contextSummary && typeof args.contextSummary === 'string') {
        handoffContext.contextSummary.executedPlan = args.contextSummary;
      }

      await this.handoff.request({
        handoffId,
        fromAgent: this.agentId,
        toAgent,
        goal,
        context: {
          ...handoffContext,
          availableTools: [],
          tokenBudget,
        },
      });

      getGlobalLogger().info('HandoffTool', `Handoff initiated: ${handoffId} → ${toAgent}`);

      // Wait for acceptance/rejection (poll with timeout)
      const timeoutMs = 60_000;
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const status = this.handoff.getHandoff(handoffId);
        if (status?.status === 'accepted') {
          return `Handoff accepted by ${toAgent}. Goal: ${goal}\nToken budget: ${tokenBudget}`;
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

      return `Handoff ${handoffId} sent to ${toAgent}. Waiting for acceptance... (use handoff check action to poll status)`;
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
    description: 'Check the status of a pending handoff. Returns current status (requested/accepted/rejected/completed/failed), the structured work order, and any response from the target agent.',
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

    const wo = status.context.workOrder;
    const cs = status.context.contextSummary;

    const parts = [
      `Handoff: ${handoffId}`,
      `Status: ${status.status}`,
      `From: ${status.fromAgent} → To: ${status.toAgent}`,
      `Goal: ${status.goal}`,
      '',
      '## Work Order',
      `- Completed: ${wo.completedSteps.join('; ') || 'none'}`,
      `- Remaining: ${wo.remainingTasks.join('; ') || 'none'}`,
      `- Constraints: ${wo.constraints.join('; ') || 'none'}`,
      `- Artifacts: ${wo.artifacts.map(a => `${a.name} (${a.reference})`).join(', ') || 'none'}`,
      '',
      '## Context Summary',
      `- Plan: ${cs.executedPlan}`,
      `- Findings: ${cs.findings.join('; ') || 'none'}`,
      `- Decisions: ${cs.decisions.join('; ') || 'none'}`,
      `- Environment: ${cs.environmentSnapshot}`,
      `- Open questions: ${cs.openQuestions.join('; ') || 'none'}`,
    ];
    if (status.response) parts.push('', `Response: ${status.response}`);
    if (status.resolvedAt) parts.push(`Resolved: ${status.resolvedAt}`);

    return parts.join('\n');
  }
}
