/**
 * Evaluation API Endpoints
 * REST API for LLM-as-Judge evaluations
 */

import express, { Request, Response, Router } from 'express';
import { LLMEvaluator, ScoreSmoother, EvaluationCriterion, EvaluationRequest } from './evaluation';
import { resolveSecureApiKey } from '@commander/core/security/secureApiKeyResolver';

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
      res.status(500).json({ error: (error as Error).message });
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

    const allResults: Record<string, any> = {};

    for (const item of items) {
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
          error: (error as Error).message,
        };
      }
    }

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
      res.status(500).json({ error: (error as Error).message });
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
 * Create a production LLM call for LLM-as-Judge evaluation.
 *
 * Uses the real LLM provider when an API key is configured. Falls back to
 * mock only when COMMANDER_EVAL_MOCK=true is explicitly set.
 *
 * Per project constraint: LLM-as-Judge evaluation must use a real provider.
 * Silent fake scores in production are a correctness and safety risk.
 */
export function createProductionLLMCall(): (prompt: string) => Promise<string> {
  const useMock = process.env.COMMANDER_EVAL_MOCK === 'true';

  if (useMock) {
    process.stderr.write('[Evaluation] WARNING: COMMANDER_EVAL_MOCK=true — using mock LLM judge (NOT for production)\n');
    return createMockLLMCall();
  }

  // Resolve API key from EncryptedSecretsVault or environment variable
  const apiKey = resolveSecureApiKey('OPENAI_API_KEY') ?? resolveSecureApiKey('ANTHROPIC_API_KEY');
  const model = process.env.COMMANDER_EVAL_MODEL ?? 'gpt-4o-mini';
  const isAnthropic = !!resolveSecureApiKey('ANTHROPIC_API_KEY') && !resolveSecureApiKey('OPENAI_API_KEY');

  if (!apiKey) {
    // No provider configured — return a clear error instead of fake scores
    return async (_prompt: string) => {
      throw new Error(
        'EVAL_LLM_NOT_CONFIGURED: No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, ' +
          'or set COMMANDER_EVAL_MOCK=true for testing. Evaluation endpoints cannot return real scores without a provider.',
      );
    };
  }

  // Real LLM call via OpenAI-compatible Chat Completions API
  return async (prompt: string): Promise<string> => {
    const baseURL = process.env.COMMANDER_LLM_BASE_URL ?? 'https://api.openai.com/v1';

    if (isAnthropic) {
      // Anthropic Messages API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: process.env.COMMANDER_EVAL_MODEL ?? 'claude-3-5-sonnet-20241022',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) {
        throw new Error(`LLM judge call failed: ${response.status} ${await response.text()}`);
      }
      const data = (await response.json()) as { content: Array<{ text: string }> };
      return data.content[0]?.text ?? '';
    }

    // OpenAI-compatible Chat Completions
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM judge call failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? '';
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
