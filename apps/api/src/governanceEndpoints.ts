/**
 * Governance Checkpoint HTTP Endpoints
 * REST API for checkpoint management
 */

import express, { Request, Response, Router } from 'express';
import {
  CheckpointManager,
  RiskScoreCalculator,
  GovernanceCheckpoint,
  CheckpointStats,
  RiskFactor,
} from './governanceCheckpoint';
import { MissionGovernanceMode, MissionRiskLevel } from '@commander/core';

/**
 * Create Governance Checkpoint Router
 */
export function createGovernanceRouter(checkpointManager: CheckpointManager): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.

  // GOV-3: the approver/rejecter identity must be the authenticated principal
  // (never a client-supplied reviewerId), and the principal must hold explicit
  // approve authority (admin role or an 'approve'/'admin'/'*' API-key scope).
  // Returns the principal id, or null after sending a 401/403.
  function resolveApprover(req: Request, res: Response): string | null {
    const principalId = req.user?.id ?? req.apiKeyId;
    if (!principalId) {
      res.status(401).json({ error: 'Authentication required to approve or reject.' });
      return null;
    }
    const scopes = req.apiScopes ?? [];
    const role = req.user?.role;
    const canApprove =
      role === 'admin' ||
      role === 'super_admin' ||
      scopes.includes('approve') ||
      scopes.includes('admin') ||
      scopes.includes('*');
    if (!canApprove) {
      res
        .status(403)
        .json({ error: 'Approve authority (admin role or approve scope) is required.' });
      return null;
    }
    return principalId;
  }

  /**
   * POST /checkpoints
   * Create a new checkpoint
   */
  router.post('/checkpoints', (req: Request, res: Response) => {
    const {
      missionId,
      taskId,
      agentId,
      agentRole,
      taskDescription,
      governanceMode,
      riskScore,
      riskLevel,
      riskFactors,
      approvers,
      timeout,
    } = req.body;

    if (!missionId || !taskId || !agentId || !taskDescription) {
      return res.status(400).json({
        error: 'Missing required fields: missionId, taskId, agentId, taskDescription',
      });
    }

    // GOV-4: never let client-supplied inputs drive auto-approval. Reject unknown
    // governance modes, default a missing mode to the safest (MANUAL, which always
    // requires human approval), and default a missing/invalid risk score to HIGH so
    // the fail-safe direction is "require approval" rather than "auto-approve".
    const VALID_MODES: MissionGovernanceMode[] = ['MANUAL', 'GUARDED', 'AUTO'];
    if (governanceMode !== undefined && !VALID_MODES.includes(governanceMode)) {
      return res.status(400).json({
        error: `Invalid governanceMode: ${String(governanceMode)}. Must be one of ${VALID_MODES.join(', ')}.`,
      });
    }
    const mode: MissionGovernanceMode = VALID_MODES.includes(governanceMode)
      ? governanceMode
      : 'MANUAL';
    const safeRiskScore =
      typeof riskScore === 'number' && Number.isFinite(riskScore) && riskScore >= 0
        ? riskScore
        : 100;
    const safeRiskLevel: MissionRiskLevel = riskLevel || 'HIGH';

    try {
      const checkpoint = checkpointManager.create(
        missionId,
        taskId,
        agentId,
        agentRole || 'agent',
        taskDescription,
        mode,
        safeRiskScore,
        safeRiskLevel,
        riskFactors || [],
        approvers || [],
        timeout,
      );

      res.status(201).json(checkpoint);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * GET /checkpoints/:id
   * Get checkpoint details
   */
  router.get('/checkpoints/:id', (req: Request, res: Response) => {
    const checkpoint = checkpointManager.get(String(req.params.id));
    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    res.json(checkpoint);
  });

  /**
   * GET /checkpoints
   * List checkpoints with filters
   */
  router.get('/checkpoints', (req: Request, res: Response) => {
    const { missionId, approverId, status } = req.query;

    let checkpoints: GovernanceCheckpoint[];

    if (approverId) {
      checkpoints = checkpointManager.getPendingForApprover(approverId as string);
    } else if (missionId) {
      checkpoints = checkpointManager.getPendingByMission(missionId as string);
    } else {
      checkpoints = checkpointManager.getAll();
    }

    if (status) {
      checkpoints = checkpoints.filter((c) => c.status === status);
    }

    res.json({ checkpoints, count: checkpoints.length });
  });

  /**
   * POST /checkpoints/:id/approve
   * Approve a checkpoint
   */
  router.post('/checkpoints/:id/approve', (req: Request, res: Response) => {
    // GOV-3: approver is the authenticated principal, never a body reviewerId.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    const { reason, conditions } = req.body;

    try {
      const existing = checkpointManager.get(String(req.params.id));
      if (existing && existing.context.agentId === approver) {
        return res.status(403).json({ error: 'You cannot approve your own checkpoint.' });
      }
      const checkpoint = checkpointManager.approve(
        String(req.params.id),
        approver,
        reason,
        conditions,
      );
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/:id/reject
   * Reject a checkpoint
   */
  router.post('/checkpoints/:id/reject', (req: Request, res: Response) => {
    // GOV-3: rejecter is the authenticated principal, never a body reviewerId.
    const approver = resolveApprover(req, res);
    if (!approver) return;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Missing reason' });
    }

    try {
      const checkpoint = checkpointManager.reject(String(req.params.id), approver, reason);
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/:id/evidence
   * Add evidence to a checkpoint
   */
  router.post('/checkpoints/:id/evidence', (req: Request, res: Response) => {
    const { type, timestamp, content, source } = req.body;

    if (!type || !content || !source) {
      return res.status(400).json({
        error: 'Missing required fields: type, content, source',
      });
    }

    try {
      const checkpoint = checkpointManager.addEvidence(String(req.params.id), {
        type,
        timestamp: timestamp || new Date().toISOString(),
        content,
        source,
      });
      res.json(checkpoint);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /checkpoints/check-expirations
   * Check and process expired checkpoints
   */
  router.post('/checkpoints/check-expirations', (req: Request, res: Response) => {
    const expired = checkpointManager.checkExpirations();
    res.json({
      message: `Processed ${expired.length} expired checkpoints`,
      expired,
    });
  });

  /**
   * GET /checkpoints/stats
   * Get checkpoint statistics
   */
  router.get('/checkpoints/stats', (req: Request, res: Response) => {
    const { missionId } = req.query;
    const stats = checkpointManager.getStats(missionId as string);
    res.json(stats);
  });

  /**
   * POST /risk-score/calculate
   * Calculate risk score for a task
   */
  router.post('/risk-score/calculate', (req: Request, res: Response) => {
    const { governanceMode, riskLevel, operations, dataSensitivity } = req.body;

    if (!riskLevel || !operations) {
      return res.status(400).json({
        error: 'Missing required fields: riskLevel, operations',
      });
    }

    const score = RiskScoreCalculator.calculate(
      governanceMode || 'SINGLE',
      riskLevel,
      operations,
      dataSensitivity || 'internal',
    );

    const level = RiskScoreCalculator.scoreToLevel(score);

    res.json({
      riskScore: score,
      riskLevel: level,
      governanceMode: governanceMode || 'SINGLE',
      operations,
      dataSensitivity: dataSensitivity || 'internal',
    });
  });

  /**
   * GET /pending-approvals
   * Get all pending approvals for a reviewer
   */
  router.get('/pending-approvals', (req: Request, res: Response) => {
    const { reviewerId } = req.query;

    if (!reviewerId) {
      return res.status(400).json({ error: 'Missing reviewerId' });
    }

    const pending = checkpointManager.getPendingForApprover(reviewerId as string);
    res.json({ pending, count: pending.length });
  });

  return router;
}

/**
 * Export types for external use
 */
export { GovernanceCheckpoint, CheckpointStats, RiskFactor };
