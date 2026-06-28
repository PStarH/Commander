/**
 * securityPostureEndpoints — Express router that serves real security posture
 * snapshots from the on-disk `.commander/posture-snapshots.json` file.
 *
 * Endpoints:
 *   GET /api/security/posture          — latest posture snapshot + history
 *   GET /api/security/posture/history   — full snapshot history
 *   GET /api/security/posture/:id       — specific snapshot by id
 *
 * This replaces the frontend's `generateMockReport()` with real persisted data,
 * closing GAP-01 from the UX audit report.
 */
import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { toErrorMessage } from './routeHelpers';

const POSTURE_FILE = path.join(process.cwd(), '.commander', 'posture-snapshots.json');

interface PostureDimension {
  dimension: string;
  label: string;
  weight: number;
  score: number;
  controls: Array<{
    id: string;
    name: string;
    description: string;
    isoClauses: string[];
    nistSubcategories: string[];
    effectivenessScore: number;
    automated: boolean;
  }>;
  isoClausesCovered: string[];
  nistSubcategoriesCovered: string[];
  status: string;
  recommendations: string[];
}

interface PostureSnapshot {
  id: string;
  timestamp: string;
  posture: {
    calculatedAt: string;
    overallScore: number;
    grade: string;
    dimensions: PostureDimension[];
    status: string;
    topRisks: string[];
    topStrengths: string[];
  };
  trigger: string;
}

// ── ISO 42001 clause descriptions ──────────────────────────────────────
const ISO_CLAUSE_DESC: Record<string, string> = {
  '6.1': 'Actions to address risks and opportunities',
  '6.2': 'AI objectives and planning to achieve them',
  '7.1': 'Resources for the AI management system',
  '7.2': 'Competence of persons doing AI work',
  '7.3': 'Awareness of the AI management system',
  '7.4': 'Communication relevant to the AI management system',
  '7.5': 'Documented information',
  '8.1': 'Operational planning and control',
  '8.2': 'AI system design and development controls',
  '8.3': 'AI system deployment and operational controls',
  '9.1': 'Monitoring, measurement, analysis and evaluation',
  '9.2': 'Internal audit',
  '9.3': 'Management review',
  '10.1': 'Nonconformity and corrective action',
  '10.2': 'Continual improvement',
};

// ── Cache: read file at most once per 10 seconds ───────────────────────
let cachedSnapshots: PostureSnapshot[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000;

function readSnapshots(): PostureSnapshot[] {
  const now = Date.now();
  if (cachedSnapshots && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSnapshots;
  }

  try {
    const raw = fs.readFileSync(POSTURE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    cachedSnapshots = Array.isArray(data) ? data : [];
    cacheTimestamp = now;
    return cachedSnapshots;
  } catch {
    // File doesn't exist or is invalid — return empty array
    cachedSnapshots = [];
    cacheTimestamp = now;
    return cachedSnapshots;
  }
}

// ── Build ISO compliance summary from real posture dimensions ──────────
function buildIsoCompliance(dimensions: PostureDimension[]) {
  const allClauses = Object.keys(ISO_CLAUSE_DESC);
  const coveredClauses = new Set<string>();
  for (const dim of dimensions) {
    for (const clause of dim.isoClausesCovered) {
      coveredClauses.add(clause);
    }
  }

  const clauseCoverage: Record<string, { covered: boolean; controls: string[]; score: number }> =
    {};
  const gaps: Array<{ clause: string; description: string; severity: string; recommendation: string }> =
    [];

  for (const clause of allClauses) {
    const covered = coveredClauses.has(clause);
    const controls: string[] = [];
    for (const dim of dimensions) {
      for (const ctrl of dim.controls) {
        if (ctrl.isoClauses.includes(clause)) {
          controls.push(ctrl.id);
        }
      }
    }
    clauseCoverage[clause] = {
      covered,
      controls,
      score: covered ? 100 : 0,
    };
    if (!covered) {
      gaps.push({
        clause,
        description: ISO_CLAUSE_DESC[clause] ?? clause,
        severity: 'medium',
        recommendation: `Implement controls for ${ISO_CLAUSE_DESC[clause] ?? clause}`,
      });
    }
  }

  const coveredCount = allClauses.filter((c) => coveredClauses.has(c)).length;
  const compliancePercentage = Math.round((coveredCount / allClauses.length) * 100);

  return {
    fullyCompliant: gaps.length === 0,
    clauseCoverage,
    gaps,
    compliancePercentage,
  };
}

// ── Build NIST AI RMF alignment from real posture dimensions ───────────
function buildNistAlignment(dimensions: PostureDimension[]) {
  const functions = ['GOVERN', 'MAP', 'MEASURE', 'MANAGE'] as const;
  const functionSubcats: Record<string, string[]> = {
    GOVERN: ['GOVERN-1.1', 'GOVERN-1.2', 'GOVERN-2.1', 'GOVERN-3.1', 'GOVERN-4.1'],
    MAP: ['MAP-1.1', 'MAP-2.1', 'MAP-3.1', 'MAP-4.1', 'MAP-5.1'],
    MEASURE: ['MEASURE-1.1', 'MEASURE-2.1', 'MEASURE-2.2', 'MEASURE-3.1'],
    MANAGE: ['MANAGE-1.1', 'MANAGE-2.1', 'MANAGE-3.1', 'MANAGE-4.1'],
  };

  const allSubcats = new Set<string>();
  for (const dim of dimensions) {
    for (const sub of dim.nistSubcategoriesCovered) {
      allSubcats.add(sub);
    }
  }

  const functionCoverage: Record<string, { coveredSubcategories: number; totalSubcategories: number; coveragePercentage: number; controls: string[] }> = {};
  const gaps: Array<{ subcategory: string; description: string; severity: string; recommendation: string }> = [];

  for (const fn of functions) {
    const subcats = functionSubcats[fn];
    const covered = subcats.filter((s) => allSubcats.has(s));
    const controls: string[] = [];
    for (const dim of dimensions) {
      for (const ctrl of dim.controls) {
        for (const sub of ctrl.nistSubcategories) {
          if (subcats.includes(sub)) {
            controls.push(ctrl.id);
          }
        }
      }
    }
    functionCoverage[fn] = {
      coveredSubcategories: covered.length,
      totalSubcategories: subcats.length,
      coveragePercentage: Math.round((covered.length / subcats.length) * 100),
      controls: [...new Set(controls)],
    };
    for (const sub of subcats) {
      if (!allSubcats.has(sub)) {
        gaps.push({
          subcategory: sub,
          description: `${fn} subcategory ${sub}`,
          severity: 'medium',
          recommendation: `Implement controls for ${sub}`,
        });
      }
    }
  }

  const totalCovered = [...allSubcats].filter((s) =>
    Object.values(functionSubcats).flat().includes(s),
  ).length;
  const totalAll = Object.values(functionSubcats).flat().length;
  const alignmentPercentage = Math.round((totalCovered / totalAll) * 100);

  return {
    functionCoverage,
    gaps,
    alignmentPercentage,
  };
}

// ── Build trend analysis from real snapshot history ────────────────────
function buildTrendAnalysis(history: PostureSnapshot[]) {
  if (history.length === 0) {
    return {
      snapshotCount: 0,
      scoreDelta: 0,
      scoreDeltaRecent: 0,
      trend: 'insufficient_data' as const,
      averageScore: 0,
      minScore: 0,
      maxScore: 0,
      volatility: 0,
      projectedScore: 0,
    };
  }

  const scores = history.map((h) => h.posture.overallScore);
  const latest = scores[scores.length - 1]!;
  const first = scores[0]!;
  const recentStart = Math.max(0, scores.length - 6);
  const recentFirst = scores[recentStart]!;

  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const variance = scores.reduce((sum, s) => sum + (s - avg) ** 2, 0) / scores.length;
  const volatility = Math.round(Math.sqrt(variance));

  const delta = latest - first;
  const deltaRecent = latest - recentFirst;
  let trend: 'improving' | 'stable' | 'declining' | 'insufficient_data' = 'stable';
  if (delta > 3) trend = 'improving';
  else if (delta < -3) trend = 'declining';

  return {
    snapshotCount: history.length,
    scoreDelta: delta,
    scoreDeltaRecent: deltaRecent,
    trend,
    averageScore: avg,
    minScore: min,
    maxScore: max,
    volatility,
    projectedScore: Math.min(100, latest + (trend === 'improving' ? 2 : 0)),
  };
}

// ── Build audit checklist from real dimensions ─────────────────────────
function buildAuditChecklist(dimensions: PostureDimension[]) {
  const checklist: Array<{
    id: string;
    category: string;
    item: string;
    status: 'passed' | 'failed' | 'not_applicable' | 'pending';
    notes?: string;
  }> = [];

  for (const dim of dimensions) {
    for (const ctrl of dim.controls) {
      checklist.push({
        id: ctrl.id,
        category: dim.label,
        item: ctrl.name,
        status: ctrl.effectivenessScore >= 70 ? 'passed' : ctrl.effectivenessScore >= 40 ? 'pending' : 'failed',
        notes: ctrl.automated ? 'Automated control' : 'Manual control',
      });
    }
  }

  return checklist;
}

// ── Build full compliance report from real snapshots ───────────────────
function buildComplianceReport(snapshots: PostureSnapshot[]) {
  if (snapshots.length === 0) {
    return null;
  }

  const latest = snapshots[snapshots.length - 1]!;
  const posture = latest.posture;

  return {
    metadata: {
      reportId: `AUDIT-${Date.now()}-${latest.id.slice(-8)}`,
      generatedAt: new Date().toISOString(),
      version: 1,
    },
    posture,
    postureHistory: snapshots,
    isoCompliance: buildIsoCompliance(posture.dimensions),
    nistRmfAlignment: buildNistAlignment(posture.dimensions),
    trendAnalysis: buildTrendAnalysis(snapshots),
    auditChecklist: buildAuditChecklist(posture.dimensions),
    // Red team data is not persisted in posture-snapshots.json;
    // omit it so the frontend renders the section conditionally
  };
}

export function createSecurityPostureRouter(): Router {
  const router = Router();

  // ── GET /api/security/posture — full compliance report ──────────────
  router.get('/api/security/posture', (_req: Request, res: Response) => {
    try {
      const snapshots = readSnapshots();
      if (snapshots.length === 0) {
        return res.status(404).json({
          error: 'No posture snapshots found. Run a security posture assessment first.',
          snapshots: [],
        });
      }

      const report = buildComplianceReport(snapshots);
      if (!report) {
        return res.status(500).json({ error: 'Failed to build compliance report' });
      }

      res.json(report);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── GET /api/security/posture/history — snapshot history ────────────
  router.get('/api/security/posture/history', (req: Request, res: Response) => {
    try {
      const snapshots = readSnapshots();
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
      const history = snapshots.slice(-limit);
      res.json({ snapshots: history, total: snapshots.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // ── GET /api/security/posture/:id — specific snapshot ───────────────
  router.get('/api/security/posture/:id', (req: Request, res: Response) => {
    try {
      const snapshots = readSnapshots();
      const snapshot = snapshots.find((s) => s.id === req.params.id);
      if (!snapshot) {
        return res.status(404).json({ error: 'Snapshot not found' });
      }
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
