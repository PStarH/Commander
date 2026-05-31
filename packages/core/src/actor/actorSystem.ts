/**
 * ActorSystem implementation for Commander.
 *
 * The ActorSystem is the entry point for creating and managing actors.
 * It provides:
 * - Actor creation with configuration
 * - Message routing between actors
 * - Supervisor hierarchy management
 * - System-wide metrics collection
 * - Graceful shutdown
 */

import type {
  ActorId,
  ActorState,
  ActorRef,
  ActorMessage,
  ActorContext,
  ActorBehavior,
  ActorDefinition,
  ActorLogger,
  ActorMetrics,
  ActorSystemConfig,
  ActorSystemMetrics,
  MailboxConfig,
  SupervisorConfig,
} from './types';
import { DEFAULT_ACTOR_SYSTEM_CONFIG } from './types';
import { Mailbox } from './mailbox';
import { Supervisor } from './supervisor';

/**
 * Internal actor instance.
 */
interface ActorInstance {
  id: ActorId;
  typeName: string;
  state: ActorState;
  behavior: ActorBehavior;
  mailbox: Mailbox;
  startTime: number;
  processedCount: number;
  failedCount: number;
  currentState: unknown;
}

/**
 * ActorSystem manages actors and message routing.
 */
export class ActorSystem {
  private readonly config: ActorSystemConfig;
  private readonly logger: ActorLogger;
  private readonly actors = new Map<ActorId, ActorInstance>();
  private readonly supervisors = new Map<ActorId, Supervisor>();
  private readonly parentMap = new Map<ActorId, ActorId>();
  private readonly pendingRequests = new Map<string, {
    resolve: (message: ActorMessage) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }>();
  private started = false;
  private startTime = 0;

  constructor(config: Partial<ActorSystemConfig> = {}) {
    this.config = { ...DEFAULT_ACTOR_SYSTEM_CONFIG, ...config };
    this.logger = this.createLogger();
  }

  /**
   * Start the actor system.
   */
  start(): void {
    this.started = true;
    this.startTime = Date.now();
    this.logger.info('Actor system started', { name: this.config.name });
  }

  /**
   * Stop the actor system and all actors.
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping actor system', { name: this.config.name });

    const actorIds = Array.from(this.actors.keys());
    await Promise.all(actorIds.map((id) => this.stopActor(id)));

    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('System stopped'));
    });
    this.pendingRequests.clear();

    this.started = false;
    this.logger.info('Actor system stopped', { name: this.config.name });
  }

  /**
   * Create a new actor.
   */
  createActor<State>(
    definition: ActorDefinition<State>,
    options: {
      parentId?: ActorId;
      initialData?: Partial<State>;
    } = {},
  ): ActorRef {
    const id = `${definition.typeName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const mailboxConfig = {
      ...this.config.defaultMailboxConfig,
      ...definition.mailboxConfig,
    };

    const supervisorConfig = {
      ...this.config.defaultSupervisorConfig,
      ...definition.supervisorConfig,
    };

    const mailbox = new Mailbox(
      id,
      mailboxConfig,
      this.logger,
      (message) => this.processMessage(id, message),
    );

    const actor: ActorInstance = {
      id,
      typeName: definition.typeName,
      state: 'created',
      behavior: definition.behavior,
      mailbox,
      startTime: Date.now(),
      processedCount: 0,
      failedCount: 0,
      currentState: definition.behavior.initialState,
    };

    this.actors.set(id, actor);

    if (options.parentId) {
      this.parentMap.set(id, options.parentId);
      let supervisor = this.supervisors.get(options.parentId);
      if (!supervisor) {
        supervisor = new Supervisor(options.parentId, supervisorConfig, this.logger);
        this.supervisors.set(options.parentId, supervisor);
      }
    }

    this.logger.info('Actor created', {
      actorId: id,
      typeName: definition.typeName,
      parentId: options.parentId,
    });

    return this.createActorRef(id);
  }

  /**
   * Stop an actor.
   */
  async stopActor(actorId: ActorId): Promise<void> {
    const actor = this.actors.get(actorId);
    if (!actor) return;

    actor.state = 'stopping';
    actor.mailbox.clear();

    if (actor.behavior.onStopped) {
      await actor.behavior.onStopped(this.createContext(actorId), actor.currentState);
    }

    actor.state = 'stopped';
    this.actors.delete(actorId);
    this.parentMap.delete(actorId);

    this.logger.info('Actor stopped', { actorId });
  }

  /**
   * Send a message to an actor.
   */
  send(targetId: ActorId, message: ActorMessage): void {
    const actor = this.actors.get(targetId);
    if (!actor) {
      this.logger.warn('Message to unknown actor', { targetId });
      return;
    }

    if (actor.state === 'stopped') {
      this.logger.warn('Message to stopped actor', { targetId });
      return;
    }

    if (actor.state === 'created') {
      this.startActor(targetId);
    }

    actor.mailbox.enqueue(message);
  }

  /**
   * Ask an actor and wait for response.
   */
  ask<T extends ActorMessage>(
    targetId: ActorId,
    message: ActorMessage,
    timeoutMs?: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs ?? this.config.defaultMessageTimeoutMs;
      const correlationId = message.id;

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Ask timeout for ${targetId}`));
      }, timeout);

      this.pendingRequests.set(correlationId, {
        resolve: resolve as (msg: ActorMessage) => void,
        reject,
        timeoutId,
      });

      this.send(targetId, { ...message, correlationId });
    });
  }

  /**
   * Get actor reference.
   */
  getActorRef(actorId: ActorId): ActorRef | undefined {
    return this.actors.has(actorId) ? this.createActorRef(actorId) : undefined;
  }

  /**
   * Get system metrics.
   */
  getMetrics(): ActorSystemMetrics {
    const actorMetrics: ActorMetrics[] = [];

    this.actors.forEach((actor, id) => {
      actorMetrics.push({
        actorId: id,
        actorType: actor.typeName,
        state: actor.state,
        uptimeMs: Date.now() - actor.startTime,
        messagesProcessed: actor.processedCount,
        messagesFailed: actor.failedCount,
        messagesDropped: 0,
        currentMailboxSize: actor.mailbox.size,
        averageProcessingTimeMs: 0,
        restartCount: 0,
      });
    });

    // Single pass to count running and failed actors (avoids two Array.from calls)
    let runningActors = 0;
    let failedActors = 0;
    for (const actor of this.actors.values()) {
      if (actor.state === 'running') runningActors++;
      else if (actor.state === 'failed') failedActors++;
    }

    return {
      systemName: this.config.name,
      totalActors: this.actors.size,
      runningActors,
      failedActors,
      totalMessagesProcessed: actorMetrics.reduce((sum, m) => sum + m.messagesProcessed, 0),
      totalMessagesFailed: actorMetrics.reduce((sum, m) => sum + m.messagesFailed, 0),
      uptimeMs: Date.now() - this.startTime,
      actorMetrics,
    };
  }

  private startActor(actorId: ActorId): void {
    const actor = this.actors.get(actorId);
    if (!actor || actor.state !== 'created') return;

    actor.state = 'running';
    actor.startTime = Date.now();

    if (actor.behavior.onStarted) {
      void actor.behavior.onStarted(this.createContext(actorId), actor.currentState);
    }

    this.logger.debug('Actor started', { actorId });
  }

  private async processMessage(actorId: ActorId, message: ActorMessage): Promise<void> {
    const actor = this.actors.get(actorId);
    if (!actor || actor.state !== 'running') return;

    actor.processedCount++;
    const startTime = Date.now();

    try {
      const newState = await actor.behavior.receive(
        this.createContext(actorId),
        actor.currentState,
        message,
      );

      if (newState !== undefined) {
        actor.currentState = newState;
      }

      if (message.correlationId && this.pendingRequests.has(message.correlationId)) {
        const pending = this.pendingRequests.get(message.correlationId)!;
        this.pendingRequests.delete(message.correlationId);
        clearTimeout(pending.timeoutId);
        pending.resolve(message);
      }
    } catch (error) {
      actor.failedCount++;
      this.logger.error('Message processing failed', error as Error, {
        actorId,
        messageType: message.type,
      });

      const supervisor = this.supervisors.get(actorId);
      if (supervisor) {
        const shouldRestart = await supervisor.handleFailure(actorId, error as Error);
        if (!shouldRestart) {
          actor.state = 'failed';
        }
      } else if (this.config.defaultSupervisorConfig.propagateFailure) {
        const parentId = this.parentMap.get(actorId);
        if (parentId) {
          const parentSupervisor = this.supervisors.get(parentId);
          if (parentSupervisor) {
            await parentSupervisor.handleFailure(actorId, error as Error);
          }
        }
      }
    }
  }

  private createContext(actorId: ActorId): ActorContext {
    const self = this.createActorRef(actorId);
    const parentId = this.parentMap.get(actorId);
    const parent = parentId ? this.createActorRef(parentId) : undefined;

    return {
      actorId,
      parentId,
      self,
      parent,
      logger: this.logger,
      send: (targetId, message) => this.send(targetId, message),
      ask: (targetId, message, timeoutMs) => this.ask(targetId, message, timeoutMs),
      sendSelf: (message) => this.send(actorId, message),
    };
  }

  private createActorRef(actorId: ActorId): ActorRef {
    const actors = this.actors;
    return {
      id: actorId,
      get state(): ActorState {
        const actor = actors.get(actorId);
        return actor?.state ?? 'stopped';
      },
      send: (message) => this.send(actorId, message),
      ask: (message, timeoutMs) => this.ask(actorId, message, timeoutMs),
      isAlive: () => {
        const actor = actors.get(actorId);
        return actor?.state === 'running' || actor?.state === 'suspended';
      },
    };
  }

  private createLogger(): ActorLogger {
    const prefix = `[ActorSystem:${this.config.name}]`;
    return {
      debug: (msg, data) => console.debug(`${prefix} ${msg}`, data),
      info: (msg, data) => console.info(`${prefix} ${msg}`, data),
      warn: (msg, data) => console.warn(`${prefix} ${msg}`, data),
      error: (msg, error, data) => console.error(`${prefix} ${msg}`, error, data),
    };
  }
}

let defaultSystem: ActorSystem | null = null;

/**
 * Get or create the default actor system.
 */
export function getActorSystem(config?: Partial<ActorSystemConfig>): ActorSystem {
  if (!defaultSystem) {
    defaultSystem = new ActorSystem(config);
    defaultSystem.start();
  }
  return defaultSystem;
}

/**
 * Reset the default actor system (for testing).
 */
export function resetActorSystem(): void {
  if (defaultSystem) {
    void defaultSystem.stop();
    defaultSystem = null;
  }
}
