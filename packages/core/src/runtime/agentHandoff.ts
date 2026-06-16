import type { AgentInbox } from './agentInbox';
import type { StateCheckpointer } from './stateCheckpointer';
import { TokenGovernor } from './tokenGovernor';

export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'completed' | 'failed';

// ============================================================================
// Structured State-Only Handoff (T2 Research Pattern)
//
// Instead of passing full chat histories between agents, use structured
// state-only transfer with typed work orders and ≤500-token context summaries.
// This prevents context rot and reduces token cost by 60-80% per handoff.
// ============================================================================

/**
 * Typed work order — replaces free-form message passing with a structured schema.
 * Every handoff includes { goal, completedSteps, remainingTasks, artifacts, constraints }
 * so the receiving agent has a clear, unambiguous mandate.
 */
export interface WorkOrder {
  /** The overarching goal of this handoff */
  goal: string;
  /** Steps already completed by the sending agent */
  completedSteps: string[];
  /** Steps remaining for the receiving agent */
  remainingTasks: string[];
  /** Artifacts produced so far (file paths, data references) */
  artifacts: Array<{ name: string; type: string; reference: string }>;
  /** Constraints or guardrails the receiving agent must respect */
  constraints: string[];
}

/**
 * Context summary — a compressed ≤500-token summary of the sending agent's
 * execution history, replacing the full message array.
 */
export interface ContextSummary {
  /** Brief description of what was done */
  executedPlan: string;
  /** Key findings or intermediate results */
  findings: string[];
  /** Decisions made that affect downstream work */
  decisions: string[];
  /** Current environment state */
  environmentSnapshot: string;
  /** Remaining open questions */
  openQuestions: string[];
}

export interface HandoffRequest {
  handoffId: string;
  fromAgent: string;
  toAgent: string;
  goal: string;
  context: {
    missionId?: string;
    runId?: string;
    /** Typed work order — the structured mandate */
    workOrder: WorkOrder;
    /** Compressed summary (≤500 tokens) — replaces full message history */
    contextSummary: ContextSummary;
    /** Full messages — OPTIONAL, only included when explicitly requested or when summary is insufficient */
    messages?: Array<{ role: string; content: string }>;
    intermediateResults?: string[];
    availableTools: string[];
    tokenBudget: number;
    checkpointId?: string;
  };
  status: HandoffStatus;
  createdAt: string;
  resolvedAt?: string;
  response?: string;
}

export class AgentHandoff {
  private inbox: AgentInbox;
  private checkpointer?: StateCheckpointer;
  private handoffs = new Map<string, HandoffRequest>();

  private readonly UNRESOLVED_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(inbox: AgentInbox, checkpointer?: StateCheckpointer) {
    this.inbox = inbox;
    this.checkpointer = checkpointer;
    this.pruneTimer = setInterval(() => this.pruneUnresolved(), this.UNRESOLVED_TTL_MS);
    if (this.pruneTimer?.unref) this.pruneTimer.unref();
  }

  /** Prune handoffs that have been in a non-terminal state for too long */
  private pruneUnresolved(): void {
    const threshold = Date.now() - this.UNRESOLVED_TTL_MS;
    for (const [id, h] of this.handoffs) {
      if (h.status === 'requested' && new Date(h.createdAt).getTime() < threshold) {
        h.status = 'failed';
        h.resolvedAt = new Date().toISOString();
        h.response = 'Timed out waiting for acceptance';
      }
    }
    this.pruneResolved();
  }

  /** Agent A initiates a handoff to Agent B */
  async request(handoff: Omit<HandoffRequest, 'status' | 'createdAt'>): Promise<HandoffRequest> {
    const full: HandoffRequest = {
      ...handoff,
      status: 'requested',
      createdAt: new Date().toISOString(),
    };
    this.handoffs.set(full.handoffId, full);

    this.inbox.send({
      id: `ho_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      from: handoff.fromAgent,
      to: handoff.toAgent,
      subject: `handoff: ${handoff.goal.slice(0, 100)}`,
      body: `Handoff request from ${handoff.fromAgent}: ${handoff.goal}`,
      priority: 'high',
      tags: ['handoff', 'request'],
      payload: { handoffId: full.handoffId },
    });

    return full;
  }

  /** Agent B accepts a handoff — returns the context needed to continue */
  async accept(handoffId: string, response?: string): Promise<HandoffRequest | null> {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff || handoff.status !== 'requested') return null;
    handoff.status = 'accepted';
    handoff.resolvedAt = new Date().toISOString();
    handoff.response = response;

    this.inbox.send({
      id: `ho_ack_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      from: handoff.toAgent,
      to: handoff.fromAgent,
      subject: `handoff accepted: ${handoff.goal.slice(0, 60)}`,
      body: response ?? 'Handoff accepted.',
      priority: 'normal',
      tags: ['handoff', 'accepted'],
      payload: { handoffId },
    });

    return handoff;
  }

  /** Agent B rejects a handoff */
  async reject(handoffId: string, reason: string): Promise<HandoffRequest | null> {
    const handoff = this.handoffs.get(handoffId);
    if (!handoff || handoff.status !== 'requested') return null;
    handoff.status = 'rejected';
    handoff.resolvedAt = new Date().toISOString();
    handoff.response = reason;

    this.inbox.send({
      id: `ho_rej_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      from: handoff.toAgent,
      to: handoff.fromAgent,
      subject: `handoff rejected: ${handoff.goal.slice(0, 60)}`,
      body: reason,
      priority: 'normal',
      tags: ['handoff', 'rejected'],
      payload: { handoffId },
    });

    this.pruneResolved();
    return handoff;
  }

  /** Mark a handoff as completed */
  complete(handoffId: string): void {
    const handoff = this.handoffs.get(handoffId);
    if (handoff) {
      handoff.status = 'completed';
      handoff.resolvedAt = new Date().toISOString();
    }
    // Auto-prune resolved handoffs older than 10 minutes
    this.pruneResolved();
  }

  /** Remove resolved handoffs older than 10 minutes to prevent unbounded growth */
  pruneResolved(maxAgeMs: number = 600_000): number {
    const threshold = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, h] of this.handoffs) {
      if (h.resolvedAt && new Date(h.resolvedAt).getTime() < threshold) {
        this.handoffs.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Get handoff details */
  getHandoff(handoffId: string): HandoffRequest | undefined {
    return this.handoffs.get(handoffId);
  }

  /** List handoffs for an agent */
  listForAgent(agentId: string): HandoffRequest[] {
    return Array.from(this.handoffs.values()).filter(
      h => h.fromAgent === agentId || h.toAgent === agentId,
    );
  }

  /**
   * Build a structured WorkOrder from execution context.
   * Replaces free-form message passing with a typed schema.
   */
  static buildWorkOrder(params: {
    goal: string;
    completedSteps?: string[];
    remainingTasks?: string[];
    artifacts?: Array<{ name: string; type: string; reference: string }>;
    constraints?: string[];
  }): WorkOrder {
    return {
      goal: params.goal,
      completedSteps: params.completedSteps ?? [],
      remainingTasks: params.remainingTasks ?? [],
      artifacts: params.artifacts ?? [],
      constraints: params.constraints ?? [],
    };
  }

  /**
   * Generate a compressed ≤500-token ContextSummary from messages.
   * Extracts key phases, findings, decisions, and environment state
   * without passing the full message history.
   */
  static generateSummary(messages: Array<{ role: string; content: string }>): ContextSummary {
    // Extract system instructions (first system message)
    const systemMsgs = messages.filter(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    const toolMsgs = messages.filter(m => m.role === 'tool');

    // Compress: extract key sentences from each message type
    const extractKeySentences = (text: string, maxSentences: number): string => {
      const sentences = text
        .split(/[.\n]+/)
        .map(s => s.trim())
        .filter(s => s.length > 20 && s.length < 300);
      return sentences.slice(0, maxSentences).join('. ');
    };

    // Build executed plan summary from user messages
    const planParts = userMsgs
      .map(m => extractKeySentences(m.content, 2))
      .filter(Boolean);
    const executedPlan = planParts.length > 0
      ? planParts.slice(0, 5).join('; ').slice(0, 300)
      : 'No explicit plan recorded';

    // Extract findings from tool results (first meaningful output per unique tool)
    const seenTools = new Set<string>();
    const findings: string[] = [];
    for (const msg of toolMsgs) {
      const firstLine = msg.content.split('\n')[0]?.trim();
      if (firstLine && firstLine.length > 10 && firstLine.length < 200) {
        const toolId = firstLine.slice(0, 40);
        if (!seenTools.has(toolId)) {
          seenTools.add(toolId);
          findings.push(firstLine.slice(0, 150));
        }
      }
      if (findings.length >= 5) break;
    }

    // Extract decisions from assistant messages
    const decisions: string[] = [];
    for (const msg of assistantMsgs) {
      const lines = msg.content.split('\n').filter(l => l.trim().length > 20);
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (
          (lower.includes('decid') || lower.includes('conclud') || lower.includes('therefor') || lower.includes('thus')) &&
          line.length < 200
        ) {
          decisions.push(line.slice(0, 180));
          if (decisions.length >= 3) break;
        }
      }
      if (decisions.length >= 3) break;
    }

    // Environment snapshot: last system message
    const environmentSnapshot = systemMsgs.length > 0
      ? systemMsgs[systemMsgs.length - 1].content.slice(0, 200)
      : 'No environment snapshot available';

    // Open questions: last user message if it ends with a question
    const lastUser = userMsgs[userMsgs.length - 1];
    const openQuestions: string[] = [];
    if (lastUser) {
      const content = lastUser.content;
      const qMark = content.indexOf('?');
      if (qMark >= 0) {
        const before = content.slice(Math.max(0, qMark - 80), qMark + 1).trim();
        if (before.length > 10) openQuestions.push(before);
      }
    }

    const summary: ContextSummary = {
      executedPlan,
      findings: findings.length > 0 ? findings : ['No findings extracted'],
      decisions: decisions.length > 0 ? decisions : ['No decisions recorded'],
      environmentSnapshot,
      openQuestions,
    };

    // Enforce ≤500-token budget by truncating the largest text fields
    return AgentHandoff.capSummaryToTokens(summary, 500);
  }

  /**
   * Truncate a ContextSummary so its JSON representation is ≤ maxTokens.
   * Reduces field lengths proportionally, never deletes fields entirely.
   */
  private static capSummaryToTokens(summary: ContextSummary, maxTokens: number): ContextSummary {
    const estimate = (text: string) => TokenGovernor.estimateTokens(text);
    const totalTokens = (s: ContextSummary) =>
      estimate(s.executedPlan) +
      estimate(s.findings.join('\n')) +
      estimate(s.decisions.join('\n')) +
      estimate(s.environmentSnapshot) +
      estimate(s.openQuestions.join('\n'));

    let current: ContextSummary & Record<string, unknown> = { ...summary };
    if (totalTokens(current) <= maxTokens) return current;

    // Budget per field: allocate proportionally, with a floor
    const fields: Array<keyof ContextSummary> = ['executedPlan', 'findings', 'decisions', 'environmentSnapshot', 'openQuestions'];
    const toText = (s: ContextSummary, field: keyof ContextSummary) =>
      Array.isArray(s[field]) ? (s[field] as string[]).join('\n') : String(s[field]);

    let iterations = 0;
    while (totalTokens(current) > maxTokens && iterations < 20) {
      iterations++;
      const overage = totalTokens(current) - maxTokens;
      let reduced = false;

      for (const field of fields) {
        const text = toText(current, field);
        if (text.length <= 20) continue;
        const fieldTokens = estimate(text);
        const share = Math.max(10, Math.floor((fieldTokens / Math.max(1, totalTokens(current))) * overage));
        const targetChars = Math.max(20, Math.floor(text.length * (1 - share / Math.max(1, fieldTokens))));
        if (targetChars < text.length) {
          if (Array.isArray(current[field])) {
            const joined = (current[field] as string[]).join('\n');
            const truncated = joined.slice(0, targetChars);
            (current as Record<string, unknown>)[field] = truncated.split('\n').filter(Boolean);
          } else {
            (current as Record<string, unknown>)[field] = text.slice(0, targetChars);
          }
          reduced = true;
        }
      }

      if (!reduced) break;
    }

    return current;
  }

  /**
   * Shorthand: build both work order and context summary in one call.
   */
  static createHandoffContext(params: {
    goal: string;
    completedSteps?: string[];
    remainingTasks?: string[];
    artifacts?: Array<{ name: string; type: string; reference: string }>;
    constraints?: string[];
    messages?: Array<{ role: string; content: string }>;
    includeFullMessages?: boolean;
  }): Pick<HandoffRequest['context'], 'workOrder' | 'contextSummary' | 'messages'> {
    const workOrder = AgentHandoff.buildWorkOrder(params);
    const contextSummary = params.messages
      ? AgentHandoff.generateSummary(params.messages)
      : {
          executedPlan: 'No execution plan provided',
          findings: [],
          decisions: [],
          environmentSnapshot: 'No environment snapshot',
          openQuestions: [],
        };

    return {
      workOrder,
      contextSummary,
      // Only include full messages when explicitly requested
      messages: params.includeFullMessages ? params.messages : undefined,
    };
  }

  dispose(): void {
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
  }
}
