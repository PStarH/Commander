import { Router } from 'express';
import { SelfAssessmentManager } from './selfAssessment';

export function createSelfAssessmentRouter(): Router {
  const router = Router();
  const manager = new SelfAssessmentManager();

  router.post('/agents/:agentId/self-assess', (req, res) => {
    const { agentId } = req.params;
    const { type, requiredSkills, complexity } = req.body ?? {};

    const result = manager.assess(agentId, {
      type,
      requiredSkills,
      complexity,
    });

    res.json(result);
  });

  router.get('/agents/:agentId/self-model', (req, res) => {
    const { agentId } = req.params;
    const assessor = manager.getOrCreate(agentId);

    if (!assessor) {
      return res.status(404).json({ error: 'Agent not found. Run self-assessment first.' });
    }

    res.json(assessor.getSelfModel());
  });

  return router;
}
