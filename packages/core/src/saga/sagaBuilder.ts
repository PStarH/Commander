import type {
  SagaGraph,
  SagaNode,
  SagaStepNode,
  SagaParallelNode,
  SagaNestedNode,
  SagaApprovalNode,
  RetryPolicy,
  CompensationFn,
} from './types';

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) >>> 0;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export interface SagaStepConfig {
  id?: string;
  compensate?: CompensationFn;
  compensateOrder?: 'lifo' | 'fifo';
  timeoutMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  description?: string;
  tags?: string[];
}

export interface SagaParallelConfig {
  id?: string;
  name?: string;
  failFast?: boolean;
}

export interface SagaNestedConfig {
  id?: string;
  name?: string;
  compensateOrder?: 'lifo' | 'fifo';
}

export interface SagaApprovalConfig {
  id?: string;
  timeoutMs?: number;
  onTimeout?: 'reject' | 'fail';
}

export class SagaBuilder {
  private readonly nodes: SagaNode[] = [];
  private _description?: string;
  private _timeoutMs?: number;
  private _defaultRetryPolicy?: RetryPolicy;
  private _tenantId?: string;
  private _metadata?: Record<string, unknown>;
  private _name: string;

  constructor(name: string) {
    if (!name || typeof name !== 'string') {
      throw new SagaBuilderError('Saga name is required');
    }
    this._name = name;
  }

  describe(description: string): this {
    this._description = description;
    return this;
  }

  withTimeout(ms: number): this {
    if (ms <= 0) throw new SagaBuilderError('timeoutMs must be > 0');
    this._timeoutMs = ms;
    return this;
  }

  withRetry(policy: RetryPolicy): this {
    this._defaultRetryPolicy = policy;
    return this;
  }

  withTenant(tenantId: string): this {
    this._tenantId = tenantId;
    return this;
  }

  withMetadata(metadata: Record<string, unknown>): this {
    this._metadata = { ...(this._metadata ?? {}), ...metadata };
    return this;
  }

  step(
    name: string,
    fn: (ctx: import('./types').SagaContext) => Promise<unknown>,
    config: SagaStepConfig = {}
  ): this {
    const id = config.id ?? genId('step');
    const node: SagaStepNode = {
      kind: 'step',
      id,
      name,
      fn,
      compensate: config.compensate,
      compensateOrder: config.compensateOrder ?? 'lifo',
      timeoutMs: config.timeoutMs,
      retryPolicy: config.retryPolicy
        ? this.resolveRetryPolicy(config.retryPolicy)
        : undefined,
      compensable: config.compensate !== undefined,
      description: config.description,
      tags: config.tags ?? [],
    };
    this.nodes.push(node);
    return this;
  }

  compensate(fn: CompensationFn): this {
    const last = this.nodes[this.nodes.length - 1];
    if (!last || last.kind !== 'step') {
      throw new SagaBuilderError(
        'compensate() must follow a step() — most recent node is not a step'
      );
    }
    const step = last as SagaStepNode;
    step.compensate = fn;
    step.compensable = true;
    return this;
  }

  parallel(
    branches: readonly SagaGraph[],
    config: SagaParallelConfig = {}
  ): this {
    if (branches.length === 0) {
      throw new SagaBuilderError('parallel() requires at least one branch');
    }
    const nestedNodes: SagaNestedNode[] = branches.map((g, i) => ({
      kind: 'nested',
      id: `${config.id ?? genId('parallel')}_b${i}`,
      name: g.name,
      child: g,
      compensateOrder: 'lifo',
    }));
    const parallel: SagaParallelNode = {
      kind: 'parallel',
      id: config.id ?? genId('parallel'),
      name: config.name ?? 'parallel',
      branches: nestedNodes,
      failFast: config.failFast ?? true,
    };
    this.nodes.push(parallel);
    return this;
  }

  nested(
    child: SagaGraph,
    config: SagaNestedConfig = {}
  ): this {
    const node: SagaNestedNode = {
      kind: 'nested',
      id: config.id ?? genId('nested'),
      name: config.name ?? child.name,
      child,
      compensateOrder: config.compensateOrder ?? 'lifo',
    };
    this.nodes.push(node);
    return this;
  }

  approval(approver: string, config: SagaApprovalConfig = {}): this {
    if (!approver) {
      throw new SagaBuilderError('approval() requires an approver id');
    }
    const node: SagaApprovalNode = {
      kind: 'approval',
      id: config.id ?? genId('approval'),
      name: approver,
      approver,
      timeoutMs: config.timeoutMs,
      onTimeout: config.onTimeout ?? 'reject',
    };
    this.nodes.push(node);
    return this;
  }

  build(): SagaGraph {
    if (this.nodes.length === 0) {
      throw new SagaBuilderError(
        'Cannot build a saga with no nodes — add at least one step'
      );
    }
    const graph: SagaGraph = {
      name: this._name,
      description: this._description,
      nodes: this.nodes,
      rootId: this.nodes[0].id,
      timeoutMs: this._timeoutMs,
      defaultRetryPolicy: this._defaultRetryPolicy,
      tenantId: this._tenantId,
      metadata: this._metadata,
    };
    return graph;
  }

  private resolveRetryPolicy(partial: Partial<RetryPolicy>): RetryPolicy {
    const base: RetryPolicy = this._defaultRetryPolicy ?? {
      maxAttempts: 1,
      backoff: 'exponential',
      initialDelayMs: 100,
      maxDelayMs: 30_000,
      jitter: 'equal',
    };
    return {
      maxAttempts: partial.maxAttempts ?? base.maxAttempts,
      backoff: partial.backoff ?? base.backoff,
      initialDelayMs: partial.initialDelayMs ?? base.initialDelayMs,
      maxDelayMs: partial.maxDelayMs ?? base.maxDelayMs,
      jitter: partial.jitter ?? base.jitter,
      retryOn: partial.retryOn ?? base.retryOn,
      circuitBreakerAfter:
        partial.circuitBreakerAfter ?? base.circuitBreakerAfter,
    };
  }
}

export class SagaBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagaBuilderError';
  }
}

export function createSaga(name: string): SagaBuilder {
  return new SagaBuilder(name);
}

export function buildSaga(
  name: string,
  configure: (b: SagaBuilder) => SagaBuilder
): SagaGraph {
  const builder = new SagaBuilder(name);
  return configure(builder).build();
}
