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
  RiskFactor
} from './governanceCheckpoint';
import { MissionGovernanceMode, MissionRiskLevel } from '@commander/core';

/**
 * Create Governance Checkpoint Router
 */
export function createGovernanceRouter(checkpointManager: CheckpointManager): Router {
  const router = express.Router();
  router.use(express.json());

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
      timeout
    } = req.body;

    if (!missionId || !taskId || !agentId || !taskDescription) {
      return res.status(400).json({
        error: 'Missing required fields: missionId, taskId, agentId, taskDescription'
      });
    }

    try {
      const checkpoint = checkpointManager.create(
        missionId,
        taskId,
        agentId,
        agentRole || 'agent',
        taskDescription,
        governanceMode || 'SINGLE',
        riskScore || 0,
        riskLevel || 'LOW',
        riskFactors || [],
        approvers || [],
        timeout
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
    const checkpoint = checkpointManager.get(req.params.id);
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
      checkpoints = Array.from((checkpointManager as any).checkpoints.values());
    }

    if (status) {
      checkpoints = checkpoints.filter(c => c.status === status);
    }

    res.json({ checkpoints, count: checkpoints.length });
  });

  /**
   * POST /checkpoints/:id/approve
   * Approve a checkpoint
   */
  router.post('/checkpoints/:id/approve', (req: Request, res: Response) => {
    const { reviewerId, reason, conditions } = req.body;

    if (!reviewerId) {
      return res.status(400).json({ error: 'Missing reviewerId' });
    }

    try {
      const checkpoint = checkpointManager.approve(
        req.params.id,
        reviewerId,
        reason,
        conditions
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
    const { reviewerId, reason } = req.body;

    if (!reviewerId || !reason) {
      return res.status(400).json({ error: 'Missing reviewerId or reason' });
    }

    try {
      const checkpoint = checkpointManager.reject(
        req.params.id,
        reviewerId,
        reason
      );
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
        error: 'Missing required fields: type, content, source'
      });
    }

    try {
      const checkpoint = checkpointManager.addEvidence(req.params.id, {
        type,
        timestamp: timestamp || new Date().toISOString(),
        content,
        source
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
      expired
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
        error: 'Missing required fields: riskLevel, operations'
      });
    }

    const score = RiskScoreCalculator.calculate(
      governanceMode || 'SINGLE',
      riskLevel,
      operations,
      dataSensitivity || 'internal'
    );

    const level = RiskScoreCalculator.scoreToLevel(score);

    res.json({
      riskScore: score,
      riskLevel: level,
      governanceMode: governanceMode || 'SINGLE',
      operations,
      dataSensitivity: dataSensitivity || 'internal'
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
