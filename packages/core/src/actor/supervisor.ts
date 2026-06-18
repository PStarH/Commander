/**
 * Supervisor implementation for the Actor Model.
 *
 * Supervisors manage child actors and handle failures through restart strategies.
 * Reference: Erlang/OTP supervisor, Akka Typed supervision.
 *
 * Strategies:
 * - one_for_one: Only restart the failed actor
 * - one_for_all: Restart all actors in the group
 * - rest_for_one: Restart the failed actor and all actors started after it
 */

import type {
  ActorId,
  ActorState,
  ActorRef,
  ActorLogger,
  SupervisorConfig,
  RestartStrategy,
  RestartRecord,
  RestartMessage,
  DEFAULT_SUPERVISOR_CONFIG,
} from './types';

/**
 * Child actor reference with metadata.
 */
interface ChildActor {
  ref: ActorRef;
  startedAt: number;
  lastRestartAt?: number;
  restartCount: number;
}

/**
 * Supervisor manages child actors and handles failures.
 * Implements OTP-style supervision with configurable restart strategies.
 */
export class Supervisor {
  private readonly supervisorId: ActorId;
  private readonly config: SupervisorConfig;
  private readonly logger: ActorLogger;
  private readonly children = new Map<ActorId, ChildActor>();
  private readonly restartHistory: RestartRecord[] = [];

  constructor(supervisorId: ActorId, config: SupervisorConfig, logger: ActorLogger) {
    this.supervisorId = supervisorId;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Register a child actor under this supervisor.
   */
  addChild(ref: ActorRef): void {
    this.children.set(ref.id, {
      ref,
      startedAt: Date.now(),
      restartCount: 0,
    });

    this.logger.debug('Child registered', {
      supervisorId: this.supervisorId,
      childId: ref.id,
    });
  }

  /**
   * Unregister a child actor.
   */
  removeChild(childId: ActorId): void {
    this.children.delete(childId);
    this.logger.debug('Child removed', {
      supervisorId: this.supervisorId,
      childId,
    });
  }

  /**
   * Handle a child failure.
   * Returns true if the child was restarted, false if it should be permanently stopped.
   */
  async handleFailure(childId: ActorId, error: Error): Promise<boolean> {
    const child = this.children.get(childId);
    if (!child) {
      this.logger.warn('Failure from unknown child', {
        supervisorId: this.supervisorId,
        childId,
      });
      return false;
    }

    const recentRestarts = this.getRecentRestarts(childId);
    if (recentRestarts >= this.config.maxRestarts) {
      this.logger.error('Child exceeded restart limit, stopping permanently', undefined, {
        supervisorId: this.supervisorId,
        childId,
        recentRestarts,
        maxRestarts: this.config.maxRestarts,
      });
      return false;
    }

    this.restartHistory.push({
      actorId: childId,
      timestamp: Date.now(),
      strategy: this.config.strategy,
    });

    child.restartCount++;
    child.lastRestartAt = Date.now();

    this.logger.info('Restarting child', {
      supervisorId: this.supervisorId,
      childId,
      strategy: this.config.strategy,
      restartCount: child.restartCount,
      error: error.message,
    });

    const delay = this.calculateBackoff(child.restartCount);
    await this.sleep(delay);

    await this.executeRestartStrategy(childId, error);
    return true;
  }

  /**
   * Get all child actor IDs.
   */
  getChildIds(): ActorId[] {
    return Array.from(this.children.keys());
  }

  /**
   * Get child count.
   */
  get childCount(): number {
    return this.children.size;
  }

  private getRecentRestarts(childId: ActorId): number {
    const windowStart = Date.now() - this.config.restartWindowMs;
    return this.restartHistory.filter((r) => r.actorId === childId && r.timestamp >= windowStart)
      .length;
  }

  private calculateBackoff(restartCount: number): number {
    const { initialDelayMs, maxDelayMs, multiplier, jitterPercent } = this.config.backoff;
    let delay = initialDelayMs * Math.pow(multiplier, restartCount - 1);
    delay = Math.min(delay, maxDelayMs);

    if (jitterPercent > 0) {
      const jitter = delay * (jitterPercent / 100);
      delay += (Math.random() * 2 - 1) * jitter;
    }

    return Math.max(0, Math.floor(delay));
  }

  private async executeRestartStrategy(failedChildId: ActorId, error: Error): Promise<void> {
    switch (this.config.strategy) {
      case 'one_for_one':
        await this.restartSingle(failedChildId, error);
        break;

      case 'one_for_all':
        await this.restartAll(error);
        break;

      case 'rest_for_one':
        await this.restartRestForOne(failedChildId, error);
        break;
    }
  }

  private async restartSingle(childId: ActorId, error: Error): Promise<void> {
    const child = this.children.get(childId);
    if (!child) return;

    try {
      if (child.ref.state !== 'stopped') {
        await this.stopChildGracefully(child.ref);
      }
      await this.startChild(child.ref, error);
    } catch (restartError) {
      this.logger.error('Restart failed', restartError as Error, {
        supervisorId: this.supervisorId,
        childId,
      });
    }
  }

  private async restartAll(error: Error): Promise<void> {
    const childIds = Array.from(this.children.keys());

    for (const childId of childIds) {
      const child = this.children.get(childId);
      if (child && child.ref.state !== 'stopped') {
        await this.stopChildGracefully(child.ref);
      }
    }

    for (const childId of childIds) {
      const child = this.children.get(childId);
      if (child) {
        await this.startChild(child.ref, error);
      }
    }
  }

  private async restartRestForOne(failedChildId: ActorId, error: Error): Promise<void> {
    const childIds = Array.from(this.children.keys());
    const failedIndex = childIds.indexOf(failedChildId);

    if (failedIndex === -1) return;

    const toRestart = childIds.slice(failedIndex);

    for (const childId of toRestart) {
      const child = this.children.get(childId);
      if (child && child.ref.state !== 'stopped') {
        await this.stopChildGracefully(child.ref);
      }
    }

    for (const childId of toRestart) {
      const child = this.children.get(childId);
      if (child) {
        await this.startChild(child.ref, error);
      }
    }
  }

  private async stopChildGracefully(ref: ActorRef): Promise<void> {
    const timeout = this.config.shutdownTimeoutMs;
    const startTime = Date.now();

    ref.send({ id: `stop_${Date.now()}`, type: 'stop', timestamp: Date.now() });

    while (ref.state !== 'stopped' && Date.now() - startTime < timeout) {
      await this.sleep(50);
    }

    if (ref.state !== 'stopped') {
      this.logger.warn('Force stopping child after timeout', {
        supervisorId: this.supervisorId,
        childId: ref.id,
      });
    }
  }

  private async startChild(ref: ActorRef, error: Error): Promise<void> {
    const message: RestartMessage = {
      id: `restart_${Date.now()}`,
      type: 'restart',
      timestamp: Date.now(),
      error,
      strategy: this.config.strategy,
    };
    ref.send(message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
