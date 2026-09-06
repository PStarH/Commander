import { Router } from 'express';
import {
  createEvaluationRunner,
  StringMatchGrader,
  OutcomeVerificationGrader,
} from './evaluationRunner';

export function createEvaluationRunnerRouter(): Router {
  const router = Router();

  router.post('/evaluation/grade', async (req, res) => {
    const { trials, graderType, expectedOutput } = req.body ?? {};
    if (!Array.isArray(trials) || trials.length === 0) {
      return res.status(400).json({ error: 'trials array is required' });
    }
    // AUDIT-R4F4: bound sequential grading work per request.
    if (trials.length > 1000) {
      return res.status(413).json({ error: 'trials exceeds 1000 entries' });
    }

    const grader =
      graderType === 'outcome'
        ? new OutcomeVerificationGrader('outcome-check', (t: unknown) => {
            const outcome = (t ?? {}) as { output?: { status?: string } };
            return outcome?.output?.status === 'success';
          })
        : new StringMatchGrader('string-match', expectedOutput ?? '');

    const runner = createEvaluationRunner();
    const results = await runner.gradeTrials(trials, [grader]);

    const output: Record<string, any> = {};
    results.forEach((v, k) => {
      output[k] = v;
    });
    res.json({ results: output });
  });

  router.post('/evaluation/pass-at-k', (req, res) => {
    const { trials, graderResults, k } = req.body ?? {};
    if (!Array.isArray(trials) || !graderResults || !k) {
      return res.status(400).json({ error: 'trials, graderResults, and k are required' });
    }
    // AUDIT-R4F4: validate k and bound the O(n·k) computation.
    const kNum = Number(k);
    if (!Number.isInteger(kNum) || kNum < 1 || kNum > 100 || trials.length > 1000) {
      return res
        .status(400)
        .json({ error: 'k must be an integer in [1,100]; trials capped at 1000' });
    }

    const runner = createEvaluationRunner();
    const map = new Map<string, any>(Object.entries(graderResults));
    const passAtK = runner.calculatePassAtK(trials, map, kNum);

    res.json({ passAtK, k, totalTrials: trials.length });
  });

  return router;
}
