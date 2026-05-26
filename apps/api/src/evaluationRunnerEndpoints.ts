import { Router } from 'express';
import { createEvaluationRunner, StringMatchGrader, OutcomeVerificationGrader } from './evaluationRunner';

export function createEvaluationRunnerRouter(): Router {
  const router = Router();

  router.post('/evaluation/grade', async (req, res) => {
    const { trials, graderType, expectedOutput } = req.body ?? {};
    if (!Array.isArray(trials) || trials.length === 0) {
      return res.status(400).json({ error: 'trials array is required' });
    }

    const grader = graderType === 'outcome'
      ? new OutcomeVerificationGrader('outcome-check', (t: any) => t.output?.status === 'success')
      : new StringMatchGrader('string-match', expectedOutput ?? '');

    const runner = createEvaluationRunner();
    const results = await runner.gradeTrials(trials, [grader]);

    const output: Record<string, any> = {};
    results.forEach((v, k) => { output[k] = v; });
    res.json({ results: output });
  });

  router.post('/evaluation/pass-at-k', (req, res) => {
    const { trials, graderResults, k } = req.body ?? {};
    if (!Array.isArray(trials) || !graderResults || !k) {
      return res.status(400).json({ error: 'trials, graderResults, and k are required' });
    }

    const runner = createEvaluationRunner();
    const map = new Map<string, any>(Object.entries(graderResults));
    const passAtK = runner.calculatePassAtK(trials, map, k);

    res.json({ passAtK, k, totalTrials: trials.length });
  });

  return router;
}
