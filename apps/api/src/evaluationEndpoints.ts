/**
 * Evaluation API Endpoints
 * REST API for LLM-as-Judge evaluations
 */

import express, { Request, Response, Router } from 'express';
import { LLMEvaluator, ScoreSmoother, EvaluationCriterion, EvaluationRequest } from './evaluation';

/** Hard cap on batch evaluate items to prevent LLM cost / connection exhaustion. */
export const MAX_BATCH_ITEMS = 50;
/** Max concurrent LLM judge calls within a single batch request. */
export const MAX_BATCH_CONCURRENCY = 3;

/**
 * Stable error code returned when no governed judge is wired.
 *
 * LM-28: this module previously constructed its own provider client and called
 * `fetch()` directly. That path had no deadline, no cost authority (no budget
 * reservation, no UCA settlement) and echoed the provider response body into
 * error messages. An ungoverned paid execution path must not be reachable from
 * the production assembly, so the direct provider client has been removed.
 */
export const EVALUATION_NOT_AVAILABLE = 'EVALUATION_NOT_AVAILABLE';

/** Stable error code for a judge call that ran but produced no usable answer. */
export const EVALUATION_JUDGE_FAILED = 'EVALUATION_JUDGE_FAILED';

/** Deadline applied to a single governed judge call. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 30_000;

/**
 * A judge adapter that routes through the project's provider + cost authority.
 *
 * The host is responsible for supplying one. This module deliberately does not
 * provide a fallback: "unconfigured" must be a hard failure, never a silent
 * mock or a direct provider call.
 */
export interface GovernedJudgeAdapter {
  call(prompt: string, options: { signal: AbortSignal }): Promise<string>;
}

export interface GovernedJudgeOptions {
  /** Per-call deadline in ms. Defaults to {@link DEFAULT_JUDGE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Thrown when no governed judge is wired, or a judge call cannot be used. */
export class EvaluationUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'EvaluationUnavailableError';
    this.code = code;
  }
}

/**
 * Normalise a caller-supplied deadline. `NaN`, non-positive and non-finite
 * values fall back to the safe default rather than silently disabling the
 * deadline (a `NaN` timeout would otherwise abort every call immediately, and
 * `0`/negative is never a meaningful deadline).
 */
function normalizeTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_JUDGE_TIMEOUT_MS;
  }
  return Math.floor(timeoutMs);
}

/**
 * Map an evaluation failure to a non-2xx response without leaking upstream
 * text. Provider bodies are never echoed back to the caller.
 */
function sendEvaluationError(res: Response, error: unknown): void {
  if (error instanceof EvaluationUnavailableError) {
    res.status(503).json({ error: error.code });
    return;
  }
  res.status(500).json({ error: 'EVALUATION_FAILED' });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function createEvaluationRouter(
  evaluator: LLMEvaluator,
  smoother: ScoreSmoother,
  llmCall: (prompt: string) => Promise<string>,
): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  /**
   * POST /evaluate
   * Evaluate a single output
   */
  router.post('/evaluate', async (req: Request, res: Response) => {
    const { targetId, targetType, input, output, criteria, context } = req.body;

    if (!targetId || !input || !output || !criteria || criteria.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: targetId, input, output, criteria',
      });
    }

    const request: EvaluationRequest = {
      targetId,
      targetType: targetType || 'agent_output',
      input,
      output,
      criteria: criteria as EvaluationCriterion[],
      context,
    };

    try {
      const results = await evaluator.evaluateMulti(request, llmCall);

      // Add scores to smoother
      results.forEach((r) => smoother.addScore(r.criterion, r.score));

      res.json({
        targetId,
        results,
        aggregated: evaluator.getAggregatedScore(targetId),
      });
    } catch (error) {
      sendEvaluationError(res, error);
    }
  });

  /**
   * POST /evaluate/batch
   * Batch evaluate multiple outputs
   */
  router.post('/evaluate/batch', async (req: Request, res: Response) => {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid items array' });
    }

    if (items.length > MAX_BATCH_ITEMS) {
      return res.status(400).json({
        error: `Batch size exceeds maximum of ${MAX_BATCH_ITEMS}`,
        max: MAX_BATCH_ITEMS,
        received: items.length,
      });
    }

    const allResults: Record<string, any> = {};

    await mapWithConcurrency(items, MAX_BATCH_CONCURRENCY, async (item) => {
      const request: EvaluationRequest = {
        targetId: item.targetId,
        targetType: item.targetType || 'agent_output',
        input: item.input,
        output: item.output,
        criteria: item.criteria as EvaluationCriterion[],
        context: item.context,
      };

      try {
        const results = await evaluator.evaluateMulti(request, llmCall);
        results.forEach((r) => smoother.addScore(r.criterion, r.score));
        allResults[item.targetId] = {
          results,
          aggregated: evaluator.getAggregatedScore(item.targetId),
        };
      } catch (error) {
        allResults[item.targetId] = {
          error: error instanceof EvaluationUnavailableError ? error.code : 'EVALUATION_FAILED',
        };
      }
    });

    res.json({ results: allResults, count: items.length });
  });

  /**
   * GET /evaluate/:targetId
   * Get evaluation results for a target
   */
  router.get('/evaluate/:targetId', (req: Request, res: Response) => {
    const results = evaluator.getResults(String(req.params.targetId));
    const aggregated = evaluator.getAggregatedScore(String(req.params.targetId));

    res.json({ targetId: String(req.params.targetId), results, aggregated });
  });

  /**
   * GET /trends
   * Get score trends across all criteria
   */
  router.get('/trends', (req: Request, res: Response) => {
    const trends = smoother.getAllTrends();

    res.json({
      trends,
      summary: {
        improving: trends.filter((t) => t.trend === 'improving').length,
        declining: trends.filter((t) => t.trend === 'declining').length,
        stable: trends.filter((t) => t.trend === 'stable').length,
      },
    });
  });

  /**
   * GET /trends/:criterion
   * Get trend for a specific criterion
   */
  router.get('/trends/:criterion', (req: Request, res: Response) => {
    const criterion = req.params.criterion as EvaluationCriterion;

    const smoothedScore = smoother.getSmoothedScore(criterion);
    const trend = smoother.detectTrend(criterion);

    res.json({
      criterion,
      smoothedScore,
      trend,
    });
  });

  /**
   * GET /criteria
   * List all available evaluation criteria
   */
  router.get('/criteria', (req: Request, res: Response) => {
    const criteria: Array<{
      id: EvaluationCriterion;
      name: string;
      description: string;
    }> = [
      {
        id: 'answer_relevance',
        name: 'Answer Relevance',
        description: 'How well the output addresses the input',
      },
      {
        id: 'task_completion',
        name: 'Task Completion',
        description: 'Whether all requirements are met',
      },
      {
        id: 'prompt_adherence',
        name: 'Prompt Adherence',
        description: 'How well instructions are followed',
      },
      {
        id: 'helpfulness',
        name: 'Helpfulness',
        description: 'How useful the output is',
      },
      {
        id: 'clarity',
        name: 'Clarity',
        description: 'How clear and understandable the output is',
      },
      {
        id: 'accuracy',
        name: 'Accuracy',
        description: 'How factually correct the output is',
      },
      {
        id: 'safety',
        name: 'Safety',
        description: 'Whether the output is safe and harmless',
      },
    ];

    res.json({ criteria, count: criteria.length });
  });

  /**
   * POST /evaluate/quick
   * Quick evaluation with default criteria
   */
  router.post('/evaluate/quick', async (req: Request, res: Response) => {
    const { targetId, input, output } = req.body;

    if (!targetId || !input || !output) {
      return res.status(400).json({
        error: 'Missing required fields: targetId, input, output',
      });
    }

    // Default criteria: relevance, completion, clarity
    const defaultCriteria: EvaluationCriterion[] = [
      'answer_relevance',
      'task_completion',
      'clarity',
    ];

    const request: EvaluationRequest = {
      targetId,
      targetType: 'agent_output',
      input,
      output,
      criteria: defaultCriteria,
    };

    try {
      const results = await evaluator.evaluateMulti(request, llmCall);
      results.forEach((r) => smoother.addScore(r.criterion, r.score));

      const aggregated = evaluator.getAggregatedScore(targetId);

      // Pass/fail based on aggregated average
      const passed = aggregated ? aggregated.average >= 3.5 : false;

      res.json({
        targetId,
        results,
        aggregated,
        passed,
        recommendation: passed ? 'Output meets quality standards' : 'Output needs improvement',
      });
    } catch (error) {
      sendEvaluationError(res, error);
    }
  });

  /**
   * GET /health
   * Health check for evaluation service
   */
  router.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      evaluator: 'LLM-as-Judge',
      version: '1.0.0',
    });
  });

  return router;
}

/**
 * Build the judge call used by the evaluation router.
 *
 * LM-28: this factory used to construct its own OpenAI/Anthropic client and
 * call `fetch()` directly. That is an **ungoverned paid execution path**: no
 * deadline, no cost reservation, no settlement through the project's cost
 * authority, and provider response bodies were echoed into errors. It has been
 * removed. Supplying a {@link GovernedJudgeAdapter} is now the only way to
 * enable real scoring, and the host must wire one that routes through the
 * project's provider + cost authority.
 *
 * With no adapter the returned call fails closed with
 * {@link EVALUATION_NOT_AVAILABLE} and performs **zero** network I/O — the
 * endpoints report the capability as unavailable instead of fabricating
 * scores. `COMMANDER_EVAL_MOCK` is deliberately no longer consulted here: a
 * mock judge is a test fixture (`createMockLLMCall`), not a production mode.
 */
export function createProductionLLMCall(
  adapter?: GovernedJudgeAdapter,
  options: GovernedJudgeOptions = {},
): (prompt: string) => Promise<string> {
  if (!adapter) {
    return async () => {
      throw new EvaluationUnavailableError(
        EVALUATION_NOT_AVAILABLE,
        'no governed judge adapter is configured',
      );
    };
  }

  const timeoutMs = normalizeTimeout(options.timeoutMs);

  return async (prompt: string): Promise<string> => {
    const signal = AbortSignal.timeout(timeoutMs);
    let raw: string;
    try {
      raw = await adapter.call(prompt, { signal });
    } catch (err) {
      // Never forward the adapter's message verbatim — it may carry provider
      // response text. A timeout is the absence of a decision, not a score.
      if (signal.aborted) {
        throw new EvaluationUnavailableError(
          EVALUATION_JUDGE_FAILED,
          `judge call exceeded its ${timeoutMs}ms deadline`,
        );
      }
      const name = err instanceof Error && err.name ? err.name : 'Error';
      throw new EvaluationUnavailableError(EVALUATION_JUDGE_FAILED, `judge call failed (${name})`);
    }

    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) {
      // Fail rather than fabricate a score from an unusable judge response.
      throw new EvaluationUnavailableError(
        EVALUATION_JUDGE_FAILED,
        'judge returned an empty response',
      );
    }
    return text;
  };
}

/**
 * Create mock LLM call for testing
 */
export function createMockLLMCall(): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    // Simulate LLM response
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Extract criterion from prompt
    let score = 4; // Default good score
    const explanation = 'The output demonstrates good quality in the evaluated dimension.';

    // Simple heuristic for demo
    if (prompt.includes('perfectly') || prompt.includes('crystal clear')) {
      score = 5;
    } else if (prompt.includes('minor') || prompt.includes('slight')) {
      score = 4;
    }

    return JSON.stringify({ score, explanation });
  };
}

/**
 * Start Evaluation Server
 */
export function startEvaluationServer(port: number) {
  const app = express();

  const evaluator = new LLMEvaluator();
  const smoother = new ScoreSmoother();
  const llmCall = createMockLLMCall();

  app.use('/evaluation', createEvaluationRouter(evaluator, smoother, llmCall));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'evaluation' });
  });

  return new Promise<void>((resolve) => {
    app.listen(port, () => {
      process.stdout.write(`Evaluation Server running on http://localhost:${port}\n`);
      process.stdout.write(`API: http://localhost:${port}/evaluation\n`);
      resolve();
    });
  });
}
