import type { KernelRepository } from '../repository.js';

export interface ReclaimDaemonConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
}

export interface ReclaimStats {
  cycles: number;
  reclaimed: number;
  requeued: number;
  failed: number;
  compensationRequested: number;
  errors: number;
}

const DEFAULT_CONFIG: ReclaimDaemonConfig = {
  enabled: true,
  pollIntervalMs: 5_000,
  batchSize: 100,
};

export class ReclaimDaemon {
  private readonly config: ReclaimDaemonConfig;
  private readonly stats: ReclaimStats = {
    cycles: 0,
    reclaimed: 0,
    requeued: 0,
    failed: 0,
    compensationRequested: 0,
    errors: 0,
  };
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private started = false;
  private lastOkAt = 0;
  /** Bumped on each start(); in-flight ticks from prior epochs must not stamp health. */
  private healthEpoch = 0;

  constructor(
    private readonly repository: KernelRepository,
    config: Partial<ReclaimDaemonConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.started = true;
    // Each start epoch must prove a fresh tick (ignore pre-start / pre-stop lastOkAt).
    this.healthEpoch += 1;
    const epoch = this.healthEpoch;
    this.lastOkAt = 0;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, this.config.pollIntervalMs);
    void this.kick(epoch);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    this.healthEpoch += 1;
    await this.inFlight;
    // Only clear if still stopped — a concurrent start() may have stamped a new epoch.
    if (!this.started) this.lastOkAt = 0;
  }

  /** True when a tick succeeded recently. */
  isHealthy(now = Date.now()): boolean {
    if (!this.started || this.lastOkAt <= 0) return false;
    return now - this.lastOkAt <= this.config.pollIntervalMs * 3;
  }

  async tick(now = new Date()): Promise<ReclaimStats> {
    if (!this.inFlight) {
      this.inFlight = this.runTick(now).finally(() => { this.inFlight = undefined; });
    }
    await this.inFlight;
    return this.getStats();
  }

  getStats(): ReclaimStats {
    return { ...this.stats };
  }

  /** Drain any prior in-flight work, then run one tick belonging to `epoch`. */
  private async kick(epoch: number): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (!this.started || this.healthEpoch !== epoch) return;
    await this.tick().catch(() => undefined);
  }

  private async runTick(now: Date): Promise<void> {
    const epoch = this.healthEpoch;
    this.stats.cycles++;
    try {
      const reclaimed = await this.repository.reclaimExpiredLeases(now, this.config.batchSize);
      this.stats.reclaimed += reclaimed.length;
      this.stats.requeued += reclaimed.filter((step) => step.state === 'RETRY_WAIT').length;
      const failed = reclaimed.filter((step) => step.state === 'FAILED');
      this.stats.failed += failed.length;
      const compensatingRuns = new Set<string>();
      for (const step of failed) {
        if ((await this.repository.getRun(step.runId, step.tenantId))?.state === 'COMPENSATING') {
          compensatingRuns.add(`${step.tenantId}:${step.runId}`);
        }
      }
      this.stats.compensationRequested += compensatingRuns.size;
      if (this.started && this.healthEpoch === epoch) {
        this.lastOkAt = Date.now();
      }
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }
}
