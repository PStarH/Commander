/**
 * Microkernel — Minimal Trusted Computing Base (TCB)
 *
 * Implements the IMicrokernel contract from Pillar II.
 *
 * Kernel = message bus + capability manager only.
 * All other functionality is provided by registered services.
 *
 * Features:
 * - Service registration with lifecycle management (start/stop)
 * - IPC messaging (request/reply pattern)
 * - Pub/sub topic subscription
 * - Capability-based access control (grant/revoke)
 * - Service state tracking
 *
 * Per constraint C-03, executor statelessness is architectural.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IMicrokernel, IService, ServiceState } from '../contracts/pillarII';

// ============================================================================
// Types
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ServiceEntry {
  service: IService;
  capabilities: Set<string>;
  subscriptions: Map<string, (message: unknown) => void>;
}

// ============================================================================
// Microkernel Implementation
// ============================================================================

export class Microkernel implements IMicrokernel {
  private services: Map<string, ServiceEntry> = new Map();
  private topics: Map<string, Set<(message: unknown) => void>> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestTimeoutMs: number;
  private messageIdCounter = 0;

  constructor(options?: { requestTimeoutMs?: number }) {
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30000;
  }

  /**
   * Register a service with the kernel.
   * Services start in LOADED state and must be started explicitly.
   */
  registerService(service: IService): void {
    if (this.services.has(service.id)) {
      throw new Error(`Service '${service.id}' is already registered`);
    }

    this.services.set(service.id, {
      service,
      capabilities: new Set(),
      subscriptions: new Map(),
    });

    getGlobalLogger().info('Microkernel', 'Service registered', {
      serviceId: service.id,
      name: service.name,
    });
  }

  /**
   * Send an IPC message to a service (request/reply pattern).
   * Returns a promise that resolves with the service's reply.
   */
  async send(targetServiceId: string, message: unknown): Promise<unknown> {
    const entry = this.services.get(targetServiceId);
    if (!entry) {
      throw new Error(`Unknown service: '${targetServiceId}'`);
    }

    if (entry.service.state !== 'RUNNING') {
      throw new Error(
        `Service '${targetServiceId}' is not running (state: ${entry.service.state})`,
      );
    }

    // Check if the service has a handleMessage method
    const service = entry.service as IService & {
      handleMessage?: (message: unknown) => Promise<unknown>;
    };

    if (typeof service.handleMessage === 'function') {
      const requestId = `req-${++this.messageIdCounter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(
            new Error(`Request to '${targetServiceId}' timed out after ${this.requestTimeoutMs}ms`),
          );
        }, this.requestTimeoutMs);

        this.pendingRequests.set(requestId, { resolve, reject, timer });

        service.handleMessage!(message)
          .then((result) => {
            clearTimeout(timer);
            this.pendingRequests.delete(requestId);
            resolve(result);
          })
          .catch((err) => {
            clearTimeout(timer);
            this.pendingRequests.delete(requestId);
            reject(err as Error);
          });
      });
    }

    // If the service doesn't handle messages, treat it as a notification
    getGlobalLogger().debug('Microkernel', 'Message sent (no handler)', {
      targetServiceId,
    });
    return undefined;
  }

  /**
   * Subscribe to a pub/sub topic.
   * Returns an unsubscribe function.
   */
  subscribe(topic: string, handler: (message: unknown) => void): () => void {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, new Set());
    }
    this.topics.get(topic)!.add(handler);

    getGlobalLogger().debug('Microkernel', 'Topic subscription added', { topic });

    return () => {
      const subs = this.topics.get(topic);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) {
          this.topics.delete(topic);
        }
      }
    };
  }

  /**
   * Publish a message to a topic (internal helper).
   */
  publish(topic: string, message: unknown): void {
    const subs = this.topics.get(topic);
    if (!subs) return;

    for (const handler of subs) {
      try {
        handler(message);
      } catch (err) {
        reportSilentFailure(err, `microkernel:publish:${topic}`);
      }
    }
  }

  /**
   * Grant a capability to a service.
   */
  grantCapability(serviceId: string, capability: string): void {
    const entry = this.services.get(serviceId);
    if (!entry) {
      throw new Error(`Unknown service: '${serviceId}'`);
    }

    entry.capabilities.add(capability);
    getGlobalLogger().info('Microkernel', 'Capability granted', {
      serviceId,
      capability,
    });
  }

  /**
   * Revoke a capability from a service.
   */
  revokeCapability(serviceId: string, capability: string): void {
    const entry = this.services.get(serviceId);
    if (!entry) {
      throw new Error(`Unknown service: '${serviceId}'`);
    }

    entry.capabilities.delete(capability);
    getGlobalLogger().info('Microkernel', 'Capability revoked', {
      serviceId,
      capability,
    });
  }

  /**
   * Get the current state of a service.
   */
  getServiceState(serviceId: string): ServiceState | undefined {
    const entry = this.services.get(serviceId);
    return entry?.service.state;
  }

  /**
   * Check if a service has a specific capability.
   */
  hasCapability(serviceId: string, capability: string): boolean {
    const entry = this.services.get(serviceId);
    return entry?.capabilities.has(capability) ?? false;
  }

  /**
   * Start a registered service.
   */
  async startService(serviceId: string): Promise<void> {
    const entry = this.services.get(serviceId);
    if (!entry) {
      throw new Error(`Unknown service: '${serviceId}'`);
    }

    if (entry.service.state === 'RUNNING') {
      return; // Already running
    }

    entry.service.state = 'STARTING';
    try {
      await entry.service.start();
      entry.service.state = 'RUNNING';
      getGlobalLogger().info('Microkernel', 'Service started', { serviceId });
    } catch (err) {
      entry.service.state = 'STOPPED';
      reportSilentFailure(err, `microkernel:startService:${serviceId}`);
      throw err;
    }
  }

  /**
   * Stop a running service.
   */
  async stopService(serviceId: string): Promise<void> {
    const entry = this.services.get(serviceId);
    if (!entry) return;

    if (entry.service.state === 'STOPPED') return;

    entry.service.state = 'STOPPING';
    try {
      await entry.service.stop();
      entry.service.state = 'STOPPED';
      getGlobalLogger().info('Microkernel', 'Service stopped', { serviceId });
    } catch (err) {
      reportSilentFailure(err, `microkernel:stopService:${serviceId}`);
      throw err;
    }
  }

  /**
   * Get all registered service IDs.
   */
  getRegisteredServices(): string[] {
    return [...this.services.keys()];
  }

  /**
   * Get all capabilities for a service.
   */
  getCapabilities(serviceId: string): string[] {
    const entry = this.services.get(serviceId);
    return entry ? [...entry.capabilities] : [];
  }

  /**
   * Get all active topics.
   */
  getTopics(): string[] {
    return [...this.topics.keys()];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalMicrokernel: Microkernel | null = null;

export function getGlobalMicrokernel(): Microkernel {
  if (!globalMicrokernel) {
    globalMicrokernel = new Microkernel();
  }
  return globalMicrokernel;
}
