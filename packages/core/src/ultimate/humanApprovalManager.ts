/**
 * HumanApprovalManager — P3: Structured human-in-the-loop approvals.
 *
 * When a sub-agent node requires human approval, the SubAgentExecutor
 * publishes a `human.approval_required` event on the message bus and
 * blocks waiting for either:
 *   1. A matching `human.approval_received` message (via respond()),
 *   2. A timeout, which triggers the configured onTimeout fallback.
 *
 * One manager per (tenant, runId) so concurrent runs don't collide.
 */
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';
import type { HumanApprovalGate, NodeRiskLevel } from './types';

export type ApprovalDecision = 'approve' | 'reject' | 'modify';

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  nodeId: string;
  nodeGoal: string;
  gate: HumanApprovalGate;
  riskLevel: NodeRiskLevel;
  requesterId: string;
  requestedAt: string;
}

export interface ApprovalResolution {
  approvalId: string;
  decision: ApprovalDecision;
  approverId: string;
  note?: string;
  resolvedAt: string;
  timedOut: boolean;
}

export type ApprovalListener = (resolution: ApprovalResolution) => void;

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  timer: ReturnType<typeof setTimeout> | null;
  completed: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_ID_PREFIX = 'appr_';

function generateApprovalId(): string {
  return `${APPROVAL_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class HumanApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private responses = new Map<string, ApprovalResolution>();
  private readonly DEFAULT_DECISION_ON_TIMEOUT: ApprovalDecision = 'reject';

  request(request: Omit<ApprovalRequest, 'approvalId' | 'requestedAt'>): ApprovalRequest {
    const approvalId = generateApprovalId();
    const fullRequest: ApprovalRequest = {
      ...request,
      approvalId,
      requestedAt: new Date().toISOString(),
    };

    const timeoutMs = fullRequest.gate.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const onTimeout = fullRequest.gate.onTimeout ?? this.DEFAULT_DECISION_ON_TIMEOUT;

    const entry: PendingEntry = {
      request: fullRequest,
      resolve: () => {},
      timer: null,
      completed: false,
    };

    const promise = new Promise<ApprovalResolution>((resolve) => {
      entry.resolve = resolve;
    });

    entry.timer = setTimeout(() => {
      if (entry.completed) return;
      entry.completed = true;
      const resolution: ApprovalResolution = {
        approvalId,
        decision: onTimeout,
        approverId: 'system:timeout',
        note: `No human response within ${timeoutMs}ms; falling back to '${onTimeout}'`,
        resolvedAt: new Date().toISOString(),
        timedOut: true,
      };
      this.responses.set(approvalId, resolution);
      this.pending.delete(approvalId);
      getMessageBus().publish('human.approval_timeout', 'human-approval-manager', {
        approvalId,
        runId: fullRequest.runId,
        nodeId: fullRequest.nodeId,
        requestedAt: fullRequest.requestedAt,
      });
      getGlobalLogger().info('HumanApprovalManager', 'Approval timed out', {
        approvalId,
        runId: fullRequest.runId,
        nodeId: fullRequest.nodeId,
        decision: onTimeout,
      });
      entry.resolve(resolution);
    }, timeoutMs);

    this.pending.set(approvalId, entry);

    getMessageBus().publish('human.approval_required', fullRequest.requesterId, {
      approvalId,
      runId: fullRequest.runId,
      nodeId: fullRequest.nodeId,
      nodeGoal: fullRequest.nodeGoal,
      gate: fullRequest.gate.riskThreshold ?? 'unknown',
      riskLevel: fullRequest.riskLevel,
      timeoutMs,
      requesterId: fullRequest.requesterId,
    });

    void promise;

    return fullRequest;
  }

  /**
   * Wait for an approval request to resolve. Resolves with the
   * resolution (decision + metadata) or with the timeout decision.
   */
  awaitResolution(approvalId: string): Promise<ApprovalResolution> {
    const cached = this.responses.get(approvalId);
    if (cached) return Promise.resolve(cached);
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return Promise.resolve({
        approvalId,
        decision: this.DEFAULT_DECISION_ON_TIMEOUT,
        approverId: 'system:unknown-approval',
        note: 'No pending approval found; defaulting to reject',
        resolvedAt: new Date().toISOString(),
        timedOut: true,
      });
    }
    return new Promise<ApprovalResolution>((resolve) => {
      const origResolve = entry.resolve;
      entry.resolve = (res) => {
        origResolve(res);
        resolve(res);
      };
    });
  }

  /**
   * Record a human response. The first response wins; subsequent
   * responses for the same approvalId are ignored.
   */
  respond(
    approvalId: string,
    approverId: string,
    decision: ApprovalDecision,
    note?: string,
  ): ApprovalResolution | null {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.completed) return null;

    entry.completed = true;
    if (entry.timer) clearTimeout(entry.timer);

    const resolution: ApprovalResolution = {
      approvalId,
      decision,
      approverId,
      note,
      resolvedAt: new Date().toISOString(),
      timedOut: false,
    };
    this.responses.set(approvalId, resolution);
    this.pending.delete(approvalId);

    const topic = decision === 'reject' ? 'human.approval_rejected' : 'human.approval_received';
    getMessageBus().publish(topic, approverId, {
      approvalId,
      runId: entry.request.runId,
      nodeId: entry.request.nodeId,
      ...(decision === 'reject'
        ? { reason: note ?? 'No reason provided' }
        : { approverId, decision, ...(note ? { note } : {}) }),
    });

    entry.resolve(resolution);
    return resolution;
  }

  /** Inspect a pending request without resolving it. */
  getPending(approvalId: string): ApprovalRequest | null {
    return this.pending.get(approvalId)?.request ?? null;
  }

  /** List all currently pending approval IDs. */
  listPending(runId?: string): string[] {
    const all = Array.from(this.pending.keys());
    if (!runId) return all;
    return all.filter((id) => this.pending.get(id)?.request.runId === runId);
  }

  /** Cancel all pending approvals for a run. Used when an execution is aborted. */
  cancelAllForRun(runId: string, reason = 'Execution aborted'): number {
    let cancelled = 0;
    for (const [id, entry] of this.pending) {
      if (entry.request.runId !== runId || entry.completed) continue;
      entry.completed = true;
      if (entry.timer) clearTimeout(entry.timer);
      const resolution: ApprovalResolution = {
        approvalId: id,
        decision: 'reject',
        approverId: 'system:cancel',
        note: reason,
        resolvedAt: new Date().toISOString(),
        timedOut: false,
      };
      this.responses.set(id, resolution);
      this.pending.delete(id);
      entry.resolve(resolution);
      cancelled++;
    }
    return cancelled;
  }

  /** Drop resolved entries older than the given age in ms. Default 1 hour. */
  pruneResolved(maxAgeMs: number = 3_600_000): number {
    const threshold = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, res] of this.responses) {
      if (new Date(res.resolvedAt).getTime() < threshold) {
        this.responses.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const approvalManagerSingleton = createTenantAwareSingleton(() => new HumanApprovalManager(), {
  allowGlobalFallback: true,
});

export function getHumanApprovalManager(): HumanApprovalManager {
  return approvalManagerSingleton.get();
}

export function resetHumanApprovalManager(): void {
  approvalManagerSingleton.reset();
}
