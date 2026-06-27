/**
 * Pillar II: Microkernel Runtime & I/O Multiplexing — Abstract Interface Contracts
 *
 * Per Commander Ultimate Architecture Blueprint Section 3.3.
 * All contracts are abstract interfaces with zero external dependencies.
 */

// ============================================================================
// Microkernel
// ============================================================================

/**
 * Service lifecycle states.
 */
export type ServiceState = 'LOADED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';

/**
 * A service registered with the microkernel.
 */
export interface IService {
  /** Unique service identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Current lifecycle state */
  state: ServiceState;
  /** Start the service */
  start(): Promise<void>;
  /** Stop the service */
  stop(): Promise<void>;
}

/**
 * Microkernel interface — minimal TCB (Trusted Computing Base).
 *
 * Kernel = message bus + capability manager only.
 * All other functionality is provided by registered services.
 *
 * Per constraint C-03, executor statelessness is architectural.
 */
export interface IMicrokernel {
  /** Register a service with the kernel */
  registerService(service: IService): void;
  /** Send an IPC message to a service */
  send(targetServiceId: string, message: unknown): Promise<unknown>;
  /** Subscribe to pub/sub topics */
  subscribe(topic: string, handler: (message: unknown) => void): () => void;
  /** Grant a capability to a service */
  grantCapability(serviceId: string, capability: string): void;
  /** Revoke a capability immediately */
  revokeCapability(serviceId: string, capability: string): void;
  /** Get the current state of a service */
  getServiceState(serviceId: string): ServiceState | undefined;
}

// ============================================================================
// Effect System (Algebraic Effects)
// ============================================================================

/**
 * Effect types as a discriminated union.
 * Per constraint IF-08, async operations return Effect types, not raw Promises.
 */
export type CommanderEffect =
  | { readonly _tag: 'Log'; readonly level: string; readonly message: string }
  | { readonly _tag: 'Http'; readonly url: string; readonly method: string }
  | { readonly _tag: 'Db'; readonly operation: string; readonly collection: string }
  | { readonly _tag: 'LLM'; readonly prompt: string; readonly model?: string };

/**
 * Effect handler interface — handles a specific effect type and
 * resumes the computation with a result.
 *
 * Simulated via TypeScript Generators (yield-based) since TypeScript
 * does not have native algebraic effects.
 */
export interface IEffectHandler<E extends CommanderEffect, R> {
  /** Handle an effect and produce a result */
  handle(effect: E): Generator<CommanderEffect, R, unknown>;
}

// ============================================================================
// Middleware Pipeline (Onion Model)
// ============================================================================

/**
 * Middleware handler — a higher-order function that wraps the next handler.
 * Composition law: compose(m1, m2, m3)(h) = m1(m2(m3(h)))
 */
export type Middleware<TContext, TResult> = (
  next: (ctx: TContext) => Promise<TResult>,
) => (ctx: TContext) => Promise<TResult>;

/**
 * Middleware pipeline with composable interceptors.
 *
 * Per constraint PII-FR-12, supports composable interceptors for
 * cross-cutting concerns (auth, logging, rate limiting, retries).
 */
export interface IMiddlewarePipeline<TContext, TResult> {
  /** Add a middleware to the pipeline */
  use(middleware: Middleware<TContext, TResult>): this;
  /** Execute the pipeline with the given handler as the terminal */
  execute(handler: (ctx: TContext) => Promise<TResult>, ctx: TContext): Promise<TResult>;
}

// ============================================================================
// LLM Router
// ============================================================================

/**
 * Model selection result from the LLM router.
 */
export interface IModelSelection {
  /** Selected model ID */
  modelId: string;
  /** Provider ID */
  providerId: string;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Estimated latency in ms */
  estimatedLatency: number;
  /** Confidence in this selection (0-1) */
  confidence: number;
}

/**
 * LLM Router with O(1) model selection.
 *
 * Per constraint NFR-PERF-02, routing must be O(1) time complexity.
 * Uses pre-computed in-memory routing table with per-provider
 * circuit breakers and fallback chains.
 */
export interface ILLMRouter {
  /** O(1) model selection for a request */
  route(request: unknown): IModelSelection;
  /** Register a provider */
  registerProvider(provider: unknown): void;
  /** Stream a response via SSE multiplexing */
  stream(request: unknown): AsyncIterable<unknown>;
  /** Get provider health status */
  getProviderHealth(providerId: string): ProviderHealth;
  /** Estimate cost for a request */
  estimateCost(request: unknown): number;
}

export interface ProviderHealth {
  providerId: string;
  state: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  averageLatency: number;
  errorRate: number;
  circuitBreakerOpen: boolean;
}

// ============================================================================
// Event Bus
// ============================================================================

/**
 * Event Bus for inter-agent communication (A2A protocol).
 *
 * Per constraint PII-FR-09, supports replay via Last-Event-ID.
 * Per constraint PII-FR-10, supports cross-node A2A communication.
 */
export interface IEventBus {
  /** Publish a message to a topic */
  publish(topic: string, message: unknown): Promise<void>;
  /** Subscribe to a topic */
  subscribe(topic: string, handler: (message: unknown) => void): () => void;
  /** Replay events since a given event ID (gap recovery) */
  replayFrom(eventId: string): AsyncIterable<unknown>;
  /** Set the consumer rate (backpressure) */
  setConsumerRate(ratePerSecond: number): void;
  /** Register a dead letter handler */
  onDeadLetter(handler: (message: unknown, error: Error) => void): void;
}
