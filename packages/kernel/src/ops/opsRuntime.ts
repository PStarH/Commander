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
  /** Compensation consumer loop — required for /ready to prove the loop is alive.
   *  Probe-only mode proves claimability, NOT that compensation messages are drained. */
  compensation: StartStopComponent & OpsLoopHealth;
}

export class KernelOpsRuntime {
  private running = false;
  private outboxTimer?: ReturnType<typeof setInterval>;
  private outboxInFlight?: Promise<void>;
  private lastOutboxOkAt = 0;
  /** Bumped on each start(); in-flight publishes from prior epochs must not stamp readiness. */
  private outboxEpoch = 0;

  constructor(private readonly dependencies: KernelOpsRuntimeDependencies) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // Each start epoch must prove a fresh outbox tick (ignore pre-stop success).
    this.outboxEpoch += 1;
    const epoch = this.outboxEpoch;
    this.lastOutboxOkAt = 0;
    this.dependencies.reclaim.start();
    this.dependencies.timer.start();
    this.dependencies.compensation.start();
    this.outboxTimer = setInterval(() => {
      void this.publishOutbox();
    }, this.dependencies.outboxIntervalMs);
    void this.kickOutbox(epoch);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.outboxEpoch += 1;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = undefined;
    await Promise.all([
      this.dependencies.reclaim.stop(),
      this.dependencies.timer.stop(),
      this.dependencies.compensation.stop(),
      this.outboxInFlight,
    ]);
    // Only clear if still stopped — a concurrent start() may have stamped a new epoch.
    if (!this.running) this.lastOutboxOkAt = 0;
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

  /** Drain any prior in-flight publish, then run one publish belonging to `epoch`. */
  private async kickOutbox(epoch: number): Promise<void> {
    if (this.outboxInFlight) await this.outboxInFlight;
    if (!this.running || this.outboxEpoch !== epoch) return;
    await this.publishOutbox();
  }

  private async publishOutbox(): Promise<void> {
    if (this.outboxInFlight) return this.outboxInFlight;
    const epoch = this.outboxEpoch;
    this.outboxInFlight = this.dependencies.outbox
      .publish(this.dependencies.outboxBatchSize)
      .then(() => {
        if (this.running && this.outboxEpoch === epoch) {
          this.lastOutboxOkAt = Date.now();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.outboxInFlight = undefined;
      });
    return this.outboxInFlight;
  }
}
