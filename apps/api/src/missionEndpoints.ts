import { Router } from 'express';

/**
 * Mission endpoints — mission-level governance, missionLimits, and
 * per-mission budget tracking. Currently a minimal stub; richer controls
 * land alongside the v2 budget router in a follow-up commit.
 */

export interface MissionLimits {
  /** Hard cap on tokens per mission (0 = unlimited). */
  maxTokens: number;
  /** Hard cap on USD per mission (0 = unlimited). */
  maxCostUsd: number;
  /** Max concurrent sub-agents per mission. */
  maxConcurrency: number;
  /** Max wall-clock duration in milliseconds (0 = unlimited). */
  maxDurationMs: number;
}

export const DEFAULT_MISSION_LIMITS: MissionLimits = {
  maxTokens: 1_000_000,
  maxCostUsd: 25,
  maxConcurrency: 5,
  maxDurationMs: 60 * 60 * 1000,
};

// In-memory mission_budget registry — fetch/update applied later by
// the runtime store. Kept tiny on purpose; durable backing lands separately.
const missionBudgets = new Map<string, MissionLimits>();

export function getMissionLimits(missionId: string): MissionLimits {
  return missionBudgets.get(missionId) ?? DEFAULT_MISSION_LIMITS;
}

export function setMissionLimits(missionId: string, limits: MissionLimits): void {
  missionBudgets.set(missionId, limits);
}

export function createMissionRouter(): Router {
  const router = Router();

  router.get('/api/missions/:missionId/limits', (req, res) => {
    const missionId = String(req.params.missionId ?? '');
    res.json({ missionId, limits: getMissionLimits(missionId) });
  });

  router.put('/api/missions/:missionId/limits', (req, res) => {
    const missionId = String(req.params.missionId ?? '');
    const body = (req.body ?? {}) as Partial<MissionLimits>;
    const updated: MissionLimits = {
      ...getMissionLimits(missionId),
      ...body,
    };
    setMissionLimits(missionId, updated);
    res.json({ missionId, limits: updated, ok: true });
  });

  return router;
}
