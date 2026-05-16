import type { AgentInbox } from './agentInbox';
import type { StateCheckpointer } from './stateCheckpointer';

export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'completed' | 'failed';

export interface HandoffRequest {
  handoffId: string;
  fromAgent: string;
  toAgent: string;
  goal: string;
  context: {
    missionId?: string;
    runId?: string;
    messages: Array<{ role: string; content: string }>;
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

  constructor(inbox: AgentInbox, checkpointer?: StateCheckpointer) {
    this.inbox = inbox;
    this.checkpointer = checkpointer;
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

    return handoff;
  }

  /** Mark a handoff as completed */
  complete(handoffId: string): void {
    const handoff = this.handoffs.get(handoffId);
    if (handoff) {
      handoff.status = 'completed';
      handoff.resolvedAt = new Date().toISOString();
    }
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
}
