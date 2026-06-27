/**
 * Effect System — Algebraic Effects via Generators
 *
 * Implements the IEffectHandler contract from Pillar II.
 *
 * Since TypeScript doesn't have native algebraic effects, we simulate them
 * using generator functions. A computation yields effects, and the handler
 * interprets them and resumes the computation with a result.
 *
 * Pattern:
 *   function* computation(): Generator<CommanderEffect, R, unknown> {
 *     const response = yield { _tag: 'Http', url: '/api', method: 'GET' };
 *     return process(response);
 *   }
 *
 *   const handler = new EffectHandler();
 *   const result = handler.run(computation());
 *
 * Per constraint IF-08, async operations return Effect types, not raw Promises.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IEffectHandler, CommanderEffect } from '../contracts/pillarII';

// ============================================================================
// Effect Handler Implementation
// ============================================================================

/**
 * A handler function for a specific effect type.
 */
type EffectHandlerFn = (effect: CommanderEffect) => Promise<unknown> | unknown;

/**
 * Generic effect handler that interprets generator-based computations.
 *
 * Register handlers for each effect type (_tag), then run computations.
 */
export class EffectHandler<E extends CommanderEffect = CommanderEffect, R = unknown>
  implements IEffectHandler<E, R>
{
  private handlers: Map<string, EffectHandlerFn> = new Map();
  private logBuffer: Array<{ level: string; message: string; timestamp: number }> = [];

  /**
   * Register a handler for a specific effect type.
   */
  on(effectTag: string, handler: EffectHandlerFn): this {
    this.handlers.set(effectTag, handler);
    return this;
  }

  /**
   * Handle an effect by dispatching to the registered handler.
   * Returns a generator that yields the effect and expects a result.
   */
  handle(effect: E): Generator<CommanderEffect, R, unknown> {
    return (function* () {
      const result = yield effect;
      return result as R;
    })();
  }

  /**
   * Run a generator-based computation to completion.
   *
   * Each yielded effect is dispatched to its registered handler.
   * The handler's result is fed back into the generator.
   *
   * Supports both sync and async effect handlers.
   */
  async run(generator: Generator<CommanderEffect, R, unknown>): Promise<R> {
    let result = generator.next();

    while (!result.done) {
      const effect = result.value;

      // Handle Log effects internally (buffer + forward to logger)
      if (effect._tag === 'Log') {
        const logEffect = effect as { _tag: 'Log'; level: string; message: string };
        this.logBuffer.push({
          level: logEffect.level,
          message: logEffect.message,
          timestamp: Date.now(),
        });
        switch (logEffect.level) {
          case 'error':
            getGlobalLogger().error('EffectSystem', logEffect.message);
            break;
          case 'warn':
            getGlobalLogger().warn('EffectSystem', logEffect.message);
            break;
          case 'info':
            getGlobalLogger().info('EffectSystem', logEffect.message);
            break;
          default:
            getGlobalLogger().debug('EffectSystem', logEffect.message);
        }
        result = generator.next(undefined);
        continue;
      }

      const handler = this.handlers.get(effect._tag);

      if (!handler) {
        throw new Error(`No handler registered for effect type: '${effect._tag}'`);
      }

      try {
        const handlerResult = await handler(effect);
        result = generator.next(handlerResult);
      } catch (err) {
        reportSilentFailure(err, `effectSystem:run:${effect._tag}`);
        // Resume the generator with the error (throw into it)
        result = generator.throw(err as Error);
      }
    }

    return result.value;
  }

  /**
   * Run a synchronous computation (all handlers must be synchronous).
   */
  runSync(generator: Generator<CommanderEffect, R, unknown>): R {
    let result = generator.next();

    while (!result.done) {
      const effect = result.value;
      const handler = this.handlers.get(effect._tag);

      if (!handler) {
        throw new Error(`No handler registered for effect type: '${effect._tag}'`);
      }

      if (effect._tag === 'Log') {
        const logEffect = effect as { _tag: 'Log'; level: string; message: string };
        this.logBuffer.push({
          level: logEffect.level,
          message: logEffect.message,
          timestamp: Date.now(),
        });
        result = generator.next(undefined);
        continue;
      }

      const handlerResult = handler(effect);
      if (handlerResult instanceof Promise) {
        throw new Error(`Effect '${effect._tag}' handler is async — use run() instead of runSync()`);
      }
      result = generator.next(handlerResult);
    }

    return result.value;
  }

  /**
   * Get the log buffer (all Log effects).
   */
  getLogs(): Array<{ level: string; message: string; timestamp: number }> {
    return [...this.logBuffer];
  }

  /**
   * Clear the log buffer.
   */
  clearLogs(): void {
    this.logBuffer = [];
  }

  /**
   * Get all registered effect types.
   */
  getRegisteredEffects(): string[] {
    return [...this.handlers.keys()];
  }
}

// ============================================================================
// Built-in Effect Handlers
// ============================================================================

/**
 * Create a default effect handler with sensible built-in handlers.
 */
export function createDefaultEffectHandler<R = unknown>(): EffectHandler<CommanderEffect, R> {
  const handler = new EffectHandler<CommanderEffect, R>();

  // Http effect handler (mock)
  handler.on('Http', (effect) => {
    const httpEffect = effect as { _tag: 'Http'; url: string; method: string };
    getGlobalLogger().debug('EffectSystem', 'HTTP effect', {
      url: httpEffect.url,
      method: httpEffect.method,
    });
    return { status: 200, body: 'OK' };
  });

  // Db effect handler (mock)
  handler.on('Db', (effect) => {
    const dbEffect = effect as { _tag: 'Db'; operation: string; collection: string };
    getGlobalLogger().debug('EffectSystem', 'DB effect', {
      operation: dbEffect.operation,
      collection: dbEffect.collection,
    });
    return { success: true };
  });

  // LLM effect handler (mock)
  handler.on('LLM', (effect) => {
    const llmEffect = effect as { _tag: 'LLM'; prompt: string; model?: string };
    getGlobalLogger().debug('EffectSystem', 'LLM effect', {
      prompt: llmEffect.prompt.substring(0, 100),
      model: llmEffect.model ?? 'default',
    });
    return { text: 'Generated response', tokensUsed: 100 };
  });

  return handler;
}

// ============================================================================
// Computation Helpers
// ============================================================================

/**
 * Create an Http effect.
 */
export function httpEffect(url: string, method: string = 'GET'): CommanderEffect {
  return { _tag: 'Http', url, method };
}

/**
 * Create a Db effect.
 */
export function dbEffect(operation: string, collection: string): CommanderEffect {
  return { _tag: 'Db', operation, collection };
}

/**
 * Create an LLM effect.
 */
export function llmEffect(prompt: string, model?: string): CommanderEffect {
  return { _tag: 'LLM', prompt, model };
}

/**
 * Create a Log effect.
 */
export function logEffect(level: string, message: string): CommanderEffect {
  return { _tag: 'Log', level, message };
}
