import type { ClaimedStep, KernelWorkerPort, StepExecutor, WorkerAuthenticator, WorkerAuthorization, WorkerDefinition, WorkerExecutionError, WorkerIdentity, WorkerRecord, WorkerRegistry, WorkerServiceConfig } from './types.js';
import { WorkerExecutionError as WorkerError } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Process-local worker loop. It has no HTTP server and no AgentRuntime import:
 * all work is leased from the shared kernel and all lifecycle writes return to it.
 */
export class WorkerService {
  private readonly config: Required<WorkerServiceConfig>;
  private worker: WorkerRecord | null = null;
  private authorization: WorkerAuthorization | null = null;
  private active = new Set<Promise<void>>();
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly definition: WorkerDefinition,
    private readonly identity: WorkerIdentity,
    private readonly authenticator: WorkerAuthenticator,
    private readonly registry: WorkerRegistry,
    private readonly kernel: KernelWorkerPort,
    private readonly executor: StepExecutor,
    config: WorkerServiceConfig = {},
  ) {
    this.config = { leaseTtlMs: config.leaseTtlMs ?? 30_000, workerHeartbeatMs: config.workerHeartbeatMs ?? 10_000, pollIntervalMs: config.pollIntervalMs ?? 250 };
  }

  async start(): Promise<WorkerRecord> {
    if (this.worker) return this.worker;
    if (Date.parse(this.identity.expiresAt) <= Date.now()) throw new Error('Worker identity is expired');
    const authorization = await this.authenticator.authenticate(this.identity, this.definition);
    this.assertAuthorization(authorization);
    await this.registry.initialize();
    this.worker = await this.registry.register(this.definition, this.identity.subject, authorization.tenantIds);
    this.authorization = authorization;
    this.running = true;
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, this.config.workerHeartbeatMs);
    return this.worker;
  }

  async run(signal?: AbortSignal): Promise<void> {
    await this.start();
    while (this.running && !signal?.aborted) {
      const claimed = await this.pollOnce();
      if (!claimed) await sleep(this.config.pollIntervalMs);
    }
    await this.stop();
  }

  async pollOnce(): Promise<boolean> {
    if (!this.running || !this.worker || !this.authorization || this.active.size >= this.worker.maxConcurrency) return false;
    const step = await this.kernel.claimNextStep({ workerId: this.worker.id, workerGeneration: this.worker.generation, leaseTtlMs: this.config.leaseTtlMs, tenantIds: this.authorization.tenantIds.includes('*') ? [] : this.authorization.tenantIds, capabilities: this.worker.capabilities });
    if (!step) return false;
    const task = this.execute(step);
    this.active.add(task);
    void task.catch(() => undefined).finally(() => this.active.delete(task));
    return true;
  }

  async stop(): Promise<void> {
    if (!this.worker) return;
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.registry.drain(this.worker.id, this.worker.generation);
    await Promise.allSettled([...this.active]);
  }

  async waitForIdle(): Promise<void> { await Promise.allSettled([...this.active]); }
  get activeSteps(): number { return this.active.size; }
  get record(): WorkerRecord | null { return this.worker ? structuredClone(this.worker) : null; }

  private async execute(step: ClaimedStep): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let leaseLost = false;
    const interval = setInterval(() => {
      void this.kernel.heartbeatStep(step.id, step.tenantId, step.lease, this.config.leaseTtlMs).then((value) => {
        if (value === null) { leaseLost = true; controller.abort(new Error('Kernel lease lost')); }
      }).catch(() => { leaseLost = true; controller.abort(new Error('Kernel heartbeat failed')); });
    }, Math.max(250, Math.floor(this.config.leaseTtlMs / 3)));
    try {
      const output = await this.executor.execute(step, { signal: controller.signal, worker: this.worker! });
      if (!leaseLost) {
        const completed = await this.kernel.completeStep({ stepId: step.id, tenantId: step.tenantId, lease: step.lease, expectedVersion: step.version, output, actor: this.worker!.id });
        if (completed === null) controller.abort(new Error('Kernel rejected step completion'));
      }
    } catch (error) {
      if (!leaseLost) {
        const known = error instanceof WorkerError ? error : new WorkerError((error as Error).message, { code: 'EXECUTOR_FAILED', retryable: false });
        const failed = await this.kernel.failStep({ stepId: step.id, tenantId: step.tenantId, lease: step.lease, expectedVersion: step.version, error: { code: known.options.code ?? 'EXECUTOR_FAILED', message: known.message, retryable: known.options.retryable ?? false, details: known.options.details }, retryAt: known.options.retryable && known.options.retryDelayMs ? new Date(Date.now() + known.options.retryDelayMs) : undefined, actor: this.worker!.id });
        if (failed === null) controller.abort(new Error('Kernel rejected step failure'));
      }
    } finally { clearInterval(interval); this.activeControllers.delete(controller); }
  }

  private async heartbeat(): Promise<void> {
    if (!this.worker || !this.running) return;
    const updated = await this.registry.heartbeat(this.worker.id, this.worker.generation, this.active.size);
    if (!updated) {
      this.running = false;
      for (const controller of this.activeControllers) controller.abort(new Error('Worker generation is no longer active'));
      return;
    }
    this.worker = updated;
  }
  private assertAuthorization(authorization: WorkerAuthorization): void {
    const allowed = authorization.capabilities;
    if (!allowed.includes('*') && this.definition.capabilities.some((capability) => !allowed.includes(capability))) throw new Error('Worker identity is not authorized for all declared capabilities');
  }
}
