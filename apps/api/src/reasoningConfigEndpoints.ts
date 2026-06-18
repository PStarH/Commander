import { Router } from 'express';
import { selectReasoningMode, confidenceToAction, buildReasoningConfig } from './reasoningConfig';

export function createReasoningConfigRouter(): Router {
  const router = Router();

  router.post('/reasoning/select-mode', (req, res) => {
    const { estimatedSteps, hasBranches, dependenciesComplex } = req.body ?? {};
    if (estimatedSteps === undefined) {
      return res.status(400).json({ error: 'estimatedSteps is required' });
    }

    const mode = selectReasoningMode(estimatedSteps, hasBranches, dependenciesComplex);
    const config = buildReasoningConfig(mode);
    res.json({ mode, config });
  });

  router.post('/reasoning/confidence-action', (req, res) => {
    const { confidence } = req.body ?? {};
    if (confidence === undefined) {
      return res.status(400).json({ error: 'confidence is required (0-1)' });
    }

    const action = confidenceToAction(confidence);
    res.json({ confidence, action });
  });

  return router;
}
