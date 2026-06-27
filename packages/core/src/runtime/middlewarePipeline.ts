/**
 * Middleware Pipeline — Onion model composable interceptors
 *
 * Implements the IMiddlewarePipeline contract from Pillar II.
 *
 * The onion model wraps the terminal handler in layers of middleware,
 * where each middleware can execute logic before and after the next layer:
 *
 *   Request → [Auth] → [RateLimit] → [Logging] → [Handler] → [Logging] → [RateLimit] → [Auth] → Response
 *
 * Composition law: compose(m1, m2, m3)(h) = m1(m2(m3(h)))
 *
 * This is the same pattern used by Koa, Express, and Redux — but
 * generalized to any context/result type pair.
 *
 * Per constraint PII-FR-12, supports composable interceptors for
 * cross-cutting concerns (auth, logging, rate limiting, retries).
 */

import { getGlobalLogger } from '../logging';
import type { IMiddlewarePipeline, Middleware } from '../contracts/pillarII';

// ============================================================================
// Middleware Pipeline Implementation
// ============================================================================

export class MiddlewarePipeline<TContext, TResult>
  implements IMiddlewarePipeline<TContext, TResult>
{
  private middlewares: Middleware<TContext, TResult>[] = [];

  /**
   * Add a middleware to the pipeline.
   * Middlewares are executed in registration order (first registered = outermost layer).
   */
  use(middleware: Middleware<TContext, TResult>): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Execute the pipeline with the given terminal handler.
   *
   * The handler is wrapped by all middlewares in reverse registration order
   * (last registered = innermost layer, closest to handler).
   */
  async execute(
    handler: (ctx: TContext) => Promise<TResult>,
    ctx: TContext,
  ): Promise<TResult> {
    // Build the composed handler by wrapping from inside out
    let composed = handler;

    // Wrap in reverse order so first-registered middleware is outermost
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      composed = this.middlewares[i](composed);
    }

    return composed(ctx);
  }

  /**
   * Get the number of registered middlewares.
   */
  get length(): number {
    return this.middlewares.length;
  }

  /**
   * Clear all middlewares.
   */
  clear(): void {
    this.middlewares = [];
  }
}

// ============================================================================
// Functional Composition (alternative API)
// ============================================================================

/**
 * Compose multiple middlewares into a single handler.
 *
 * compose(m1, m2, m3)(handler) = m1(m2(m3(handler)))
 *
 * This is the functional equivalent of the class-based pipeline,
 * useful for one-off compositions.
 */
export function compose<TContext, TResult>(
  ...middlewares: Middleware<TContext, TResult>[]
): (handler: (ctx: TContext) => Promise<TResult>) => (ctx: TContext) => Promise<TResult> {
  return (handler) => {
    let composed = handler;
    for (let i = middlewares.length - 1; i >= 0; i--) {
      composed = middlewares[i](composed);
    }
    return composed;
  };
}

// ============================================================================
// Common Middleware Factories
// ============================================================================

/**
 * Logging middleware — logs request and response with timing.
 */
export function loggingMiddleware<TContext, TResult>(
  loggerName: string = 'Pipeline',
): Middleware<TContext, TResult> {
  return (next) => async (ctx) => {
    const startTime = Date.now();
    getGlobalLogger().debug(loggerName, '→ request', { context: ctx });

    try {
      const result = await next(ctx);
      const duration = Date.now() - startTime;
      getGlobalLogger().debug(loggerName, '← response', { durationMs: duration });
      return result;
    } catch (err) {
      const duration = Date.now() - startTime;
      getGlobalLogger().error(loggerName, '✗ error', err as Error, { durationMs: duration });
      throw err;
    }
  };
}

/**
 * Error handling middleware — catches errors and transforms them.
 */
export function errorHandlingMiddleware<TContext, TResult>(
  errorHandler: (err: Error, ctx: TContext) => TResult | Promise<TResult>,
): Middleware<TContext, TResult> {
  return (next) => async (ctx) => {
    try {
      return await next(ctx);
    } catch (err) {
      return errorHandler(err as Error, ctx);
    }
  };
}

/**
 * Timeout middleware — aborts if the handler takes too long.
 * Cleans up the timer properly to avoid resource leaks.
 */
export function timeoutMiddleware<TContext, TResult>(
  timeoutMs: number,
): Middleware<TContext, TResult> {
  return (next) => async (ctx) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        next(ctx),
        new Promise<TResult>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Pipeline timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      // Always clean up the timer, whether the handler completed or timed out
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Rate limiting middleware — rejects if rate exceeded.
 */
export function rateLimitMiddleware<TContext, TResult>(
  maxRequests: number,
  windowMs: number,
): Middleware<TContext, TResult> {
  const timestamps: number[] = [];

  return (next) => async (ctx) => {
    const now = Date.now();
    // Prune old timestamps
    while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      throw new Error(`Rate limit exceeded: ${maxRequests} requests per ${windowMs}ms`);
    }

    timestamps.push(now);
    return next(ctx);
  };
}

/**
 * Retry middleware — retries on failure with exponential backoff.
 */
export function retryMiddleware<TContext, TResult>(
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Middleware<TContext, TResult> {
  return (next) => async (ctx) => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next(ctx);
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          getGlobalLogger().debug('RetryMiddleware', `Retrying after ${delay}ms`, {
            attempt: attempt + 1,
            maxRetries,
            error: lastError.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  };
}

// ============================================================================
// LLM Call Pipeline (pre-built for the most common use case)
// ============================================================================

/**
 * Context for LLM call pipeline.
 */
export interface LLMCallContext {
  /** Model ID */
  modelId: string;
  /** Provider ID */
  providerId: string;
  /** Prompt/messages */
  prompt: string;
  /** Maximum tokens */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** User ID for auth/billing */
  userId?: string;
  /** API key for the provider */
  apiKey?: string;
  /** Request start time (set by logging middleware) */
  _startTime?: number;
  /** Token count (set by token counting middleware) */
  _tokenCount?: number;
  /** Estimated cost (set by cost tracking middleware) */
  _estimatedCost?: number;
}

/**
 * Result from LLM call pipeline.
 */
export interface LLMCallResult {
  /** Generated text */
  text: string;
  /** Model used */
  model: string;
  /** Token usage */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Latency in ms */
  latencyMs?: number;
  /** Cost in USD */
  cost?: number;
}

/**
 * Create a pre-built LLM call pipeline with common middlewares.
 *
 * Pipeline order (outermost to innermost):
 * 1. Logging (request/response timing)
 * 2. Rate limiting (prevent abuse)
 * 3. Error handling (catch provider errors)
 * 4. Retry (exponential backoff on transient failures)
 * 5. Timeout (prevent hanging)
 * 6. Handler (actual LLM call)
 */
export function createLLMCallPipeline(
  handler: (ctx: LLMCallContext) => Promise<LLMCallResult>,
  options?: {
    rateLimit?: { maxRequests: number; windowMs: number };
    timeoutMs?: number;
    maxRetries?: number;
  },
): MiddlewarePipeline<LLMCallContext, LLMCallResult> {
  const pipeline = new MiddlewarePipeline<LLMCallContext, LLMCallResult>();

  pipeline.use(loggingMiddleware('LLMCall'));

  if (options?.rateLimit) {
    pipeline.use(
      rateLimitMiddleware(options.rateLimit.maxRequests, options.rateLimit.windowMs),
    );
  }

  pipeline.use(errorHandlingMiddleware<LLMCallContext, LLMCallResult>((err, ctx) => {
    getGlobalLogger().error('LLMCall', 'Unhandled error', err, { model: ctx.modelId });
    throw err;
  }));

  if (options?.maxRetries && options.maxRetries > 0) {
    pipeline.use(retryMiddleware(options.maxRetries));
  }

  if (options?.timeoutMs) {
    pipeline.use(timeoutMiddleware(options.timeoutMs));
  }

  return pipeline;
}

// ============================================================================
// Singleton Factory
// ============================================================================

/**
 * Create a new middleware pipeline (factory function).
 * Each call returns a fresh pipeline instance.
 */
export function createPipeline<TContext, TResult>(): MiddlewarePipeline<TContext, TResult> {
  return new MiddlewarePipeline<TContext, TResult>();
}
