interface StartStopComponent {
  start(): void;
  stop(): void | Promise<void>;
}

interface OutboxComponent {
  publish(limit?: number, now?: Date): Promise<unknown>;
}

export interface KernelOpsRuntimeDependencies {
  reclaim: StartStopComponent;
  timer: StartStopComponent;
  outbox: OutboxComponent;
  outboxIntervalMs: number;
  outboxBatchSize: number;
  /** Compensation consumer / probe loop — required for /ready to prove drain health. */
  compensation?: StartStopComponent;
}

export class KernelOpsRuntime {
  private running = false;
  private outboxTimer?: ReturnType<typeof setInterval>;
  private outboxInFlight?: Promise<void>;

  constructor(private readonly dependencies: KernelOpsRuntimeDependencies) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dependencies.reclaim.start();
    this.dependencies.timer.start();
    this.dependencies.compensation?.start();
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
      this.dependencies.compensation?.stop(),
      this.outboxInFlight,
    ]);
  }

  runningComponents(): string[] {
    if (!this.running) return [];
    const components = ['reclaim', 'timer', 'outbox'];
    if (this.dependencies.compensation) components.push('compensation');
    return components;
  }

  private async publishOutbox(): Promise<void> {
    if (this.outboxInFlight) return this.outboxInFlight;
    this.outboxInFlight = this.dependencies.outbox
      .publish(this.dependencies.outboxBatchSize)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { this.outboxInFlight = undefined; });
    return this.outboxInFlight;
  }
}
