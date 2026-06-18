import { describe, it, beforeEach, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  CommanderError,
  TaskComplexityError,
  OrchestrationError,
  BudgetExhaustedError,
  MemoryError,
  ConsensusError,
  InspectionError,
  ErrorHandler,
  success,
  failure,
  safeExecute,
  type Result,
  type ErrorHandlerConfig,
} from '../src/errorHandler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an error handler with fast retries and no logging. */
function createFastHandler(overrides?: Partial<ErrorHandlerConfig>): ErrorHandler {
  return new ErrorHandler({
    maxRetries: 3,
    retryDelayMs: 1, // 1 ms – effectively instant
    exponentialBackoff: false,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 50, // short cooldown for half-open tests
    maxErrors: 100,
    enableLogging: false, // skip logger entirely
    ...overrides,
  });
}

// =========================================================================
// 1. Error classes
// =========================================================================

describe('CommanderError subclasses', () => {
  it('CommanderError stores code, component, severity, and context', () => {
    const ctx = { detail: 'abc' };
    const err = new CommanderError('boom', 'CODE_X', 'MyComponent', 'high', ctx);
    assert.strictEqual(err.name, 'CommanderError');
    assert.strictEqual(err.message, 'boom');
    assert.strictEqual(err.code, 'CODE_X');
    assert.strictEqual(err.component, 'MyComponent');
    assert.strictEqual(err.severity, 'high');
    assert.deepStrictEqual(err.context, ctx);
    assert.ok(err instanceof Error);
  });

  it('CommanderError context is optional', () => {
    const err = new CommanderError('no ctx', 'X', 'C', 'low');
    assert.strictEqual(err.context, undefined);
  });

  it('TaskComplexityError has correct defaults', () => {
    const err = new TaskComplexityError('too complex');
    assert.strictEqual(err.code, 'TASK_COMPLEXITY');
    assert.strictEqual(err.component, 'TaskComplexityAnalyzer');
    assert.strictEqual(err.severity, 'medium');
    assert.strictEqual(err.message, 'too complex');
    assert.ok(err instanceof CommanderError);
  });

  it('OrchestrationError has correct defaults', () => {
    const err = new OrchestrationError('orchestration failed');
    assert.strictEqual(err.code, 'ORCHESTRATION');
    assert.strictEqual(err.component, 'AdaptiveOrchestrator');
    assert.strictEqual(err.severity, 'high');
    assert.ok(err instanceof CommanderError);
  });

  it('BudgetExhaustedError has correct defaults', () => {
    const err = new BudgetExhaustedError('out of tokens');
    assert.strictEqual(err.code, 'BUDGET_EXHAUSTED');
    assert.strictEqual(err.component, 'TokenBudgetAllocator');
    assert.strictEqual(err.severity, 'critical');
    assert.ok(err instanceof CommanderError);
  });

  it('MemoryError has correct defaults', () => {
    const err = new MemoryError('memory full');
    assert.strictEqual(err.code, 'MEMORY');
    assert.strictEqual(err.component, 'ThreeLayerMemory');
    assert.strictEqual(err.severity, 'medium');
    assert.ok(err instanceof CommanderError);
  });

  it('ConsensusError has correct defaults', () => {
    const err = new ConsensusError('no consensus');
    assert.strictEqual(err.code, 'CONSENSUS');
    assert.strictEqual(err.component, 'ConsensusChecker');
    assert.strictEqual(err.severity, 'high');
    assert.ok(err instanceof CommanderError);
  });

  it('InspectionError has correct defaults', () => {
    const err = new InspectionError('inspection failed');
    assert.strictEqual(err.code, 'INSPECTION');
    assert.strictEqual(err.component, 'InspectorAgent');
    assert.strictEqual(err.severity, 'medium');
    assert.ok(err instanceof CommanderError);
  });

  it('all subclasses pass through context when provided', () => {
    const ctx = { requestId: '42' };
    assert.deepStrictEqual(new TaskComplexityError('m', ctx).context, ctx);
    assert.deepStrictEqual(new OrchestrationError('m', ctx).context, ctx);
    assert.deepStrictEqual(new BudgetExhaustedError('m', ctx).context, ctx);
    assert.deepStrictEqual(new MemoryError('m', ctx).context, ctx);
    assert.deepStrictEqual(new ConsensusError('m', ctx).context, ctx);
    assert.deepStrictEqual(new InspectionError('m', ctx).context, ctx);
  });
});

// =========================================================================
// 2. handleWithRetry – basic retry logic
// =========================================================================

describe('handleWithRetry', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler();
  });

  afterEach(() => {
    handler.clear();
  });

  it('returns result on first successful attempt', async () => {
    const op = mock.fn(() => 42);
    const result = await handler.handleWithRetry(op, {
      component: 'Test',
      operation: 'op',
    });
    assert.strictEqual(result, 42);
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    let calls = 0;
    const op = mock.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('network timeout');
      return 'ok';
    });

    const result = await handler.handleWithRetry(op, {
      component: 'Test',
      operation: 'flaky',
    });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(op.mock.callCount(), 3);
  });

  it('retries on retryable CommanderError (TASK_COMPLEXITY)', async () => {
    let calls = 0;
    const op = mock.fn(async () => {
      calls++;
      if (calls < 2) throw new TaskComplexityError('complex');
      return 'done';
    });

    const result = await handler.handleWithRetry(op, {
      component: 'Test',
      operation: 'complexOp',
    });
    assert.strictEqual(result, 'done');
    assert.strictEqual(op.mock.callCount(), 2);
  });

  it('does NOT retry non-retryable CommanderError (BUDGET_EXHAUSTED)', async () => {
    const op = mock.fn(async () => {
      throw new BudgetExhaustedError('no budget');
    });

    await assert.rejects(
      handler.handleWithRetry(op, { component: 'Test', operation: 'broke' }),
      (err: Error) => err instanceof BudgetExhaustedError,
    );
    // Should be called only once — no retry
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('does NOT retry non-retryable CommanderError (INVALID_INPUT)', async () => {
    const err = new CommanderError('bad input', 'INVALID_INPUT', 'Test', 'low');
    const op = mock.fn(async () => {
      throw err;
    });

    await assert.rejects(
      handler.handleWithRetry(op, { component: 'Test', operation: 'bad' }),
      (e: Error) => e === err,
    );
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('retries ECONNRESET and ETIMEDOUT (Node error codes)', async () => {
    let calls = 0;
    const op = mock.fn(async () => {
      calls++;
      const e: NodeJS.ErrnoException = new Error('reset');
      e.code = 'ECONNRESET';
      if (calls < 2) throw e;
      return 'recovered';
    });

    const result = await handler.handleWithRetry(op, {
      component: 'Test',
      operation: 'netOp',
    });
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(op.mock.callCount(), 2);
  });

  it('does NOT retry ERR_INVALID_ARG_TYPE', async () => {
    const e: NodeJS.ErrnoException = new Error('bad arg');
    e.code = 'ERR_INVALID_ARG_TYPE';
    const op = mock.fn(async () => {
      throw e;
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'Test', operation: 'argOp' }));
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('wraps plain Error in CommanderError on record', async () => {
    let caught: CommanderError | undefined;
    handler.onError((err) => {
      caught = err;
    });

    const op = mock.fn(async () => {
      throw new Error('network timeout');
    });

    // Exhaust retries
    await assert.rejects(
      handler.handleWithRetry(op, { component: 'MyComp', operation: 'failing' }),
    );

    // The last recorded error should be wrapped
    assert.ok(caught);
    assert.strictEqual(caught!.component, 'MyComp');
  });

  it('throws after exhausting all retries', async () => {
    const op = mock.fn(async () => {
      throw new Error('network timeout');
    });

    await assert.rejects(
      handler.handleWithRetry(op, { component: 'Test', operation: 'alwaysFail' }),
      (err: Error) => err.message === 'network timeout',
    );
    // 1 initial + 3 retries = 4 calls
    assert.strictEqual(op.mock.callCount(), 4);
  });

  it('supports synchronous operations', async () => {
    let calls = 0;
    const op = () => {
      calls++;
      if (calls < 2) throw new Error('temporary failure');
      return 'sync-ok';
    };

    const result = await handler.handleWithRetry(op, {
      component: 'Test',
      operation: 'syncOp',
    });
    assert.strictEqual(result, 'sync-ok');
  });
});

// =========================================================================
// 3. Exponential backoff
// =========================================================================

describe('handleWithRetry with exponential backoff', () => {
  it('uses increasing delays when exponentialBackoff is enabled', async () => {
    const handler = new ErrorHandler({
      maxRetries: 3,
      retryDelayMs: 10,
      exponentialBackoff: true,
      enableLogging: false,
    });

    const delays: number[] = [];
    const originalSleep = (handler as any).sleep.bind(handler);
    (handler as any).sleep = async (ms: number) => {
      delays.push(ms);
      // Don't actually sleep
    };

    let calls = 0;
    const op = async () => {
      calls++;
      if (calls <= 3) throw new Error('network timeout');
      return 'ok';
    };

    await handler.handleWithRetry(op, { component: 'Test', operation: 'expBackoff' });

    // With exponential: delay = retryDelayMs * 2^attempt
    // attempt 0: 10 * 2^0 = 10
    // attempt 1: 10 * 2^1 = 20
    // attempt 2: 10 * 2^2 = 40
    assert.deepStrictEqual(delays, [10, 20, 40]);

    handler.clear();
  });

  it('uses constant delay when exponentialBackoff is disabled', async () => {
    const handler = new ErrorHandler({
      maxRetries: 2,
      retryDelayMs: 50,
      exponentialBackoff: false,
      enableLogging: false,
    });

    const delays: number[] = [];
    (handler as any).sleep = async (ms: number) => {
      delays.push(ms);
    };

    let calls = 0;
    const op = async () => {
      calls++;
      if (calls <= 2) throw new Error('timeout');
      return 'ok';
    };

    await handler.handleWithRetry(op, { component: 'Test', operation: 'flatBackoff' });

    assert.deepStrictEqual(delays, [50, 50]);

    handler.clear();
  });
});

// =========================================================================
// 4. Circuit breaker integration
// =========================================================================

describe('Circuit breaker integration', () => {
  it('opens circuit after threshold failures and rejects with CIRCUIT_OPEN', async () => {
    const handler = createFastHandler({
      circuitBreakerThreshold: 3,
      maxRetries: 0, // no retries — one failure per call
    });

    const failingOp = async () => {
      throw new Error('network timeout'); // retryable
    };

    // Drive 3 failures to trip the breaker
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        handler.handleWithRetry(failingOp, {
          component: 'BreakerTest',
          operation: 'fail',
        }),
      );
    }

    // Next call should fail immediately with CIRCUIT_OPEN
    await assert.rejects(
      handler.handleWithRetry(async () => 'never runs', {
        component: 'BreakerTest',
        operation: 'blocked',
      }),
      (err: CommanderError) => {
        assert.strictEqual(err.code, 'CIRCUIT_OPEN');
        assert.strictEqual(err.component, 'BreakerTest');
        return true;
      },
    );

    handler.clear();
  });

  it('transitions to half-open after cooldown and allows a probe request', async () => {
    const handler = createFastHandler({
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 30,
      maxRetries: 0,
    });

    const failingOp = async () => {
      throw new Error('timeout');
    };

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        handler.handleWithRetry(failingOp, {
          component: 'CooldownTest',
          operation: 'fail',
        }),
      );
    }

    // Verify open
    await assert.rejects(
      handler.handleWithRetry(async () => 'x', {
        component: 'CooldownTest',
        operation: 'blocked',
      }),
      (err: CommanderError) => err.code === 'CIRCUIT_OPEN',
    );

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 40));

    // Now half-open — one probe should be allowed and succeed
    const result = await handler.handleWithRetry(async () => 'recovered', {
      component: 'CooldownTest',
      operation: 'probe',
    });
    assert.strictEqual(result, 'recovered');

    handler.clear();
  });

  it('per-component circuit breakers are independent', async () => {
    const handler = createFastHandler({
      circuitBreakerThreshold: 2,
      maxRetries: 0,
    });

    const failOp = async () => {
      throw new Error('timeout');
    };

    // Trip breaker for CompA
    for (let i = 0; i < 2; i++) {
      await assert.rejects(handler.handleWithRetry(failOp, { component: 'CompA', operation: 'f' }));
    }

    // CompA is open
    await assert.rejects(
      handler.handleWithRetry(async () => 'x', { component: 'CompA', operation: 'blocked' }),
      (err: CommanderError) => err.code === 'CIRCUIT_OPEN',
    );

    // CompB is still available
    const result = await handler.handleWithRetry(async () => 'ok', {
      component: 'CompB',
      operation: 'allowed',
    });
    assert.strictEqual(result, 'ok');

    handler.clear();
  });
});

// =========================================================================
// 5. Error listeners (onError / offError)
// =========================================================================

describe('error listeners', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler({ maxRetries: 0 });
  });

  afterEach(() => {
    handler.clear();
  });

  it('onError receives recorded errors', async () => {
    const errors: CommanderError[] = [];
    handler.onError((err) => errors.push(err));

    // Use a non-retryable CommanderError so it records exactly once
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad input', 'INVALID_INPUT', 'ListenerTest', 'low');
        },
        { component: 'ListenerTest', operation: 'op' },
      ),
    );

    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0] instanceof CommanderError);
  });

  it('multiple listeners are all called', async () => {
    const a: CommanderError[] = [];
    const b: CommanderError[] = [];
    handler.onError((e) => a.push(e));
    handler.onError((e) => b.push(e));

    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('denied', 'PERMISSION_DENIED', 'MultiListener', 'high');
        },
        { component: 'MultiListener', operation: 'op' },
      ),
    );

    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a[0], b[0]); // same error object
  });

  it('offError removes a specific listener', async () => {
    const errors: CommanderError[] = [];
    const listener = (e: CommanderError) => errors.push(e);
    handler.onError(listener);

    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad', 'INVALID_INPUT', 'OffTest', 'low');
        },
        { component: 'OffTest', operation: 'op' },
      ),
    );
    assert.strictEqual(errors.length, 1);

    handler.offError(listener);

    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad again', 'INVALID_INPUT', 'OffTest', 'low');
        },
        { component: 'OffTest', operation: 'op2' },
      ),
    );
    // Still 1 — listener was removed
    assert.strictEqual(errors.length, 1);
  });

  it('listener exception does not propagate', async () => {
    handler.onError(() => {
      throw new Error('listener boom');
    });

    // Should not throw the listener error
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new Error('timeout');
        },
        {
          component: 'ThrowingListener',
          operation: 'op',
        },
      ),
      (err: Error) => err.message === 'timeout',
    );
  });
});

// =========================================================================
// 6. getRecentErrors / getErrorsByComponent / getErrorStats
// =========================================================================

describe('error querying', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler({ maxRetries: 0 });
  });

  afterEach(() => {
    handler.clear();
  });

  /** Trigger a non-retryable error so it records exactly once. */
  async function triggerError(component: string) {
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad', 'INVALID_INPUT', component, 'low');
        },
        { component, operation: 'op' },
      ),
    );
  }

  it('getRecentErrors returns latest N errors', async () => {
    await triggerError('A');
    await triggerError('B');
    await triggerError('C');

    const recent = handler.getRecentErrors(2);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].error.component, 'B');
    assert.strictEqual(recent[1].error.component, 'C');
  });

  it('getRecentErrors defaults to 10', async () => {
    for (let i = 0; i < 15; i++) {
      await triggerError('Bulk');
    }
    const recent = handler.getRecentErrors();
    assert.strictEqual(recent.length, 10);
  });

  it('getErrorsByComponent filters correctly', async () => {
    await triggerError('Alpha');
    await triggerError('Beta');
    await triggerError('Alpha');

    const alphaErrors = handler.getErrorsByComponent('Alpha');
    assert.strictEqual(alphaErrors.length, 2);

    const betaErrors = handler.getErrorsByComponent('Beta');
    assert.strictEqual(betaErrors.length, 1);

    const gammaErrors = handler.getErrorsByComponent('Gamma');
    assert.strictEqual(gammaErrors.length, 0);
  });

  it('getErrorStats aggregates by severity and component', async () => {
    // Record a TaskComplexityError (medium) and an OrchestrationError (high)
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new TaskComplexityError('tc');
        },
        {
          component: 'TaskComplexityAnalyzer',
          operation: 'op',
        },
      ),
    );
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new OrchestrationError('orch');
        },
        {
          component: 'AdaptiveOrchestrator',
          operation: 'op',
        },
      ),
    );

    const stats = handler.getErrorStats();
    // TASK_COMPLEXITY is retryable and maxRetries=0, so each is recorded twice
    // (once in catch block, once after loop). ORCHESTRATION is non-retryable (code not in retryable set),
    // so recorded once.
    assert.ok(stats.total >= 2);
    assert.ok(stats.bySeverity['medium'] >= 1);
    assert.ok(stats.bySeverity['high'] >= 1);
    assert.ok(stats.byComponent['TaskComplexityAnalyzer'] >= 1);
    assert.ok(stats.byComponent['AdaptiveOrchestrator'] >= 1);
  });

  it('getErrorStats includes circuit breaker status', async () => {
    // Use a retryable error so cb.onFailure() is called
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new Error('timeout');
        },
        {
          component: 'CompX',
          operation: 'op',
        },
      ),
    );

    const stats = handler.getErrorStats();
    assert.ok('CompX' in stats.circuitBreakerStatus);
    assert.ok(stats.circuitBreakerStatus['CompX'].failures >= 1);
    assert.strictEqual(stats.circuitBreakerStatus['CompX'].open, false);
  });
});

// =========================================================================
// 7. maxErrors cap
// =========================================================================

describe('maxErrors cap', () => {
  it('trims stored errors to maxErrors', async () => {
    const handler = createFastHandler({ maxRetries: 0, maxErrors: 5 });

    for (let i = 0; i < 10; i++) {
      await assert.rejects(
        handler.handleWithRetry(
          async () => {
            throw new Error('timeout');
          },
          {
            component: 'CapTest',
            operation: 'op',
          },
        ),
      );
    }

    const all = handler.getRecentErrors(100);
    assert.strictEqual(all.length, 5);

    handler.clear();
  });
});

// =========================================================================
// 8. Result type helpers
// =========================================================================

describe('Result type', () => {
  it('success() creates a success result', () => {
    const result = success(42);
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data, 42);
    }
  });

  it('success() works with complex data', () => {
    const data = { name: 'test', items: [1, 2, 3] };
    const result = success(data);
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.deepStrictEqual(result.data, data);
    }
  });

  it('failure() creates a failure result', () => {
    const err = new CommanderError('oops', 'CODE', 'Comp', 'low');
    const result = failure(err);
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.strictEqual(result.error, err);
    }
  });

  it('failure() preserves the CommanderError instance', () => {
    const err = new BudgetExhaustedError('no budget');
    const result = failure<string>(err);
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.ok(result.error instanceof BudgetExhaustedError);
      assert.strictEqual(result.error.severity, 'critical');
    }
  });
});

// =========================================================================
// 9. safeExecute wrapper
// =========================================================================

describe('safeExecute', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler({ maxRetries: 1 });
  });

  afterEach(() => {
    handler.clear();
  });

  it('returns success Result when operation succeeds', async () => {
    const result = await safeExecute(() => 'hello', handler, 'SafeTest', 'greet');
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data, 'hello');
    }
  });

  it('returns success Result after retry succeeds', async () => {
    let calls = 0;
    const result = await safeExecute(
      async () => {
        calls++;
        if (calls < 2) throw new Error('timeout');
        return 'recovered';
      },
      handler,
      'SafeTest',
      'retry',
    );
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data, 'recovered');
    }
  });

  it('returns failure Result when all retries exhausted', async () => {
    // Use a CommanderError so it's properly typed in the failure result
    const result = await safeExecute(
      async () => {
        throw new TaskComplexityError('always complex');
      },
      handler,
      'SafeTest',
      'alwaysFail',
    );
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.ok(result.error instanceof CommanderError);
      assert.strictEqual(result.error.code, 'TASK_COMPLEXITY');
    }
  });

  it('returns failure Result for non-retryable error', async () => {
    const result = await safeExecute(
      async () => {
        throw new BudgetExhaustedError('no budget');
      },
      handler,
      'SafeTest',
      'broke',
    );
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.strictEqual(result.error.code, 'BUDGET_EXHAUSTED');
    }
  });

  it('supports async operations', async () => {
    const result = await safeExecute(
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        return 99;
      },
      handler,
      'AsyncTest',
      'delayed',
    );
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data, 99);
    }
  });
});

// =========================================================================
// 10. clear() resets state
// =========================================================================

describe('clear()', () => {
  it('clears recorded errors', async () => {
    const handler = createFastHandler({ maxRetries: 0 });

    // Use non-retryable error so it records exactly once
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad', 'INVALID_INPUT', 'ClearTest', 'low');
        },
        { component: 'ClearTest', operation: 'op' },
      ),
    );
    assert.strictEqual(handler.getRecentErrors().length, 1);

    handler.clear();
    assert.strictEqual(handler.getRecentErrors().length, 0);

    // Error stats should also be empty
    const stats = handler.getErrorStats();
    assert.strictEqual(stats.total, 0);
    assert.deepStrictEqual(stats.bySeverity, {});
    assert.deepStrictEqual(stats.byComponent, {});
    assert.deepStrictEqual(stats.circuitBreakerStatus, {});
  });

  it('resets circuit breakers', async () => {
    const handler = createFastHandler({
      circuitBreakerThreshold: 2,
      maxRetries: 0,
    });

    const failOp = async () => {
      throw new Error('timeout');
    };

    // Trip the breaker
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        handler.handleWithRetry(failOp, { component: 'ResetCB', operation: 'f' }),
      );
    }

    // Verify open
    await assert.rejects(
      handler.handleWithRetry(async () => 'x', { component: 'ResetCB', operation: 'blocked' }),
      (err: CommanderError) => err.code === 'CIRCUIT_OPEN',
    );

    handler.clear();

    // After clear, the breaker should be gone — a new one is created on next use
    const result = await handler.handleWithRetry(async () => 'ok', {
      component: 'ResetCB',
      operation: 'postClear',
    });
    assert.strictEqual(result, 'ok');
  });
});

// =========================================================================
// 11. isRetryable classification (via handleWithRetry behavior)
// =========================================================================

describe('isRetryable classification', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler({ maxRetries: 2 });
  });

  afterEach(() => {
    handler.clear();
  });

  it('retries on message containing "network"', async () => {
    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('network error occurred');
        return 'ok';
      },
      { component: 'T', operation: 'op' },
    );
    assert.strictEqual(calls, 2);
  });

  it('retries on message containing "timeout"', async () => {
    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('connection timeout');
        return 'ok';
      },
      { component: 'T', operation: 'op' },
    );
    assert.strictEqual(calls, 2);
  });

  it('retries on message containing "temporary"', async () => {
    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('temporary service unavailable');
        return 'ok';
      },
      { component: 'T', operation: 'op' },
    );
    assert.strictEqual(calls, 2);
  });

  it('does NOT retry on message containing "invalid" (overrides network pattern)', async () => {
    const op = mock.fn(async () => {
      throw new Error('invalid network request');
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
    // "invalid" is non-retryable and overrides "network"
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('does NOT retry on message containing "validation"', async () => {
    const op = mock.fn(async () => {
      throw new Error('validation error');
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('does NOT retry on message containing "malformed"', async () => {
    const op = mock.fn(async () => {
      throw new Error('malformed input');
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('does NOT retry generic errors without retryable patterns', async () => {
    const op = mock.fn(async () => {
      throw new Error('something went wrong');
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
    assert.strictEqual(op.mock.callCount(), 1);
  });

  it('retries ECONNREFUSED', async () => {
    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        const e: NodeJS.ErrnoException = new Error('refused');
        e.code = 'ECONNREFUSED';
        if (calls < 2) throw e;
        return 'ok';
      },
      { component: 'T', operation: 'op' },
    );
    assert.strictEqual(calls, 2);
  });

  it('retries ETIMEDOUT', async () => {
    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        const e: NodeJS.ErrnoException = new Error('timed out');
        e.code = 'ETIMEDOUT';
        if (calls < 2) throw e;
        return 'ok';
      },
      { component: 'T', operation: 'op' },
    );
    assert.strictEqual(calls, 2);
  });

  it('does NOT retry MODULE_NOT_FOUND', async () => {
    const e: NodeJS.ErrnoException = new Error('not found');
    e.code = 'MODULE_NOT_FOUND';
    const op = mock.fn(async () => {
      throw e;
    });

    await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
    assert.strictEqual(op.mock.callCount(), 1);
  });
});

// =========================================================================
// 12. Non-retryable CommanderError codes
// =========================================================================

describe('non-retryable CommanderError codes', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = createFastHandler({ maxRetries: 3 });
  });

  afterEach(() => {
    handler.clear();
  });

  const nonRetryableCases = [
    { name: 'INVALID_INPUT', make: () => new CommanderError('bad', 'INVALID_INPUT', 'T', 'low') },
    {
      name: 'VALIDATION_ERROR',
      make: () => new CommanderError('bad', 'VALIDATION_ERROR', 'T', 'low'),
    },
    {
      name: 'PERMISSION_DENIED',
      make: () => new CommanderError('denied', 'PERMISSION_DENIED', 'T', 'high'),
    },
    { name: 'NOT_FOUND', make: () => new CommanderError('gone', 'NOT_FOUND', 'T', 'medium') },
    {
      name: 'UNAUTHORIZED',
      make: () => new CommanderError('no auth', 'UNAUTHORIZED', 'T', 'high'),
    },
    { name: 'BUDGET_EXHAUSTED via subclass', make: () => new BudgetExhaustedError('no budget') },
  ];

  for (const tc of nonRetryableCases) {
    it(`does not retry ${tc.name}`, async () => {
      const op = mock.fn(async () => {
        throw tc.make();
      });
      await assert.rejects(handler.handleWithRetry(op, { component: 'T', operation: 'op' }));
      assert.strictEqual(op.mock.callCount(), 1);
    });
  }
});

// =========================================================================
// 13. Listener integration with error recording and stats
// =========================================================================

describe('listener + stats integration', () => {
  it('listeners fire and getErrorStats reflects the error', async () => {
    const handler = createFastHandler({ maxRetries: 0 });
    let listenerCallCount = 0;

    handler.onError(() => {
      listenerCallCount++;
    });

    // Use non-retryable error so it records exactly once
    await assert.rejects(
      handler.handleWithRetry(
        async () => {
          throw new CommanderError('bad', 'INVALID_INPUT', 'Integ', 'low');
        },
        { component: 'Integ', operation: 'op' },
      ),
    );

    assert.strictEqual(listenerCallCount, 1);

    const stats = handler.getErrorStats();
    assert.strictEqual(stats.total, 1);
    assert.strictEqual(stats.byComponent['Integ'], 1);

    handler.clear();
  });
});

// =========================================================================
// 14. Edge cases
// =========================================================================

describe('edge cases', () => {
  it('handleWithRetry with zero retries still executes once', async () => {
    const handler = createFastHandler({ maxRetries: 0 });
    const op = mock.fn(() => 'once');
    const result = await handler.handleWithRetry(op, {
      component: 'Edge',
      operation: 'zero',
    });
    assert.strictEqual(result, 'once');
    assert.strictEqual(op.mock.callCount(), 1);
    handler.clear();
  });

  it('getRecentErrors returns empty array when no errors', () => {
    const handler = createFastHandler();
    assert.deepStrictEqual(handler.getRecentErrors(), []);
    handler.clear();
  });

  it('getErrorStats returns empty aggregates when no errors', () => {
    const handler = createFastHandler();
    const stats = handler.getErrorStats();
    assert.strictEqual(stats.total, 0);
    assert.deepStrictEqual(stats.bySeverity, {});
    assert.deepStrictEqual(stats.byComponent, {});
    assert.deepStrictEqual(stats.circuitBreakerStatus, {});
    handler.clear();
  });

  it('getErrorsByComponent returns empty for unknown component', () => {
    const handler = createFastHandler();
    assert.deepStrictEqual(handler.getErrorsByComponent('NoSuch'), []);
    handler.clear();
  });

  it('offError with non-existent listener is a no-op', () => {
    const handler = createFastHandler();
    handler.offError(() => {}); // should not throw
    handler.clear();
  });

  it('config merges partial overrides with defaults', async () => {
    const handler = new ErrorHandler({ maxRetries: 1, enableLogging: false });
    // Defaults should apply: exponentialBackoff = true, retryDelayMs = 1000, etc.
    // Just verify it doesn't crash and respects maxRetries
    const delays: number[] = [];
    (handler as any).sleep = async (ms: number) => {
      delays.push(ms);
    };

    let calls = 0;
    await handler.handleWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('timeout');
        return 'ok';
      },
      { component: 'Config', operation: 'op' },
    );

    // 1 retry means one delay
    assert.strictEqual(delays.length, 1);
    // Default retryDelayMs = 1000, exponential with attempt 0: 1000 * 2^0 = 1000
    assert.strictEqual(delays[0], 1000);

    handler.clear();
  });
});
