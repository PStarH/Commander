import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { SelfAssessmentManager } from './selfAssessment';
import { hasRole } from './userStore';

/**
 * AUDIT-R4F2: self-assessment mutates a process-lifetime assessor map keyed
 * by a caller-chosen global agentId — require developer+ so a viewer from
 * another tenant cannot read or shape another tenant's agent self-model.
 */
function requireAssessmentWriter(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    if (!hasRole(req.user.role, 'developer')) {
      res.status(403).json({ error: 'Self-assessment requires developer role' });
      return;
    }
    next();
    return;
  }
  const scopes = req.apiScopes ?? [];
  if (!scopes.some((sc) => ['write', 'agents:write', 'admin', '*'].includes(sc))) {
    res.status(403).json({ error: 'Self-assessment authority required' });
    return;
  }
  next();
}

export function createSelfAssessmentRouter(): Router {
  const router = Router();
  const manager = new SelfAssessmentManager();

  router.post('/agents/:agentId/self-assess', requireAssessmentWriter, (req, res) => {
    const agentId = String(req.params.agentId);
    const { type, requiredSkills, complexity } = req.body ?? {};

    const result = manager.assess(agentId, {
      type,
      requiredSkills,
      complexity,
    });

    res.json(result);
  });

  router.get('/agents/:agentId/self-model', (req, res) => {
    const agentId = String(req.params.agentId);
    const assessor = manager.peek(agentId);

    if (!assessor) {
      return res.status(404).json({ error: 'Agent not found. Run self-assessment first.' });
    }

    res.json(assessor.getSelfModel());
  });

  return router;
}
