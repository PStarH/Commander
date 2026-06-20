/**
 * ConcurrencyController — semaphore for AgentRuntime execute slots.
 *
 * Extracted from AgentRuntime so the god object only delegates.
 */

export class ConcurrencyController {
  private runningCount = 0;
  private waitingQueue: Array<() => void> = [];
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async acquireSlot(): Promise<void> {
    if (this.runningCount < this.maxConcurrency) {
      this.runningCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitingQueue.push(() => {
        this.runningCount++;
        resolve();
      });
    });
  }

  releaseSlot(): void {
    this.runningCount--;
    const next = this.waitingQueue.shift();
    if (next) next();
  }

  getQueueDepth(): number {
    return this.waitingQueue.length;
  }

  getRunningCount(): number {
    return this.runningCount;
  }

  setMaxConcurrency(max: number): void {
    this.maxConcurrency = max;
  }
}
