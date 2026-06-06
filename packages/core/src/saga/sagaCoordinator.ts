import { randomUUID } from 'node:crypto';
import type {
  SagaGraph,
  SagaNode,
  SagaStepNode,
  SagaParallelNode,
  SagaNestedNode,
  SagaApprovalNode,
  SagaContext,
  SagaResult,
  SagaRunOptions,
  SagaRunHandle,
  SagaStateSnapshot,
  SagaEvent,
  NodeState,
  RunState,
} from './types';
import { DEFAULT_RETRY_POLICY } from './types';
import { ExecutionGraph } from './executionGraph';
import { CheckpointManager } from './checkpointManager';
import { CompensationScheduler, type CompensableStep, type DeadLetterSink } from './compensationScheduler';
import { defaultCompensationRetryPolicy } from './compensationScheduler';
import { ApprovalManager } from './approvalManager';
import { WorkerPool, InProcessWorkerPool } from './workerPool';

export interface SagaCoordinatorOptions {
  checkpoint: CheckpointManager;
  approval: ApprovalManager;
  compensation?: CompensationScheduler;
  workerPool?: WorkerPool;
  deadLetter?: DeadLetterSink;
  clock?: () => Date;
  idGenerator?: () => string;
}

export class SagaCoordinator {
  private readonly graph: ExecutionGraph;
  private readonly nodeStates: Map<string, NodeState> = new Map();
  private readonly childRunIds: Set<string> = new Set();
  private sagaState: RunState = 'PENDING';
  private fencingEpoch = 0;
  private error?: string;
  private intentHash = '';
  private checkpointVersion = 0;
  private createdAt: string;
  private updatedAt: string;
  private tenantId?: string;
  private parentRunId?: string;
  private cancelController = new AbortController();
  private compensation: CompensationScheduler;
  private workerPool: WorkerPool;
  private clock: () => Date;
  private idGenerator: () => string;
  private results: Map<string, unknown> = new Map();

  constructor(
    private readonly graphValue: ExecutionGraph,
    private readonly ctx: SagaContext,
    private readonly checkpointMgr: CheckpointManager,
    private readonly approvalMgr: ApprovalManager,
    options: SagaCoordinatorOptions
  ) {
    this.graph = graphValue;
    this.compensation =
      options.compensation ??
      new CompensationScheduler({
        retryPolicy: defaultCompensationRetryPolicy(),
        deadLetter: options.deadLetter,
      });
    this.workerPool = options.workerPool ?? new InProcessWorkerPool(8);
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.tenantId = ctx.tenantId;
    this.parentRunId = ctx.parentRunId;
    const now = this.clock().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.graph.walk((n) => this.nodeStates.set(n.id, 'pending'));
  }

  get state(): RunState {
    return this.sagaState;
  }

  getNodeState(id: string): NodeState | undefined {
    return this.nodeStates.get(id);
  }

  get snapshot(): SagaStateSnapshot {
    const nodeStates: Record<string, NodeState> = {};
    for (const [k, v] of this.nodeStates) nodeStates[k] = v;
    return {
      runId: this.ctx.runId,
      state: this.sagaState,
      intentHash: this.intentHash,
      fencingEpoch: this.fencingEpoch,
      nodeStates,
      parentRunId: this.parentRunId,
      childRunIds: Array.from(this.childRunIds),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      checkpointVersion: this.checkpointVersion,
      error: this.error,
      tenantId: this.tenantId,
    };
  }

  cancel(): void {
    this.cancelController.abort();
  }

  async run(options: SagaRunOptions = {}): Promise<SagaResult> {
    this.sagaState = 'EXECUTING';
    await this.appendEvent(this.eventFor('begin', {}));
    await this.persist();

    try {
      await this.executeSequence(this.graph.rootId);
      this.sagaState = 'VERIFYING';
      await this.persist();
      this.sagaState = 'COMMITTED';
      await this.appendEvent(this.eventFor('commit', {}));
      await this.persist();
      return this.makeResult('committed', options);
    } catch (err) {
      return await this.handleFailure(err, options);
    }
  }

  private async executeSequence(startId: string): Promise<void> {
    let currentId: string | undefined = startId;
    while (currentId !== undefined) {
      if (this.cancelController.signal.aborted) {
        throw new SagaAbortedError('Cancelled');
      }
      const node = this.graph.requireNode(currentId);
      this.nodeStates.set(currentId, 'running');
      await this.appendEvent(
        this.eventFor('step.started', { nodeId: currentId, name: node.name })
      );
      await this.persist();

      try {
        await this.executeNode(node);
        this.nodeStates.set(currentId, 'completed');
      } catch (err) {
        this.nodeStates.set(currentId, 'failed');
        const wrapped = err instanceof Error ? err : new Error(String(err));
        throw new SagaNodeError(currentId, node.name, wrapped);
      }

      await this.persist();
      currentId = this.graph.nextSiblingOf(currentId)?.id;
    }
  }

  private async executeNode(node: SagaNode): Promise<void> {
    switch (node.kind) {
      case 'step':
        await this.executeStep(node);
        return;
      case 'parallel':
        await this.executeParallel(node);
        return;
      case 'nested':
        await this.executeNested(node);
        return;
      case 'approval':
        await this.executeApproval(node);
        return;
    }
  }

  private async executeStep(node: SagaStepNode): Promise<void> {
    const policy = node.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const timeoutMs = node.timeoutMs ?? 30_000;
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < policy.maxAttempts) {
      attempt++;
      this.ctx.attempts.set(node.id, attempt);
      try {
        const result = await this.runWithTimeout(
          () => node.fn(this.ctx),
          timeoutMs,
          this.cancelController.signal
        );
        this.results.set(node.id, result);
        this.ctx.results.set(node.name, result);
        this.ctx.results.set(node.id, result);
        await this.appendEvent(
          this.eventFor('step.completed', {
            nodeId: node.id,
            attempt,
            hasResult: result !== undefined,
          })
        );
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt >= policy.maxAttempts) break;
        const retryable =
          policy.retryOn === undefined || policy.retryOn(lastError);
        if (!retryable) break;
        const delay = this.computeBackoff(policy, attempt);
        await this.appendEvent(
          this.eventFor('retry.scheduled', {
            nodeId: node.id,
            attempt,
            delayMs: delay,
          })
        );
        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error('Step failed without error');
  }

  private async executeParallel(node: SagaParallelNode): Promise<void> {
    if (node.branches.length === 0) return;
    const abort = new AbortController();
    const promises: Promise<void>[] = [];

    for (const branch of node.branches) {
      if (branch.kind !== 'nested') {
        throw new SagaCoordinatorError('Parallel branch must be a nested node');
      }
      const childRunId = `${this.ctx.runId}::${branch.id}`;
      this.childRunIds.add(childRunId);
      const childCtx: SagaContext = {
        ...this.ctx,
        runId: childRunId,
        parentRunId: this.ctx.runId,
        signal: abort.signal,
      };
      const child = new SagaCoordinator(
        new ExecutionGraph(branch.child),
        childCtx,
        this.checkpointMgr,
        this.approvalMgr,
        {
          checkpoint: this.checkpointMgr,
          approval: this.approvalMgr,
          compensation: this.compensation,
          workerPool: this.workerPool,
          deadLetter: undefined,
          clock: this.clock,
          idGenerator: this.idGenerator,
        }
      );
      promises.push(child.run().then(() => undefined));
    }

    let firstError: unknown;
    let settled = 0;
    await new Promise<void>((resolve) => {
      for (const p of promises) {
        p.then(
          () => {
            settled++;
            if (settled === promises.length) resolve();
          },
          (err) => {
            if (firstError === undefined) {
              firstError = err;
              if (node.failFast) abort.abort();
            }
            settled++;
            if (settled === promises.length) resolve();
          }
        );
      }
    });

    if (firstError !== undefined) throw firstError;
  }

  private async executeNested(node: SagaNestedNode): Promise<void> {
    const childRunId = `${this.ctx.runId}::${node.id}`;
    this.childRunIds.add(childRunId);
    const childCtx: SagaContext = {
      ...this.ctx,
      runId: childRunId,
      parentRunId: this.ctx.runId,
      signal: this.cancelController.signal,
    };
    const child = new SagaCoordinator(
      new ExecutionGraph(node.child),
      childCtx,
      this.checkpointMgr,
      this.approvalMgr,
      {
        checkpoint: this.checkpointMgr,
        approval: this.approvalMgr,
        compensation: this.compensation,
        workerPool: this.workerPool,
        deadLetter: undefined,
        clock: this.clock,
        idGenerator: this.idGenerator,
      }
    );
    const result = await child.run();
    if (result.status === 'aborted') {
      throw new SagaNodeError(
        node.id,
        node.name,
        new Error(result.error ?? 'Nested saga aborted')
      );
    }
  }

  private async executeApproval(node: SagaApprovalNode): Promise<void> {
    this.nodeStates.set(node.id, 'paused');
    await this.appendEvent(
      this.eventFor('pause', { nodeId: node.id, approver: node.approver })
    );
    await this.approvalMgr.request({
      runId: this.ctx.runId,
      nodeId: node.id,
      approver: node.approver,
      payload: this.ctx.input,
      contextSummary: node.name,
      requestedAt: this.clock().toISOString(),
      expiresAt: node.timeoutMs
        ? new Date(this.clock().getTime() + node.timeoutMs).toISOString()
        : undefined,
      sagaName: this.graph.name,
      tenantId: this.tenantId,
    });
    await this.persist();

    const signal = this.combineSignals(
      this.cancelController.signal,
      node.timeoutMs
        ? AbortSignal.timeout(node.timeoutMs)
        : undefined
    );
    const result = await this.approvalMgr.waitForDecision(
      this.ctx.runId,
      node.id,
      { signal }
    );

    if (result.decision === 'approve') {
      this.nodeStates.set(node.id, 'completed');
      await this.appendEvent(
        this.eventFor('resume', { nodeId: node.id, decision: 'approve' })
      );
      return;
    }
    if (node.onTimeout === 'fail' && signal.aborted) {
      this.nodeStates.set(node.id, 'failed');
      throw new Error(`Approval timed out for ${node.approver}`);
    }
    this.nodeStates.set(node.id, 'failed');
    throw new Error(
      `Approval rejected by ${result.decidedBy}: ${result.reason ?? 'no reason'}`
    );
  }

  private async handleFailure(
    err: unknown,
    options: SagaRunOptions
  ): Promise<SagaResult> {
    const sagaError =
      err instanceof SagaNodeError
        ? err
        : err instanceof Error
          ? new SagaNodeError('?', '?', err)
          : new SagaNodeError('?', '?', new Error(String(err)));
    this.error = sagaError.message;
    this.sagaState = 'ABORTED';
    await this.appendEvent(
      this.eventFor('abort', { nodeId: sagaError.nodeId, error: sagaError.message })
    );

    const compensablePath = this.collectCompensablePath(sagaError.nodeId);
    const result = await this.compensation.compensate(
      compensablePath,
      this.ctx
    );
    if (result.failed.length > 0) {
      await this.appendEvent(
        this.eventFor('compensate.done', {
          compensated: result.compensated,
          failed: result.failed.map((f) => f.nodeId),
        })
      );
    } else {
      await this.appendEvent(
        this.eventFor('compensate.done', {
          compensated: result.compensated,
          failed: [],
        })
      );
    }
    await this.persist();
    return this.makeResult('aborted', options);
  }

  private collectCompensablePath(failedNodeId: string): CompensableStep[] {
    if (failedNodeId === '?') return [];
    const steps: CompensableStep[] = [];
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.graph.getNode(id);
      if (!node) return;

      if (node.kind === 'step' && node.compensable) {
        const state = this.nodeStates.get(id);
        if (state === 'completed' && this.results.has(id)) {
          steps.push({ node, result: this.results.get(id) });
        }
      }

      const prev = this.graph.previousSiblingOf(id);
      if (prev) visit(prev.id);

      const parentId = this.graph.parentOf(id);
      if (parentId !== undefined) visit(parentId);
    };

    visit(failedNodeId);
    return steps;
  }

  private makeResult(
    status: 'committed' | 'aborted',
    options: SagaRunOptions
  ): SagaResult {
    const results: Record<string, unknown> = {};
    if (options.includeResults !== false) {
      for (const [id, value] of this.results) {
        const node = this.graph.getNode(id);
        if (node && node.kind === 'step') {
          results[node.name] = value;
        }
      }
    }
    return {
      runId: this.ctx.runId,
      status,
      results,
      error: this.error,
      summary:
        status === 'committed'
          ? `Saga ${this.graph.name} completed`
          : `Saga ${this.graph.name} aborted: ${this.error ?? 'unknown'}`,
      durationMs: this.clock().getTime() - new Date(this.createdAt).getTime(),
    };
  }

  private async persist(): Promise<void> {
    const snapshot = this.checkpointMgr.createSnapshot({
      runId: this.ctx.runId,
      state: this.sagaState,
      intentHash: this.intentHash,
      fencingEpoch: this.fencingEpoch,
      nodeStates: this.serializeNodeStates(),
      parentRunId: this.parentRunId,
      childRunIds: Array.from(this.childRunIds),
      error: this.error,
      tenantId: this.tenantId,
      previous:
        this.checkpointVersion > 0
          ? await this.checkpointMgr.loadSnapshot(this.ctx.runId)
          : undefined,
    });
    this.checkpointVersion = snapshot.checkpointVersion;
    this.updatedAt = snapshot.updatedAt;
    await this.checkpointMgr.saveSnapshot(snapshot);
  }

  private serializeNodeStates(): Record<string, NodeState> {
    const out: Record<string, NodeState> = {};
    for (const [k, v] of this.nodeStates) out[k] = v;
    return out;
  }

  private async appendEvent(event: SagaEvent): Promise<void> {
    await this.checkpointMgr.appendEvent(event);
  }

  private eventFor(kind: string, fields: Record<string, unknown>): SagaEvent {
    const base = {
      runId: this.ctx.runId,
      fencingEpoch: this.fencingEpoch,
      timestamp: this.clock().toISOString(),
    };
    return { ...base, kind, ...fields } as SagaEvent;
  }

  private async runWithTimeout<T>(
    fn: () => Promise<T>,
    ms: number,
    signal: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Step timed out after ${ms}ms`));
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      fn().then(
        (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  private computeBackoff(
    policy: import('./types').RetryPolicy,
    attempt: number
  ): number {
    const base =
      policy.backoff === 'fixed'
        ? policy.initialDelayMs
        : policy.backoff === 'linear'
          ? policy.initialDelayMs * attempt
          : policy.initialDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(base, policy.maxDelayMs);
    if (policy.jitter === 'none') return capped;
    if (policy.jitter === 'full') return Math.floor(Math.random() * capped);
    return Math.floor(capped / 2 + Math.random() * (capped / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private combineSignals(
    a: AbortSignal,
    b?: AbortSignal
  ): AbortSignal {
    if (!b) return a;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    if (a.aborted || b.aborted) ctrl.abort();
    return ctrl.signal;
  }
}

export class SagaAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagaAbortedError';
  }
}

export class SagaNodeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly nodeName: string,
    public readonly cause: Error
  ) {
    super(`Saga node ${nodeName} (${nodeId}) failed: ${cause.message}`);
    this.name = 'SagaNodeError';
  }
}

export class SagaCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagaCoordinatorError';
  }
}

export async function runSaga(
  graph: SagaGraph,
  context: SagaContext,
  checkpoint: CheckpointManager,
  approval: ApprovalManager,
  options?: Partial<SagaCoordinatorOptions>
): Promise<SagaResult> {
  const eg = new ExecutionGraph(graph);
  const coord = new SagaCoordinator(eg, context, checkpoint, approval, {
    checkpoint,
    approval,
    ...options,
  });
  return coord.run();
}

export interface RunningSaga {
  result: Promise<SagaResult>;
  cancel(): void;
  snapshot(): SagaStateSnapshot;
  getNodeState(id: string): NodeState | undefined;
}

export function startSaga(
  graph: SagaGraph,
  context: SagaContext,
  checkpoint: CheckpointManager,
  approval: ApprovalManager,
  options?: Partial<SagaCoordinatorOptions>
): RunningSaga {
  const eg = new ExecutionGraph(graph);
  const coord = new SagaCoordinator(eg, context, checkpoint, approval, {
    checkpoint,
    approval,
    ...options,
  });
  return {
    result: coord.run(),
    cancel: () => coord.cancel(),
    snapshot: () => coord.snapshot,
    getNodeState: (id: string) => coord.getNodeState(id),
  };
}

export function attachSagaHandle(
  runId: string,
  coord: SagaCoordinator
): SagaRunHandle {
  return {
    runId,
    state: coord.state,
    cancel: () => coord.cancel(),
    snapshot: () => coord.snapshot,
    getNodeState: (id: string) => coord.getNodeState(id),
  };
}
