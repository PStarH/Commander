import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ReflexionGenerator,
  type ReflexionContext,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src/runtime/reflexionGenerator';
import { StepErrorBoundary } from '../src/runtime/stepErrorBoundary';
import type { DeadLetterEntry, DeadLetterQueue } from '../src/runtime/deadLetterQueue';

const baseCtx: ReflexionContext = {
  goal: 'fix the login bug',
  attemptedAction: 'file_write',
  actionResult: '',
  error: '',
  errorClass: 'permanent',
  attemptNumber: 1,
};

/** A no-op DLQ stub for boundary tests. */
function makeStubDLQ(): DeadLetterQueue {
  return {
    record(_entry: DeadLetterEntry): void { /* no-op */ },
    drain(): DeadLetterEntry[] { return []; },
    size(): number { return 0; },
  };
}

describe('ReflexionGenerator', () => {
  describe('heuristic matching', () => {
    let gen: ReflexionGenerator;

    beforeEach(() => {
      gen = new ReflexionGenerator();
    });

    it('matches timeout pattern via ETIMEDOUT', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'connect ETIMEDOUT 10.0.0.1:443' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /time|exceeded|budget/i);
      assert.ok(r.whatToTryNext.length > 0);
      assert.ok(r.confidence > 0.5);
    });

    it('matches not_found via ENOENT', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'ENOENT: no such file or directory, open \'/tmp/x\'' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /not found|resource/i);
    });

    it('matches permission via EACCES', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'EACCES: permission denied, open \'/etc/shadow\'' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /permission|denied/i);
    });

    it('matches rate limit via 429', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: '429 Too Many Requests' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /rate|throttl/i);
    });

    it('matches validation via ZodError', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'ZodError: invalid_type at "name"' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /validation|invalid/i);
    });

    it('matches type_error via TypeError', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'TypeError: x is not a function' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /type|null|undefined/i);
    });

    it('matches parse via SyntaxError', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'SyntaxError: Unexpected token } in JSON at position 42' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /parse|json|syntax/i);
    });

    it('matches network via ECONNREFUSED', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'ECONNREFUSED 127.0.0.1:5432' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /network|connection|refused/i);
    });

    it('matches circuit_breaker via CIRCUIT_OPEN', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'CIRCUIT_OPEN: provider down' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'heuristic');
      assert.match(r.whatFailed, /circuit|unavailable/i);
    });

    it('heuristic increments stats.heuristicHits', async () => {
      const ctx: ReflexionContext = { ...baseCtx, error: 'EACCES: permission denied' };
      await gen.generate(ctx);
      assert.ok(gen.stats.heuristicHits >= 1);
    });
  });

  describe('LLM fallback', () => {
    it('uses LLM when no heuristic matches and provider is set', async () => {
      const fakeProvider: LLMProvider = {
        name: 'fake',
        async call(_req: LLMRequest): Promise<LLMResponse> {
          return {
            content: '```json\n{"whatFailed":"novel error","whyFailed":"unknown cause","whatToTryNext":"check logs"}\n```',
            tokenUsage: { prompt: 10, completion: 20, total: 30 },
            model: 'fake',
          };
        },
      };
      const gen = new ReflexionGenerator(fakeProvider);
      const ctx: ReflexionContext = { ...baseCtx, error: 'unrecognized xqz string' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'llm');
      assert.strictEqual(r.whatFailed, 'novel error');
      assert.strictEqual(r.whyFailed, 'unknown cause');
      assert.strictEqual(r.whatToTryNext, 'check logs');
      assert.strictEqual(gen.stats.llmCalls, 1);
    });

    it('falls back to generic when LLM provider throws', async () => {
      const failingProvider: LLMProvider = {
        name: 'failing',
        async call(): Promise<LLMResponse> {
          throw new Error('LLM is down');
        },
      };
      const gen = new ReflexionGenerator(failingProvider);
      const ctx: ReflexionContext = { ...baseCtx, error: 'weird xqz string' };
      await gen.generate(ctx);
      assert.strictEqual(gen.stats.llmFailures, 1);
      assert.strictEqual(gen.stats.genericFallbacks, 1);
    });

    it('returns low-confidence reflexion (source: llm) when LLM returns malformed JSON', async () => {
      const badProvider: LLMProvider = {
        name: 'bad',
        async call(): Promise<LLMResponse> {
          return { content: 'not json at all', tokenUsage: { prompt: 5, completion: 5, total: 10 }, model: 'bad' };
        },
      };
      const gen = new ReflexionGenerator(badProvider);
      const ctx: ReflexionContext = { ...baseCtx, error: 'obscure xqz string' };
      const r = await gen.generate(ctx);
      assert.strictEqual(r.source, 'llm');
      assert.ok(r.confidence <= 0.5, 'confidence should be low when LLM output cannot be parsed');
      assert.ok(r.whatFailed.length > 0);
      assert.strictEqual(r.raw, 'not json at all');
      assert.strictEqual(gen.stats.llmCalls, 1);
    });

    it('uses generic fallback when no provider is set', async () => {
      const gen = new ReflexionGenerator();
      const ctx: ReflexionContext = { ...baseCtx, error: 'obscure xqz string' };
      await gen.generate(ctx);
      assert.strictEqual(gen.stats.genericFallbacks, 1);
      assert.strictEqual(gen.stats.llmCalls, 0);
    });
  });

  describe('formatForContext', () => {
    it('formats reflexion with attempt, source, and confidence', () => {
      const reflexion = {
        whatFailed: 'tool failed',
        whyFailed: 'no reason',
        whatToTryNext: 'try again',
        confidence: 0.75,
        source: 'heuristic' as const,
      };
      const formatted = ReflexionGenerator.formatForContext(
        { ...baseCtx, attemptNumber: 3 },
        reflexion,
      );
      assert.match(formatted, /attempt 3/);
      assert.match(formatted, /heuristic/);
      assert.match(formatted, /75%/);
      assert.match(formatted, /tool failed/);
      assert.match(formatted, /try again/);
    });
  });

  describe('integration with StepErrorBoundary (smoke)', () => {
    it('generator produces a typed reflexion for the context StepErrorBoundary would pass', async () => {
      // Smoke test: simulate the context StepErrorBoundary would build
      // before calling the generator. The boundary integration is
      // wired separately in agentRuntime; here we verify the generator
      // contract independently.
      const gen = new ReflexionGenerator();
      const reflexion = await gen.generate({
        goal: '',
        attemptedAction: 'test_op',
        actionResult: '',
        error: 'ECONNREFUSED 127.0.0.1:5432',
        errorClass: 'transient',
        attemptNumber: 2,
      });
      assert.strictEqual(reflexion.source, 'heuristic');
      assert.ok(reflexion.whatToTryNext.length > 10, 'heuristic should produce actionable next-step guidance');
    });
  });
});
