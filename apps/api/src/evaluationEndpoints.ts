/**
 * Evaluation API Endpoints
 * REST API for LLM-as-Judge evaluations
 */

import express, { Request, Response, Router } from 'express';
import {
  EVALUATION_CRITERIA,
  EVALUATION_CRITERION_CATALOGUE,
  LLMEvaluator,
  ScoreSmoother,
  EvaluationCriterion,
  EvaluationRequest,
  isEvaluationCriterion,
} from './evaluation';

/** Hard cap on batch evaluate items to prevent LLM cost / connection exhaustion. */
export const MAX_BATCH_ITEMS = 50;
/** Max concurrent LLM judge calls within a single batch request. */
export const MAX_BATCH_CONCURRENCY = 3;

/**
 * Max criteria entries accepted for a single evaluated item.
 *
 * AUDIT api-management#L2: `criteria` was only checked for truthiness and a
 * non-zero length, then cast to `EvaluationCriterion[]`. `evaluateMulti` runs
 * **one judge call per entry**, so `criteria: Array(10_000).fill('clarity')`
 * fit inside the global body limit and produced 10 000 paid calls from one
 * authenticated request. Batch capped the item count at
 * {@link MAX_BATCH_ITEMS} but never bounded each item's criteria, and three
 * batch workers bound concurrency, not total work.
 *
 * The declared surface is exactly {@link EVALUATION_CRITERIA}, so the bound is
 * the size of that set — not an arbitrary number.
 */
export const MAX_CRITERIA_PER_ITEM = EVALUATION_CRITERIA.length;

/**
 * Max criteria entries accepted across one batch request.
 *
 * Derivable from the two caps above; kept explicit and asserted so that
 * widening either one cannot silently widen the total work a single request can
 * buy.
 */
export const MAX_CRITERIA_PER_REQUEST = MAX_BATCH_ITEMS * MAX_CRITERIA_PER_ITEM;

/**
 * Max characters accepted for one evaluated text field (`input` / `output` /
 * `context`). The global body limit bounds the request, but not the share a
 * single prompt may take of a judge call.
 */
export const MAX_EVALUATION_FIELD_CHARS = 200_000;

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

// ── Request validation ────────────────────────────────────────────────────
//
// AUDIT api-management#L2: every handler used to validate by truthiness and
// then cast. A cast is not a check — `criteria as EvaluationCriterion[]`
// accepts `Array(10_000).fill('clarity')`, an unknown criterion, or a
// non-array. All three entry points now share one validator so a fix cannot
// land on one route and be forgotten on another.

/** A rejected request: the caller-facing detail, with no provider text in it. */
interface ValidationFailure {
  ok: false;
  detail: string;
}
type Validation<T> = ({ ok: true } & T) | ValidationFailure;

/** A non-empty string within {@link MAX_EVALUATION_FIELD_CHARS}. */
function validateField(raw: unknown, field: string): Validation<{ value: string }> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, detail: `${field} must be a non-empty string` };
  }
  if (raw.length > MAX_EVALUATION_FIELD_CHARS) {
    return {
      ok: false,
      detail: `${field} exceeds ${MAX_EVALUATION_FIELD_CHARS} characters`,
    };
  }
  return { ok: true, value: raw };
}

/**
 * The criteria list for one evaluated item.
 *
 * Rejects — rather than silently repairing — an empty list, more entries than
 * the declared surface, an undeclared criterion, and duplicates. Rejecting is
 * the fail-closed choice: a duplicate is almost always a caller bug, and
 * "repair" would mean deciding on the caller's behalf how many paid calls they
 * meant to buy.
 */
function validateCriteria(raw: unknown): Validation<{ criteria: EvaluationCriterion[] }> {
  if (!Array.isArray(raw)) {
    return { ok: false, detail: 'criteria must be an array' };
  }
  if (raw.length === 0) {
    return { ok: false, detail: 'criteria must not be empty' };
  }
  if (raw.length > MAX_CRITERIA_PER_ITEM) {
    return {
      ok: false,
      detail: `criteria must not exceed ${MAX_CRITERIA_PER_ITEM} entries`,
    };
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isEvaluationCriterion(entry)) {
      return {
        ok: false,
        detail: `unknown criterion: ${typeof entry === 'string' ? entry : typeof entry}`,
      };
    }
    if (seen.has(entry)) {
      return { ok: false, detail: `duplicate criterion: ${entry}` };
    }
    seen.add(entry);
  }
  return { ok: true, criteria: [...seen] as EvaluationCriterion[] };
}

/** `targetType` defaults when absent; anything present must be a declared kind. */
const EVALUATION_TARGET_TYPES = ['agent_output', 'task_result', 'conversation'] as const;

function validateTargetType(
  raw: unknown,
): Validation<{ targetType: EvaluationRequest['targetType'] }> {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, targetType: 'agent_output' };
  }
  if (typeof raw !== 'string' || !(EVALUATION_TARGET_TYPES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      detail: `targetType must be one of: ${EVALUATION_TARGET_TYPES.join(', ')}`,
    };
  }
  return { ok: true, targetType: raw as EvaluationRequest['targetType'] };
}

/** Validate one item of a batch, including its own criteria bounds. */
function validateEvaluationItem(
  raw: unknown,
  index: number,
): Validation<{ request: EvaluationRequest }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: `items[${index}] must be an object` };
  }
  const item = raw as Record<string, unknown>;
  const at = (field: string) => `items[${index}].${field}`;

  const targetId = validateField(item.targetId, at('targetId'));
  if (!targetId.ok) return targetId;
  const input = validateField(item.input, at('input'));
  if (!input.ok) return input;
  const output = validateField(item.output, at('output'));
  if (!output.ok) return output;
  const criteria = validateCriteria(item.criteria);
  // `validateCriteria` has no notion of which item it is validating, so the
  // batch caller adds the locator — an error that does not name the offending
  // item makes a 50-item rejection needlessly hard to act on.
  if (!criteria.ok) return { ok: false, detail: `${at('criteria')}: ${criteria.detail}` };
  const targetType = validateTargetType(item.targetType);
  if (!targetType.ok) return { ok: false, detail: `${at('targetType')}: ${targetType.detail}` };
  if (item.context !== undefined && item.context !== null) {
    const context = validateField(item.context, at('context'));
    if (!context.ok) return context;
    return {
      ok: true,
      request: {
        targetId: targetId.value,
        targetType: targetType.targetType,
        input: input.value,
        output: output.value,
        criteria: criteria.criteria,
        context: context.value,
      },
    };
  }
  return {
    ok: true,
    request: {
      targetId: targetId.value,
      targetType: targetType.targetType,
      input: input.value,
      output: output.value,
      criteria: criteria.criteria,
    },
  };
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
    const body = (req.body ?? {}) as Record<string, unknown>;

    const targetId = validateField(body.targetId, 'targetId');
    if (!targetId.ok) return res.status(400).json({ error: targetId.detail });
    const input = validateField(body.input, 'input');
    if (!input.ok) return res.status(400).json({ error: input.detail });
    const output = validateField(body.output, 'output');
    if (!output.ok) return res.status(400).json({ error: output.detail });
    const criteria = validateCriteria(body.criteria);
    if (!criteria.ok) return res.status(400).json({ error: criteria.detail });
    const targetType = validateTargetType(body.targetType);
    if (!targetType.ok) return res.status(400).json({ error: targetType.detail });

    const request: EvaluationRequest = {
      targetId: targetId.value,
      targetType: targetType.targetType,
      input: input.value,
      output: output.value,
      criteria: criteria.criteria,
      context: typeof body.context === 'string' ? body.context : undefined,
    };

    try {
      const results = await evaluator.evaluateMulti(request, llmCall);

      // Add scores to smoother
      results.forEach((r) => smoother.addScore(r.criterion, r.score));

      res.json({
        targetId: targetId.value,
        results,
        aggregated: evaluator.getAggregatedScore(targetId.value),
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { items } = body;

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

    // Validate the whole batch *before* the first judge call. A malformed item
    // is a caller error, so it rejects the request instead of being executed
    // alongside the items that happened to parse.
    const requests: EvaluationRequest[] = [];
    let totalCriteria = 0;
    for (let i = 0; i < items.length; i += 1) {
      const validated = validateEvaluationItem(items[i], i);
      if (!validated.ok) return res.status(400).json({ error: validated.detail });
      totalCriteria += validated.request.criteria.length;
      requests.push(validated.request);
    }
    if (totalCriteria > MAX_CRITERIA_PER_REQUEST) {
      return res.status(400).json({
        error: `Batch criteria total exceeds maximum of ${MAX_CRITERIA_PER_REQUEST}`,
        max: MAX_CRITERIA_PER_REQUEST,
        received: totalCriteria,
      });
    }

    const allResults: Record<string, any> = {};

    await mapWithConcurrency(requests, MAX_BATCH_CONCURRENCY, async (request) => {
      const { targetId: itemTargetId } = request;

      try {
        const results = await evaluator.evaluateMulti(request, llmCall);
        results.forEach((r) => smoother.addScore(r.criterion, r.score));
        allResults[itemTargetId] = {
          results,
          aggregated: evaluator.getAggregatedScore(itemTargetId),
        };
      } catch (error) {
        allResults[itemTargetId] = {
          error: error instanceof EvaluationUnavailableError ? error.code : 'EVALUATION_FAILED',
        };
      }
    });

    res.json({ results: allResults, count: requests.length });
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
    // Derived from the catalogue the validator uses — the published list and the
    // accepted set are now the same object, so they cannot disagree.
    const criteria = EVALUATION_CRITERIA.map((id) => ({
      id,
      name: EVALUATION_CRITERION_CATALOGUE[id].name,
      description: EVALUATION_CRITERION_CATALOGUE[id].description,
    }));

    res.json({ criteria, count: criteria.length });
  });

  /**
   * POST /evaluate/quick
   * Quick evaluation with default criteria
   */
  router.post('/evaluate/quick', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const targetId = validateField(body.targetId, 'targetId');
    if (!targetId.ok) return res.status(400).json({ error: targetId.detail });
    const input = validateField(body.input, 'input');
    if (!input.ok) return res.status(400).json({ error: input.detail });
    const output = validateField(body.output, 'output');
    if (!output.ok) return res.status(400).json({ error: output.detail });

    // Default criteria: relevance, completion, clarity
    const defaultCriteria: EvaluationCriterion[] = [
      'answer_relevance',
      'task_completion',
      'clarity',
    ];

    const request: EvaluationRequest = {
      targetId: targetId.value,
      targetType: 'agent_output',
      input: input.value,
      output: output.value,
      criteria: defaultCriteria,
    };

    try {
      const results = await evaluator.evaluateMulti(request, llmCall);
      results.forEach((r) => smoother.addScore(r.criterion, r.score));

      const aggregated = evaluator.getAggregatedScore(targetId.value);

      // Pass/fail based on aggregated average
      const passed = aggregated ? aggregated.average >= 3.5 : false;

      res.json({
        targetId: targetId.value,
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
