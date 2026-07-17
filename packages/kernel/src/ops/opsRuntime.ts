interface StartStopComponent {
  start(): void;
  stop(): void | Promise<void>;
}

export interface OpsLoopHealth {
  isHealthy(now?: number): boolean;
}

interface OutboxComponent {
  publish(limit?: number, now?: Date): Promise<unknown>;
}

export interface KernelOpsRuntimeDependencies {
  reclaim: StartStopComponent & OpsLoopHealth;
  timer: StartStopComponent & OpsLoopHealth;
  outbox: OutboxComponent;
  outboxIntervalMs: number;
  outboxBatchSize: number;
  /** Compensation consumer / probe loop — required for /ready to prove drain health. */
  compensation: StartStopComponent & OpsLoopHealth;
}

export class KernelOpsRuntime {
  private running = false;
  private outboxTimer?: ReturnType<typeof setInterval>;
  private outboxInFlight?: Promise<void>;
  private lastOutboxOkAt = 0;

  constructor(private readonly dependencies: KernelOpsRuntimeDependencies) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dependencies.reclaim.start();
    this.dependencies.timer.start();
    this.dependencies.compensation.start();
    this.outboxTimer = setInterval(
      () => { void this.publishOutbox(); },
      this.dependencies.outboxIntervalMs,
    );
    void this.publishOutbox();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = undefined;
    await Promise.all([
      this.dependencies.reclaim.stop(),
      this.dependencies.timer.stop(),
      this.dependencies.compensation.stop(),
      this.outboxInFlight,
    ]);
  }

  runningComponents(): string[] {
    if (!this.running) return [];
    return ['reclaim', 'timer', 'outbox', 'compensation'];
  }

  /** True when all ops loops completed a successful tick recently. */
  isReady(now = Date.now()): boolean {
    if (!this.running) return false;
    if (!this.dependencies.reclaim.isHealthy(now)) return false;
    if (!this.dependencies.timer.isHealthy(now)) return false;
    if (!this.dependencies.compensation.isHealthy(now)) return false;
    if (this.lastOutboxOkAt <= 0) return false;
    return now - this.lastOutboxOkAt <= this.dependencies.outboxIntervalMs * 3;
  }

  private async publishOutbox(): Promise<void> {
    if (this.outboxInFlight) return this.outboxInFlight;
    this.outboxInFlight = this.dependencies.outbox
      .publish(this.dependencies.outboxBatchSize)
      .then(() => { this.lastOutboxOkAt = Date.now(); })
      .catch(() => undefined)
      .finally(() => { this.outboxInFlight = undefined; });
    return this.outboxInFlight;
  }
}
