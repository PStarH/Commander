/**
 * Kernel-ops compensation consumer loop.
 *
 * Drains / probes the `commander.compensation` outbox on an interval so
 * readiness can prove the consumer is alive — not merely that Postgres answers
 * SELECT 1. When a tick callback is provided (full EffectBroker drain), it is
 * used; otherwise the daemon probes claimability with limit 0 (no side effects)
 * and runs DLQ sweep so poison messages still progress.
 */

export interface CompensationConsumerDaemonOptions {
  intervalMs: number;
  /** Full drain tick (prefer). */
  tick?: () => Promise<void>;
  /** Probe-only fallback used when tick is omitted. */
  probe?: () => Promise<void>;
  /** Max age of last successful tick for isHealthy(). Default 3× interval. */
  staleMs?: number;
}

export class CompensationConsumerDaemon {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private running = false;
  private lastOkAt = 0;
  private lastError: string | undefined;
  /** Bumped on each start(); in-flight ticks from prior epochs must not stamp health. */
  private healthEpoch = 0;

  constructor(private readonly options: CompensationConsumerDaemonOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // Each start epoch must prove a fresh tick (ignore pre-stop lastOkAt).
    this.healthEpoch += 1;
    const epoch = this.healthEpoch;
    this.lastOkAt = 0;
    void this.kick(epoch);
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.healthEpoch += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    // Only clear if still stopped — a concurrent start() may have stamped a new epoch.
    if (!this.running) this.lastOkAt = 0;
  }

  /** True when a tick succeeded recently. */
  isHealthy(now = Date.now()): boolean {
    if (!this.running || this.lastOkAt <= 0) return false;
    const staleMs = this.options.staleMs ?? this.options.intervalMs * 3;
    return now - this.lastOkAt <= staleMs;
  }

  lastSuccessAt(): number {
    return this.lastOkAt;
  }

  lastFailure(): string | undefined {
    return this.lastError;
  }

  /** Drain any prior in-flight work, then run one tick belonging to `epoch`. */
  private async kick(epoch: number): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (!this.running || this.healthEpoch !== epoch) return;
    await this.runTick();
  }

  private async runTick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const epoch = this.healthEpoch;
    this.inFlight = (async () => {
      try {
        if (this.options.tick) await this.options.tick();
        else if (this.options.probe) await this.options.probe();
        else throw new Error('CompensationConsumerDaemon requires tick or probe');
        if (this.running && this.healthEpoch === epoch) {
          this.lastOkAt = Date.now();
        }
        this.lastError = undefined;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}
