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
/**
 * `setTimeout` stores its delay in a signed 32-bit int. A larger value silently
 * overflows and the timer fires on the next tick, so an oversized
 * `gate.timeoutMs` would resolve the approval *immediately* instead of never.
 * Clamp to the largest delay Node actually honours.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Approver identities the manager itself mints; callers must not forge them. */
const SYSTEM_APPROVER_PREFIX = 'system:';

const VALID_DECISIONS: readonly ApprovalDecision[] = ['approve', 'reject', 'modify'];

export interface ApprovalAuthenticatorInput {
  approvalId: string;
  approverId: string;
  request: ApprovalRequest;
}

/**
 * Host-supplied authentication boundary for human responses.
 *
 * A display name is not an identity proof. The core manager deliberately does
 * not know how the API's JWT/OIDC/mTLS layer authenticates a human, so a
 * production host must inject that decision. An absent authenticator is a
 * hard deny rather than an implicit allow.
 */
export type ApprovalAuthenticator = (input: ApprovalAuthenticatorInput) => boolean;

export interface HumanApprovalManagerOptions {
  authenticateApprover?: ApprovalAuthenticator;
}

function generateApprovalId(): string {
  return `${APPROVAL_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Approval-on-timeout is only honoured when an operator enables it out of band.
 *
 * `gate.onTimeout` arrives inside the plan/sub-agent node — i.e. it is supplied
 * by the very work being gated. Honouring it as a grant means a plan can approve
 * itself by declaring `{ timeoutMs: 1, onTimeout: 'approve' }`. The project's
 * failure semantics are explicit: a timeout is the *absence* of a human decision
 * and must never be converted into success. The `approve` value is therefore
 * ignored unconditionally; there is no environment-variable escape hatch for
 * turning a timeout into a grant.
 */

/**
 * Coerce a caller-supplied timeout into a delay `setTimeout` will honour.
 * A missing, non-finite, zero or negative value falls back to the default;
 * an oversized value is clamped rather than allowed to overflow.
 */
function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(raw, MAX_TIMEOUT_MS);
}

/**
 * Decide what a timeout means. A timeout is never a human grant, even when a
 * plan supplies `onTimeout: 'approve'`.
 */
function resolveTimeoutDecision(
  configured: HumanApprovalGate['onTimeout'],
  ctx: { approvalId: string; runId: string; nodeId: string },
): ApprovalDecision {
  if (configured === 'approve') {
    getGlobalLogger().warn(
      'HumanApprovalManager',
      "gate.onTimeout 'approve' ignored — a timeout cannot constitute human approval (failing closed)",
      ctx,
    );
    return 'reject';
  }
  // 'modify' is treated as "not granted" by every consumer of the resolution
  // (subAgentExecutor skips on both 'reject' and 'modify'), so it is safe.
  return configured === 'modify' ? 'modify' : 'reject';
}

export class HumanApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private responses = new Map<string, ApprovalResolution>();
  private readonly DEFAULT_DECISION_ON_TIMEOUT: ApprovalDecision = 'reject';
  private authenticateApprover?: ApprovalAuthenticator;

  constructor(options: HumanApprovalManagerOptions = {}) {
    this.authenticateApprover = options.authenticateApprover;
  }

  /**
   * Install the host's authenticated-approver verifier during trusted
   * application bootstrap. Passing `undefined` restores the fail-closed state.
   */
  configureApproverAuthenticator(authenticator?: ApprovalAuthenticator): void {
    this.authenticateApprover = authenticator;
  }

  request(request: Omit<ApprovalRequest, 'approvalId' | 'requestedAt'>): ApprovalRequest {
    const approvalId = generateApprovalId();
    const fullRequest: ApprovalRequest = {
      ...request,
      approvalId,
      requestedAt: new Date().toISOString(),
    };

    const timeoutMs = normalizeTimeoutMs(fullRequest.gate.timeoutMs);
    const onTimeout = resolveTimeoutDecision(fullRequest.gate.onTimeout, {
      approvalId,
      runId: fullRequest.runId,
      nodeId: fullRequest.nodeId,
    });

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
   *
   * The caller identity is not self-asserting: this method validates it before
   * it can grant anything. Two things are enforced, because the alternative is
   * that the gate can be resolved by whoever is being gated:
   *   - separation of duties — the requester may not approve its own request;
   *   - no forged system principals — `system:*` ids are minted internally
   *     (timeout / cancel / unknown-approval) and are never accepted from a
   *     caller.
   * A rejected attempt throws rather than returning `null`, so it cannot be
   * mistaken for "already resolved".
   */
  respond(
    approvalId: string,
    approverId: string,
    decision: ApprovalDecision,
    note?: string,
  ): ApprovalResolution | null {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.completed) return null;

    if (typeof approverId !== 'string' || approverId.trim().length === 0) {
      throw new Error('HumanApprovalManager.respond: approverId must be a non-empty string');
    }
    if (approverId.startsWith(SYSTEM_APPROVER_PREFIX)) {
      throw new Error(
        `HumanApprovalManager.respond: "${approverId}" is a reserved system identity and cannot resolve an approval`,
      );
    }
    if (approverId === entry.request.requesterId) {
      throw new Error(
        `HumanApprovalManager.respond: approval ${approvalId} cannot be resolved by its own requester ("${approverId}") — separation of duties required`,
      );
    }
    if (!VALID_DECISIONS.includes(decision)) {
      throw new Error(
        `HumanApprovalManager.respond: invalid decision "${String(decision)}" (expected one of ${VALID_DECISIONS.join(', ')})`,
      );
    }
    if (
      !this.authenticateApprover ||
      !this.authenticateApprover({ approvalId, approverId, request: entry.request })
    ) {
      throw new Error(
        `HumanApprovalManager.respond: authenticated approver context is required for approval ${approvalId}`,
      );
    }

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

const approvalManagerSingleton = createTenantAwareSingleton(() => new HumanApprovalManager(), {});

export function getHumanApprovalManager(): HumanApprovalManager {
  return approvalManagerSingleton.get();
}

export function configureHumanApprovalManager(
  authenticator?: ApprovalAuthenticator,
): HumanApprovalManager {
  const manager = approvalManagerSingleton.get();
  manager.configureApproverAuthenticator(authenticator);
  return manager;
}

export function resetHumanApprovalManager(): void {
  approvalManagerSingleton.reset();
}
