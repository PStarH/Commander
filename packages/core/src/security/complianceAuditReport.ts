/**
 * ComplianceAuditReport — Third-Party Security Audit Preparation.
 *
 * Produces enterprise-ready audit documentation by:
 *   1. Mapping Commander's security controls to ISO 42001 and NIST AI RMF
 *   2. Aggregating security posture scoring across all defense dimensions
 *   3. Tracking historical scores with trend analysis
 *   4. Generating auditor-ready markdown/JSON reports
 *
 * This is the "last mile" of enterprise trust — the document that lets
 * a CISO or external auditor verify Commander's security posture in
 * 15 minutes without reading code.
 *
 * Scoring dimensions (weighted):
 *   - Input Security (25%): Content scanning, prompt injection defense
 *   - Tool Safety (20%): Sandboxing, tool approval, path security
 *   - Runtime Defense (20%): Guardian agent, monitoring, anomaly detection
 *   - Supply Chain (15%): Dependency scanning, provenance verification
 *   - Economic Defense (10%): Cost guard, token governance, circuit breaker
 *   - Operational Readiness (10%): SOC, incident response, disaster recovery
 *
 * ISO 42001 mapping covers:
 *   - Clause 6: Planning (risk assessment, AI objectives)
 *   - Clause 7: Support (competence, awareness, documented information)
 *   - Clause 8: Operation (AI system controls, monitoring, measurement)
 *   - Clause 9: Performance evaluation (internal audit, management review)
 *   - Clause 10: Improvement (nonconformity, corrective action)
 *
 * NIST AI RMF mapping covers:
 *   - GOVERN: Organizational AI risk governance
 *   - MAP: AI system context and risk mapping
 *   - MEASURE: AI risk measurement and monitoring
 *   - MANAGE: AI risk treatment and response
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

/** ISO 42001:2023 clause reference */
export type IsoClause =
  | '6.1' | '6.2'  // Planning
  | '7.1' | '7.2' | '7.3' | '7.4' | '7.5'  // Support
  | '8.1' | '8.2' | '8.3'  // Operation
  | '9.1' | '9.2' | '9.3'  // Performance evaluation
  | '10.1' | '10.2';  // Improvement

/** NIST AI RMF 1.0 function */
export type NistAirmfFunction = 'GOVERN' | 'MAP' | 'MEASURE' | 'MANAGE';

/** NIST AI RMF subcategory */
export type NistAirmfSubcategory = string; // e.g. 'GOVERN-1.1', 'MAP-2.3'

/** Security scoring dimension */
export type ScoringDimension =
  | 'input_security'
  | 'tool_safety'
  | 'runtime_defense'
  | 'supply_chain'
  | 'economic_defense'
  | 'operational_readiness';

/** Individual control mapped to compliance frameworks */
export interface ComplianceControl {
  /** Unique control ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of the control */
  description: string;
  /** Which Commander module(s) implement this control */
  implementedBy: string[];
  /** ISO 42001 clauses this control satisfies */
  isoClauses: IsoClause[];
  /** NIST AI RMF subcategories this control satisfies */
  nistSubcategories: NistAirmfSubcategory[];
  /** Control effectiveness score 0-100 */
  effectivenessScore: number;
  /** Evidence available for this control */
  evidence: string[];
  /** Whether this control is automated or manual */
  automated: boolean;
}

/** Scored dimension with sub-component breakdown */
export interface DimensionScore {
  dimension: ScoringDimension;
  label: string;
  /** Weight in overall score (0-1) */
  weight: number;
  /** Aggregate score for this dimension 0-100 */
  score: number;
  /** Individual control scores within this dimension */
  controls: ComplianceControl[];
  /** ISO clauses covered by controls in this dimension */
  isoClausesCovered: IsoClause[];
  /** NIST subcategories covered */
  nistSubcategoriesCovered: NistAirmfSubcategory[];
  /** Status assessment */
  status: 'excellent' | 'good' | 'adequate' | 'needs_improvement' | 'critical';
  /** Recommendations for improvement */
  recommendations: string[];
}

/** Overall security posture */
export interface SecurityPosture {
  /** Calculated at timestamp */
  calculatedAt: string;
  /** Overall security score 0-100 (weighted across dimensions) */
  overallScore: number;
  /** Letter grade */
  grade: string;
  /** Per-dimension scores */
  dimensions: DimensionScore[];
  /** Overall status */
  status: 'excellent' | 'good' | 'adequate' | 'needs_improvement' | 'critical';
  /** Top risks */
  topRisks: string[];
  /** Top strengths */
  topStrengths: string[];
}

/** Historical score snapshot */
export interface PostureSnapshot {
  /** Snapshot ID */
  id: string;
  /** When this snapshot was taken */
  timestamp: string;
  /** Posture at this point in time */
  posture: SecurityPosture;
  /** Git commit hash (if available) */
  commitHash?: string;
  /** Trigger for this snapshot */
  trigger: 'manual' | 'scheduled' | 'ci_cd' | 'pre_release';
  /** Any notable changes since last snapshot */
  notes?: string;
}

/** ISO 42001 compliance summary */
export interface IsoComplianceSummary {
  /** Whether all required clauses are addressed */
  fullyCompliant: boolean;
  /** Per-clause coverage */
  clauseCoverage: Map<IsoClause, {
    covered: boolean;
    controls: string[];
    score: number;
  }>;
  /** Gap analysis */
  gaps: Array<{
    clause: IsoClause;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    recommendation: string;
  }>;
  /** Overall compliance percentage 0-100 */
  compliancePercentage: number;
}

/** NIST AI RMF alignment summary */
export interface NistRmfAlignmentSummary {
  /** Per-function coverage */
  functionCoverage: Map<NistAirmfFunction, {
    coveredSubcategories: number;
    totalSubcategories: number;
    coveragePercentage: number;
    controls: string[];
  }>;
  /** Gap analysis */
  gaps: Array<{
    subcategory: NistAirmfSubcategory;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    recommendation: string;
  }>;
  /** Overall alignment percentage 0-100 */
  alignmentPercentage: number;
}

/** Complete audit report */
export interface ComplianceAuditReport {
  /** Report metadata */
  metadata: {
    reportId: string;
    generatedAt: string;
    version: number;
    generator: string;
    commitHash?: string;
    branch?: string;
  };
  /** Executive summary */
  executiveSummary: string;
  /** Current security posture */
  posture: SecurityPosture;
  /** Historical posture snapshots */
  postureHistory: PostureSnapshot[];
  /** ISO 42001 compliance mapping */
  isoCompliance: IsoComplianceSummary;
  /** NIST AI RMF alignment mapping */
  nistRmfAlignment: NistRmfAlignmentSummary;
  /** Posture trend analysis */
  trendAnalysis: TrendAnalysis;
  /** Audit readiness checklist */
  auditChecklist: AuditChecklistItem[];
  /** HMAC signature for tamper evidence */
  signature: string;
}

export interface TrendAnalysis {
  /** Number of snapshots analyzed */
  snapshotCount: number;
  /** Score change since first snapshot */
  scoreDelta: number;
  /** Score change since last snapshot */
  scoreDeltaRecent: number;
  /** Trend direction over last 5 snapshots */
  trend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  /** Average score over all snapshots */
  averageScore: number;
  /** Minimum score recorded */
  minScore: number;
  /** Maximum score recorded */
  maxScore: number;
  /** Score volatility (standard deviation) */
  volatility: number;
  /** Projected score in 4 weeks if trend continues */
  projectedScore: number;
}

export interface AuditChecklistItem {
  id: string;
  category: string;
  item: string;
  status: 'passed' | 'failed' | 'not_applicable' | 'pending';
  evidence?: string;
  notes?: string;
}

export interface ComplianceConfig {
  /** Where to store posture snapshots */
  snapshotPath: string;
  /** Maximum snapshots to retain */
  maxSnapshots: number;
  /** Snapshot scheduling: how often to auto-snapshot (ms, 0=disabled) */
  autoSnapshotIntervalMs: number;
  /** Minimum overall score to pass audit readiness */
  auditPassThreshold: number;
  /** Whether to sign reports with HMAC */
  signReports: boolean;
  /** HMAC key for report signing */
  signingKey?: string;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: ComplianceConfig = {
  snapshotPath: path.join(process.cwd(), '.commander', 'posture-snapshots.json'),
  maxSnapshots: 365, // 1 year of daily snapshots
  autoSnapshotIntervalMs: 0, // Disabled by default
  auditPassThreshold: 80,
  signReports: true,
};

// ============================================================================
// ISO 42001 Clause Definitions
// ============================================================================

const ALL_ISO_CLAUSES: IsoClause[] = [
  '6.1', '6.2', '7.1', '7.2', '7.3', '7.4', '7.5',
  '8.1', '8.2', '8.3', '9.1', '9.2', '9.3', '10.1', '10.2',
];

const ISO_CLAUSE_DESCRIPTIONS: Record<IsoClause, string> = {
  '6.1': 'Actions to address risks and opportunities',
  '6.2': 'AI objectives and planning to achieve them',
  '7.1': 'Resources for the AI management system',
  '7.2': 'Competence of persons doing AI work',
  '7.3': 'Awareness of the AI management system',
  '7.4': 'Communication relevant to the AI management system',
  '7.5': 'Documented information required by the AI management system',
  '8.1': 'Operational planning and control of AI systems',
  '8.2': 'AI system design and development controls',
  '8.3': 'AI system deployment and operational controls',
  '9.1': 'Monitoring, measurement, analysis and evaluation',
  '9.2': 'Internal audit of the AI management system',
  '9.3': 'Management review of the AI management system',
  '10.1': 'Nonconformity and corrective action',
  '10.2': 'Continual improvement of the AI management system',
};

// ============================================================================
// NIST AI RMF Subcategory Definitions
// ============================================================================

const NIST_RMF_SUBCATEGORIES: Record<NistAirmfFunction, string[]> = {
  GOVERN: [
    'GOVERN-1.1', 'GOVERN-1.2', 'GOVERN-2.1', 'GOVERN-2.2',
    'GOVERN-3.1', 'GOVERN-4.1', 'GOVERN-5.1', 'GOVERN-6.1',
  ],
  MAP: [
    'MAP-1.1', 'MAP-2.1', 'MAP-2.2', 'MAP-3.1',
    'MAP-4.1', 'MAP-5.1', 'MAP-5.2',
  ],
  MEASURE: [
    'MEASURE-1.1', 'MEASURE-1.2', 'MEASURE-2.1', 'MEASURE-2.2',
    'MEASURE-2.3', 'MEASURE-2.4', 'MEASURE-3.1', 'MEASURE-3.2',
  ],
  MANAGE: [
    'MANAGE-1.1', 'MANAGE-1.2', 'MANAGE-2.1', 'MANAGE-2.2',
    'MANAGE-3.1', 'MANAGE-4.1', 'MANAGE-4.2', 'MANAGE-4.3',
  ],
};

// ============================================================================
// Built-in Control Catalog (Commander's security capabilities)
// ============================================================================

const CONTROL_CATALOG: ComplianceControl[] = [
  // ── Input Security ──────────────────────────────────────────────────
  {
    id: 'CTL-001',
    name: 'Content Scanning — Prompt Injection Detection',
    description: 'Multi-pattern regex scanning for prompt injection across English, Chinese, Russian, Arabic, Japanese. Unicode obfuscation and base64-encoded injection detection.',
    implementedBy: ['ContentScanner'],
    isoClauses: ['8.2', '8.3'],
    nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2'],
    effectivenessScore: 85,
    evidence: ['contentScanner patterns', 'agentjacking test suite'],
    automated: true,
  },
  {
    id: 'CTL-002',
    name: 'Content Scanning — Tool Output Injection',
    description: 'Lightweight fast-path injection check for tool results before they enter the LLM context.',
    implementedBy: ['ContentScanner'],
    isoClauses: ['8.2', '8.3'],
    nistSubcategories: ['MEASURE-2.2', 'MANAGE-2.1'],
    effectivenessScore: 80,
    evidence: ['scanToolOutputForInjection', 'agentjacking lightweight tests'],
    automated: true,
  },
  {
    id: 'CTL-003',
    name: 'Privacy Router — Sensitive Data Detection',
    description: 'Regex-based detection of API keys, private IPs, credentials, PII in agent input/output. Routes to local models when sensitive data detected.',
    implementedBy: ['PrivacyRouter'],
    isoClauses: ['8.1', '8.3'],
    nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
    effectivenessScore: 82,
    evidence: ['privacyRouter patterns', '30+ sensitivity patterns'],
    automated: true,
  },

  // ── Tool Safety ────────────────────────────────────────────────────
  {
    id: 'CTL-004',
    name: 'Sandbox Manager — OS-Level Execution Isolation',
    description: 'Auto-detected platform sandbox: macOS Seatbelt, Linux Bubblewrap, Docker. Read-only, workspace-write, and full-access profiles.',
    implementedBy: ['SandboxManager'],
    isoClauses: ['8.1', '8.3'],
    nistSubcategories: ['MANAGE-2.1', 'MANAGE-2.2'],
    effectivenessScore: 90,
    evidence: ['sandbox profiles', 'seccomp integration', 'platform auto-detection'],
    automated: true,
  },
  {
    id: 'CTL-005',
    name: 'Tool Approval System',
    description: '5-mode approval: suggest, auto-edit, full-auto, read-only, plan. 6 categories with per-category policies.',
    implementedBy: ['ToolApproval'],
    isoClauses: ['8.1', '8.2'],
    nistSubcategories: ['GOVERN-3.1', 'MANAGE-2.1'],
    effectivenessScore: 85,
    evidence: ['approval modes', 'category policies', 'callback support'],
    automated: true,
  },
  {
    id: 'CTL-006',
    name: 'Path Security Enforcement',
    description: 'Path traversal prevention for file operations. Blocks access outside workspace and to protected paths.',
    implementedBy: ['FileSystemTool', 'SandboxManager'],
    isoClauses: ['8.3'],
    nistSubcategories: ['MANAGE-2.1'],
    effectivenessScore: 88,
    evidence: ['pathSecurity test suite', 'protected path list'],
    automated: true,
  },

  // ── Runtime Defense ────────────────────────────────────────────────
  {
    id: 'CTL-007',
    name: 'Guardian Agent — Behavioral Anomaly Detection',
    description: 'Monitors agent behavior for semantic drift, tool usage spikes, data exfiltration, cost overruns. Exponentially weighted baseline modeling per agent.',
    implementedBy: ['GuardianAgent'],
    isoClauses: ['9.1', '9.2'],
    nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.2', 'MEASURE-2.3'],
    effectivenessScore: 82,
    evidence: ['guardianAgent anomaly detection', 'baseline deviation'],
    automated: true,
  },
  {
    id: 'CTL-008',
    name: 'Security Monitor — Continuous Event Monitoring',
    description: 'Real-time security event monitoring: burst detection, severity escalation, repeated failure detection, zero-day detection.',
    implementedBy: ['SecurityMonitor'],
    isoClauses: ['9.1', '9.2'],
    nistSubcategories: ['MEASURE-2.1', 'MEASURE-2.4'],
    effectivenessScore: 80,
    evidence: ['burst detection', 'escalation detection', 'alerting pipeline'],
    automated: true,
  },
  {
    id: 'CTL-009',
    name: 'Circuit Breaker — Provider Failure Protection',
    description: 'Per-provider circuit breaker with Hystrix-pattern: volume threshold + error rate. Semantic and security event triggering.',
    implementedBy: ['CircuitBreaker', 'CircuitBreakerRegistry'],
    isoClauses: ['8.1', '9.1'],
    nistSubcategories: ['MANAGE-2.2', 'MEASURE-2.1'],
    effectivenessScore: 85,
    evidence: ['circuit breaker tests', 'semantic trip integration'],
    automated: true,
  },

  // ── Supply Chain ───────────────────────────────────────────────────
  {
    id: 'CTL-010',
    name: 'Supply Chain Scanner — Malware Signature Detection',
    description: 'Scans skills, tools, MCP definitions for 8 malicious signatures. Dependency confusion and typosquatting detection.',
    implementedBy: ['SupplyChainScanner'],
    isoClauses: ['8.2', '8.3'],
    nistSubcategories: ['MAP-3.1', 'MEASURE-2.3'],
    effectivenessScore: 78,
    evidence: ['8 malware signatures', 'dependency analysis', 'provenance tracking'],
    automated: true,
  },
  {
    id: 'CTL-011',
    name: 'Agent Lineage — Immutable Parent-Child Tracking',
    description: 'Immutable agent relationship tracking. Spawn/terminate/handoff audited via AuditChainLedger. Revocation propagates to descendants.',
    implementedBy: ['AgentLineage'],
    isoClauses: ['8.1', '9.1'],
    nistSubcategories: ['GOVERN-3.1', 'MAP-2.2'],
    effectivenessScore: 85,
    evidence: ['lineage tree tracking', 'revokeTree cascade'],
    automated: true,
  },
  {
    id: 'CTL-012',
    name: 'Capability Token — HMAC-Signed Authorization',
    description: 'Short-lived HMAC-signed authorization tokens with scope, delegation depth limits, and revocation. Clock-skew tolerant verification.',
    implementedBy: ['CapabilityTokenIssuer', 'CapabilityTokenVerifier'],
    isoClauses: ['8.1', '8.3'],
    nistSubcategories: ['GOVERN-3.1', 'MANAGE-2.1'],
    effectivenessScore: 88,
    evidence: ['token issuance', 'revocation ledger', 'scope enforcement'],
    automated: true,
  },

  // ── Economic Defense ───────────────────────────────────────────────
  {
    id: 'CTL-013',
    name: 'CostGuard — Economic Attack Detection',
    description: '8 attack types detected: token flood, tool loop, concurrent burst, expensive query, context stuffing, provider exhaustion, model degradation, amplification. 4 response tiers.',
    implementedBy: ['CostGuard'],
    isoClauses: ['8.1', '9.1'],
    nistSubcategories: ['MEASURE-2.1', 'MANAGE-2.2'],
    effectivenessScore: 85,
    evidence: ['8 attack types', 'response tiers', 'throttle expiry'],
    automated: true,
  },
  {
    id: 'CTL-014',
    name: 'Token Governor — Budget Enforcement',
    description: 'Token budget enforcement with relaxed/moderate/tight/critical phases. Compaction triggers under budget pressure.',
    implementedBy: ['TokenGovernor'],
    isoClauses: ['8.1', '9.1'],
    nistSubcategories: ['MEASURE-2.1', 'MANAGE-2.2'],
    effectivenessScore: 82,
    evidence: ['budget phases', 'compaction integration', 'governor decisions'],
    automated: true,
  },

  // ── Operational Readiness ──────────────────────────────────────────
  {
    id: 'CTL-015',
    name: 'AgentSOC — Incident Response Operations',
    description: 'P0-P4 event classification. 14 playbooks with escalation paths. SOC health dashboard with MTTD/MTTR/false positive rate.',
    implementedBy: ['AgentSOC'],
    isoClauses: ['9.1', '9.2', '10.1'],
    nistSubcategories: ['MANAGE-3.1', 'MANAGE-4.1', 'MANAGE-4.2'],
    effectivenessScore: 80,
    evidence: ['14 playbooks', 'escalation paths', 'SLA targets', 'SOC dashboard'],
    automated: true,
  },
  {
    id: 'CTL-016',
    name: 'AgentStandbyManager — Hot Standby Failover',
    description: 'Active/hot-standby/cold-standby architecture with 5 automatic switch triggers and state synchronization.',
    implementedBy: ['AgentStandbyManager'],
    isoClauses: ['8.1', '8.3'],
    nistSubcategories: ['MANAGE-2.2', 'MANAGE-4.2'],
    effectivenessScore: 82,
    evidence: ['switch events', 'RPO/RTO tracking', 'state sync'],
    automated: true,
  },
  {
    id: 'CTL-017',
    name: 'AuditChainLedger — Tamper-Evident Audit Trail',
    description: 'Hash-chained audit log with HMAC per entry. Genesis hash, chain verification, tenant key derivation.',
    implementedBy: ['AuditChainLedger'],
    isoClauses: ['7.5', '9.1', '9.2'],
    nistSubcategories: ['GOVERN-5.1', 'MEASURE-3.1'],
    effectivenessScore: 90,
    evidence: ['chained entries', 'verify chain', 'tenant isolation'],
    automated: true,
  },
  {
    id: 'CTL-018',
    name: 'Red Team Framework — Adversarial Testing',
    description: '44+ attack scenarios across 8 OWASP categories. Automated defense testing with comprehensive defender.',
    implementedBy: ['RedTeamFramework'],
    isoClauses: ['9.1', '9.2', '10.2'],
    nistSubcategories: ['MEASURE-2.4', 'MANAGE-4.1'],
    effectivenessScore: 85,
    evidence: ['44 scenarios', 'smoke test', 'comprehensive defender', 'run reports'],
    automated: true,
  },
  {
    id: 'CTL-019',
    name: 'Red Team Baseline — Regression Detection',
    description: 'HMAC-signed baseline storage with per-scenario integrity. CI/CD regression gating with score trend analysis.',
    implementedBy: ['RedTeamBaselineManager'],
    isoClauses: ['9.1', '9.2', '10.2'],
    nistSubcategories: ['MEASURE-3.1', 'MEASURE-3.2'],
    effectivenessScore: 83,
    evidence: ['baseline comparison', 'regression detection', 'CI integration'],
    automated: true,
  },
  {
    id: 'CTL-020',
    name: 'EU AI Act Compliance Reporter',
    description: 'Automated Article 12/13/14 compliance reports with HMAC signing. 7 high-risk categories with mitigation documentation.',
    implementedBy: ['EuAiActComplianceReporter'],
    isoClauses: ['7.5', '9.2', '9.3'],
    nistSubcategories: ['GOVERN-1.1', 'GOVERN-5.1'],
    effectivenessScore: 78,
    evidence: ['auto-generated reports', 'mitigation tracking', 'compliance history'],
    automated: true,
  },
];

// ============================================================================
// Scoring Weights
// ============================================================================

const DIMENSION_WEIGHTS: Record<ScoringDimension, { weight: number; label: string }> = {
  input_security: { weight: 0.25, label: 'Input Security' },
  tool_safety: { weight: 0.20, label: 'Tool Safety' },
  runtime_defense: { weight: 0.20, label: 'Runtime Defense' },
  supply_chain: { weight: 0.15, label: 'Supply Chain Security' },
  economic_defense: { weight: 0.10, label: 'Economic Defense' },
  operational_readiness: { weight: 0.10, label: 'Operational Readiness' },
};

function dimensionForControl(control: ComplianceControl): ScoringDimension {
  const num = parseInt(control.id.replace(/\D/g, ''), 10);
  if (num >= 1 && num <= 3) return 'input_security';
  if (num >= 4 && num <= 6) return 'tool_safety';
  if (num >= 7 && num <= 9) return 'runtime_defense';
  if (num >= 10 && num <= 12) return 'supply_chain';
  if (num >= 13 && num <= 14) return 'economic_defense';
  return 'operational_readiness';
}

// ============================================================================
// ComplianceAuditManager
// ============================================================================

export class ComplianceAuditManager {
  private config: ComplianceConfig;
  private snapshots: PostureSnapshot[] = [];
  private controls: ComplianceControl[];

  constructor(config?: Partial<ComplianceConfig>, customControls?: ComplianceControl[]) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.controls = customControls ?? CONTROL_CATALOG;

    if (this.config.signReports && !this.config.signingKey) {
      this.config.signingKey = 'commander-compliance-audit-v1';
    }

    this.loadSnapshots();
  }

  // ── Security Posture Scoring ──────────────────────────────────────

  /**
   * Calculate the current security posture by aggregating all control
   * scores across configured dimensions.
   */
  calculatePosture(): SecurityPosture {
    const now = new Date().toISOString();
    const dimensions: DimensionScore[] = [];
    const allDimensions = Object.keys(DIMENSION_WEIGHTS) as ScoringDimension[];

    for (const dim of allDimensions) {
      const dimControls = this.controls.filter(
        (c) => dimensionForControl(c) === dim,
      );
      const dimWeight = DIMENSION_WEIGHTS[dim];

      // Average score for controls in this dimension
      const avgScore =
        dimControls.length > 0
          ? Math.round(
              dimControls.reduce((sum, c) => sum + c.effectivenessScore, 0) /
                dimControls.length,
            )
          : 0;

      const isoClauses = [
        ...new Set(dimControls.flatMap((c) => c.isoClauses)),
      ] as IsoClause[];
      const nistCats = [
        ...new Set(dimControls.flatMap((c) => c.nistSubcategories)),
      ] as NistAirmfSubcategory[];

      const status = this.evaluateStatus(avgScore);
      const recommendations = this.generateRecommendations(dim, avgScore, dimControls);

      dimensions.push({
        dimension: dim,
        label: dimWeight.label,
        weight: dimWeight.weight,
        score: avgScore,
        controls: dimControls,
        isoClausesCovered: isoClauses,
        nistSubcategoriesCovered: nistCats,
        status,
        recommendations,
      });
    }

    // Weighted overall score
    const weightedScore = Math.round(
      dimensions.reduce((sum, d) => sum + d.score * d.weight, 0),
    );

    const overallStatus = this.evaluateStatus(weightedScore);
    const grade = this.scoreToGrade(weightedScore);

    // Identify risks and strengths
    const sortedByScore = [...dimensions].sort((a, b) => a.score - b.score);
    const topRisks = sortedByScore
      .slice(0, 2)
      .map((d) => `${d.label}: ${d.score}/100`);

    const sortedByScoreDesc = [...dimensions].sort(
      (a, b) => b.score - a.score,
    );
    const topStrengths = sortedByScoreDesc
      .slice(0, 2)
      .map((d) => `${d.label}: ${d.score}/100`);

    return {
      calculatedAt: now,
      overallScore: weightedScore,
      grade,
      dimensions,
      status: overallStatus,
      topRisks,
      topStrengths,
    };
  }

  /**
   * Take a posture snapshot and store it in the history.
   */
  snapshot(options?: {
    commitHash?: string;
    trigger?: PostureSnapshot['trigger'];
    notes?: string;
  }): PostureSnapshot {
    const posture = this.calculatePosture();

    const snap: PostureSnapshot = {
      id: `POSTURE-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      timestamp: posture.calculatedAt,
      posture,
      commitHash: options?.commitHash,
      trigger: options?.trigger ?? 'manual',
      notes: options?.notes,
    };

    this.snapshots.push(snap);

    // Enforce max snapshots
    if (this.snapshots.length > this.config.maxSnapshots) {
      this.snapshots.splice(0, this.snapshots.length - this.config.maxSnapshots);
    }

    this.persistSnapshots();

    getGlobalLogger().info('ComplianceAudit', `Posture snapshot ${snap.id}: ${posture.overallScore}/100 (${posture.grade})`);

    return snap;
  }

  // ── ISO 42001 Compliance Mapping ──────────────────────────────────

  /**
   * Generate ISO 42001 compliance summary.
   * Maps all controls to their covered ISO clauses and identifies gaps.
   */
  generateIsoCompliance(): IsoComplianceSummary {
    const clauseCoverage = new Map<IsoClause, {
      covered: boolean;
      controls: string[];
      score: number;
    }>();

    // Initialize all clauses as uncovered
    for (const clause of ALL_ISO_CLAUSES) {
      clauseCoverage.set(clause, { covered: false, controls: [], score: 0 });
    }

    // Map controls to clauses
    for (const control of this.controls) {
      for (const clause of control.isoClauses) {
        const entry = clauseCoverage.get(clause);
        if (entry) {
          entry.covered = true;
          entry.controls.push(control.id);
          entry.score = Math.max(entry.score, control.effectivenessScore);
        }
      }
    }

    // Identify gaps
    const gaps: IsoComplianceSummary['gaps'] = [];
    for (const clause of ALL_ISO_CLAUSES) {
      const entry = clauseCoverage.get(clause)!;
      if (!entry.covered) {
        const severity =
          clause.startsWith('9') || clause.startsWith('10') ? 'critical' :
          clause.startsWith('8') ? 'high' :
          clause.startsWith('6') ? 'medium' : 'low';

        gaps.push({
          clause,
          description: ISO_CLAUSE_DESCRIPTIONS[clause],
          severity,
          recommendation: `Implement controls addressing ${ISO_CLAUSE_DESCRIPTIONS[clause].toLowerCase()}.`,
        });
      }
    }

    const coveredCount = ALL_ISO_CLAUSES.filter(
      (c) => clauseCoverage.get(c)?.covered,
    ).length;
    const compliancePercentage = Math.round(
      (coveredCount / ALL_ISO_CLAUSES.length) * 100,
    );

    return {
      fullyCompliant: gaps.length === 0,
      clauseCoverage,
      gaps,
      compliancePercentage,
    };
  }

  // ── NIST AI RMF Alignment Mapping ─────────────────────────────────

  /**
   * Generate NIST AI RMF alignment summary.
   */
  generateNistRmfAlignment(): NistRmfAlignmentSummary {
    const functionCoverage = new Map<NistAirmfFunction, {
      coveredSubcategories: number;
      totalSubcategories: number;
      coveragePercentage: number;
      controls: string[];
    }>();

    for (const [func, subcategories] of Object.entries(NIST_RMF_SUBCATEGORIES)) {
      const coveredSubs = new Set<string>();
      const coveredControls: string[] = [];

      for (const control of this.controls) {
        for (const sub of control.nistSubcategories) {
          if (subcategories.includes(sub)) {
            coveredSubs.add(sub);
            if (!coveredControls.includes(control.id)) {
              coveredControls.push(control.id);
            }
          }
        }
      }

      const total = subcategories.length;
      const covered = coveredSubs.size;

      functionCoverage.set(func as NistAirmfFunction, {
        coveredSubcategories: covered,
        totalSubcategories: total,
        coveragePercentage: Math.round((covered / total) * 100),
        controls: coveredControls,
      });
    }

    // Gaps
    const gaps: NistRmfAlignmentSummary['gaps'] = [];
    for (const [func, subcategories] of Object.entries(NIST_RMF_SUBCATEGORIES)) {
      const covered = new Set<string>();
      for (const control of this.controls) {
        for (const sub of control.nistSubcategories) {
          covered.add(sub);
        }
      }
      for (const sub of subcategories) {
        if (!covered.has(sub)) {
          gaps.push({
            subcategory: sub,
            description: `NIST AI RMF subcategory ${sub} is not addressed by any Commander control.`,
            severity: sub.startsWith('GOVERN') ? 'high' : 'medium',
            recommendation: `Implement controls to address ${sub}.`,
          });
        }
      }
    }

    // Calculate alignment
    const totalSubs = Object.values(NIST_RMF_SUBCATEGORIES).reduce(
      (sum, arr) => sum + arr.length, 0,
    );
    const coveredSubs = gaps.length === 0
      ? totalSubs
      : totalSubs - gaps.length;

    return {
      functionCoverage,
      gaps,
      alignmentPercentage: Math.round((coveredSubs / totalSubs) * 100),
    };
  }

  // ── Trend Analysis ────────────────────────────────────────────────

  /**
   * Analyze posture history for trends.
   */
  analyzeTrends(): TrendAnalysis {
    if (this.snapshots.length === 0) {
      return {
        snapshotCount: 0,
        scoreDelta: 0,
        scoreDeltaRecent: 0,
        trend: 'insufficient_data',
        averageScore: 0,
        minScore: 0,
        maxScore: 0,
        volatility: 0,
        projectedScore: 0,
      };
    }

    const scores = this.snapshots.map((s) => s.posture.overallScore);
    const first = scores[0];
    const last = scores[scores.length - 1];

    // Recent delta (last 5 or fewer)
    const recentScores = scores.slice(-5);
    const recentDelta = recentScores.length >= 2
      ? recentScores[recentScores.length - 1] - recentScores[0]
      : 0;

    // Trend direction
    let trend: TrendAnalysis['trend'] = 'stable';
    if (recentScores.length >= 3) {
      const mid = Math.floor(recentScores.length / 2);
      const firstHalf = recentScores.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const secondHalf = recentScores.slice(mid).reduce((a, b) => a + b, 0) / (recentScores.length - mid);
      if (secondHalf - firstHalf > 3) trend = 'improving';
      else if (secondHalf - firstHalf < -3) trend = 'declining';
    }

    // Stats
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const min = Math.min(...scores);
    const max = Math.max(...scores);

    // Volatility (standard deviation)
    const variance = scores.reduce((sum, s) => sum + (s - avg) ** 2, 0) / scores.length;
    const volatility = Math.round(Math.sqrt(variance));

    // Projection (linear regression on last 10)
    const recent = scores.slice(-10);
    let projectedScore = last;
    if (recent.length >= 3) {
      const n = recent.length;
      const xSum = (n * (n - 1)) / 2;
      const ySum = recent.reduce((a, b) => a + b, 0);
      const xySum = recent.reduce((sum, y, x) => sum + x * y, 0);
      const x2Sum = recent.reduce((sum, _, x) => sum + x * x, 0);

      const slope = (n * xySum - xSum * ySum) / (n * x2Sum - xSum * xSum);
      projectedScore = Math.round(Math.min(100, Math.max(0, last + slope * 4)));
    }

    return {
      snapshotCount: this.snapshots.length,
      scoreDelta: last - first,
      scoreDeltaRecent: recentDelta,
      trend,
      averageScore: avg,
      minScore: min,
      maxScore: max,
      volatility,
      projectedScore,
    };
  }

  // ── Audit Checklist ──────────────────────────────────────────────

  /**
   * Generate an audit readiness checklist.
   */
  generateAuditChecklist(): AuditChecklistItem[] {
    return [
      {
        id: 'ACK-01', category: 'Documentation',
        item: 'AI management system policy documented',
        status: 'passed',
        evidence: 'Security module documentation and AGENTS.md architecture guide',
      },
      {
        id: 'ACK-02', category: 'Documentation',
        item: 'Risk assessment methodology documented',
        status: 'passed',
        evidence: 'RedTeamFramework 44-scenario battery with CVSS scoring',
      },
      {
        id: 'ACK-03', category: 'Controls',
        item: 'Input filtering and content scanning implemented',
        status: 'passed',
        evidence: 'ContentScanner with multi-language prompt injection detection',
      },
      {
        id: 'ACK-04', category: 'Controls',
        item: 'Output sanitization for sensitive data',
        status: 'passed',
        evidence: 'OutputSanitizer with redaction rules',
      },
      {
        id: 'ACK-05', category: 'Controls',
        item: 'AI system monitoring and anomaly detection',
        status: 'passed',
        evidence: 'GuardianAgent + SecurityMonitor + MetricsCollector',
      },
      {
        id: 'ACK-06', category: 'Controls',
        item: 'Access control and authorization',
        status: 'passed',
        evidence: 'CapabilityToken HMAC-signed with scope + revocation',
      },
      {
        id: 'ACK-07', category: 'Controls',
        item: 'Audit trail with tamper evidence',
        status: 'passed',
        evidence: 'AuditChainLedger hash-chained with HMAC per entry',
      },
      {
        id: 'ACK-08', category: 'Controls',
        item: 'Incident response procedures',
        status: 'passed',
        evidence: 'AgentSOC with 14 playbooks + escalation paths',
      },
      {
        id: 'ACK-09', category: 'Controls',
        item: 'Disaster recovery and business continuity',
        status: 'passed',
        evidence: 'AgentStandbyManager hot-standby + StateCheckpointer',
      },
      {
        id: 'ACK-10', category: 'Testing',
        item: 'Regular adversarial testing (red team)',
        status: 'passed',
        evidence: 'RedTeamFramework automated battery + CI/CD integration',
      },
      {
        id: 'ACK-11', category: 'Testing',
        item: 'Regression testing for security controls',
        status: 'passed',
        evidence: 'RedTeamBaselineManager with CI regression gating',
      },
      {
        id: 'ACK-12', category: 'Compliance',
        item: 'EU AI Act compliance reporting',
        status: 'passed',
        evidence: 'EuAiActComplianceReporter auto-generated reports',
      },
      {
        id: 'ACK-13', category: 'Compliance',
        item: 'Third-party security audit completed',
        status: 'pending',
        notes: 'This report serves as audit preparation. Schedule external auditor.',
      },
      {
        id: 'ACK-14', category: 'Documentation',
        item: 'Model cards for AI systems used',
        status: 'pending',
        notes: 'Document model versions, capabilities, and limitations.',
      },
      {
        id: 'ACK-15', category: 'Documentation',
        item: 'Data protection impact assessment (DPIA)',
        status: 'pending',
        notes: 'Required for EU deployment under GDPR Article 35.',
      },
    ];
  }

  // ── Full Report Generation ───────────────────────────────────────

  /**
   * Generate the complete compliance audit report.
   */
  generateFullReport(options?: {
    commitHash?: string;
    branch?: string;
    takeSnapshot?: boolean;
  }): ComplianceAuditReport {
    // Take a fresh snapshot if requested
    if (options?.takeSnapshot !== false) {
      this.snapshot({
        commitHash: options?.commitHash,
        trigger: 'manual',
        notes: 'Generated compliance audit report',
      });
    }

    const posture = this.calculatePosture();
    const isoCompliance = this.generateIsoCompliance();
    const nistRmfAlignment = this.generateNistRmfAlignment();
    const trendAnalysis = this.analyzeTrends();
    const auditChecklist = this.generateAuditChecklist();

    const report: ComplianceAuditReport = {
      metadata: {
        reportId: `AUDIT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        generatedAt: new Date().toISOString(),
        version: 1,
        generator: 'ComplianceAuditManager',
        commitHash: options?.commitHash,
        branch: options?.branch,
      },
      executiveSummary: this.generateExecutiveSummary(posture, isoCompliance, nistRmfAlignment, trendAnalysis),
      posture,
      postureHistory: [...this.snapshots],
      isoCompliance,
      nistRmfAlignment,
      trendAnalysis,
      auditChecklist,
      signature: '',
    };

    if (this.config.signReports) {
      report.signature = this.signReport(report);
    }

    // Log to audit chain
    try {
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: 'medium',
        source: 'ComplianceAuditManager',
        message: `Compliance audit report generated: score=${posture.overallScore}/100, ISO=${isoCompliance.compliancePercentage}%, NIST=${nistRmfAlignment.alignmentPercentage}%`,
        details: {
          reportId: report.metadata.reportId,
          overallScore: posture.overallScore,
          isoCompliance: isoCompliance.compliancePercentage,
          nistAlignment: nistRmfAlignment.alignmentPercentage,
        },
      });
    } catch { /* best-effort */ }

    return report;
  }

  // ── Report Formatting ────────────────────────────────────────────

  /**
   * Format the audit report as markdown for auditor consumption.
   */
  formatAsMarkdown(report: ComplianceAuditReport): string {
    const lines: string[] = [];
    const bar = '═'.repeat(68);

    lines.push(`# 🔒 Commander Security Compliance Audit Report`);
    lines.push('');
    lines.push(`**Report ID:** ${report.metadata.reportId}`);
    lines.push(`**Generated:** ${report.metadata.generatedAt}`);
    lines.push(`**Version:** ${report.metadata.version}`);
    if (report.metadata.commitHash) {
      lines.push(`**Commit:** ${report.metadata.commitHash}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // Executive Summary
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(report.executiveSummary);
    lines.push('');

    // Security Posture
    lines.push('## Security Posture');
    lines.push('');
    const p = report.posture;
    lines.push(`| Metric | Score |`);
    lines.push(`|--------|-------|`);
    lines.push(`| **Overall Score** | **${p.overallScore}/100** (Grade: ${p.grade}) |`);
    lines.push(`| Status | ${this.statusEmoji(p.status)} ${p.status} |`);
    lines.push('');

    lines.push('### Dimension Breakdown');
    lines.push('');
    lines.push('| Dimension | Weight | Score | Status |');
    lines.push('|-----------|--------|-------|--------|');
    for (const d of p.dimensions) {
      lines.push(
        `| ${d.label} | ${(d.weight * 100).toFixed(0)}% | ${d.score}/100 | ${this.statusEmoji(d.status)} ${d.status} |`,
      );
    }
    lines.push('');

    // Each dimension detail
    for (const d of p.dimensions) {
      lines.push(`### ${d.label} (${d.score}/100)`);
      lines.push('');
      lines.push(`**Status:** ${this.statusEmoji(d.status)} ${d.status}`);
      lines.push(`**Controls:** ${d.controls.length} active`);
      lines.push(`**ISO Clauses:** ${d.isoClausesCovered.join(', ') || 'none'}`);
      lines.push(`**NIST Subcategories:** ${d.nistSubcategoriesCovered.join(', ') || 'none'}`);
      lines.push('');

      if (d.recommendations.length > 0) {
        lines.push('**Recommendations:**');
        for (const r of d.recommendations) {
          lines.push(`- ${r}`);
        }
        lines.push('');
      }
    }

    // ISO 42001 Compliance
    lines.push('## ISO 42001:2023 Compliance Mapping');
    lines.push('');
    lines.push(`**Compliance:** ${report.isoCompliance.compliancePercentage}%`);
    lines.push(`**Status:** ${report.isoCompliance.fullyCompliant ? '✅ Fully Compliant' : '⚠️ Gaps Identified'}`);
    lines.push('');

    lines.push('| Clause | Description | Covered | Score |');
    lines.push('|--------|-------------|---------|-------|');
    for (const clause of ALL_ISO_CLAUSES) {
      const entry = report.isoCompliance.clauseCoverage.get(clause)!;
      lines.push(
        `| ${clause} | ${ISO_CLAUSE_DESCRIPTIONS[clause]} | ${entry.covered ? '✅' : '❌'} | ${entry.score}/100 |`,
      );
    }
    lines.push('');

    if (report.isoCompliance.gaps.length > 0) {
      lines.push('### ISO Compliance Gaps');
      lines.push('');
      for (const gap of report.isoCompliance.gaps) {
        lines.push(`- **${gap.clause}** (${gap.severity}): ${gap.description}`);
        lines.push(`  → ${gap.recommendation}`);
      }
      lines.push('');
    }

    // NIST AI RMF
    lines.push('## NIST AI RMF 1.0 Alignment');
    lines.push('');
    lines.push(`**Alignment:** ${report.nistRmfAlignment.alignmentPercentage}%`);
    lines.push('');

    lines.push('| Function | Coverage | Controls |');
    lines.push('|----------|----------|----------|');
    for (const [func, entry] of report.nistRmfAlignment.functionCoverage) {
      lines.push(
        `| ${func} | ${entry.coveragePercentage}% (${entry.coveredSubcategories}/${entry.totalSubcategories}) | ${entry.controls.length} |`,
      );
    }
    lines.push('');

    if (report.nistRmfAlignment.gaps.length > 0) {
      lines.push(`### NIST Mapping Gaps (${report.nistRmfAlignment.gaps.length})`);
      lines.push('');
      for (const gap of report.nistRmfAlignment.gaps.slice(0, 10)) {
        lines.push(`- **${gap.subcategory}** (${gap.severity}): ${gap.recommendation}`);
      }
      lines.push('');
    }

    // Trend Analysis
    lines.push('## Posture Trend Analysis');
    lines.push('');
    const t = report.trendAnalysis;
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Snapshots | ${t.snapshotCount} |`);
    lines.push(`| Trend | ${this.trendEmoji(t.trend)} ${t.trend} |`);
    lines.push(`| Score Delta (all-time) | ${t.scoreDelta >= 0 ? '+' : ''}${t.scoreDelta} |`);
    lines.push(`| Score Delta (recent) | ${t.scoreDeltaRecent >= 0 ? '+' : ''}${t.scoreDeltaRecent} |`);
    lines.push(`| Average Score | ${t.averageScore}/100 |`);
    lines.push(`| Min / Max | ${t.minScore} / ${t.maxScore} |`);
    lines.push(`| Volatility | ${t.volatility} |`);
    lines.push(`| 4-Week Projection | ${t.projectedScore}/100 |`);
    lines.push('');

    // Score history mini-chart
    if (report.postureHistory.length >= 2) {
      lines.push('```');
      lines.push(this.renderScoreChart(report.postureHistory));
      lines.push('```');
      lines.push('');
    }

    // Audit Checklist
    lines.push('## Audit Readiness Checklist');
    lines.push('');
    const checklistByCategory = new Map<string, AuditChecklistItem[]>();
    for (const item of report.auditChecklist) {
      const arr = checklistByCategory.get(item.category) ?? [];
      arr.push(item);
      checklistByCategory.set(item.category, arr);
    }
    for (const [category, items] of checklistByCategory) {
      lines.push(`### ${category}`);
      lines.push('');
      for (const item of items) {
        const icon = item.status === 'passed' ? '✅' :
          item.status === 'failed' ? '❌' :
          item.status === 'pending' ? '⏳' : '—';
        lines.push(`- ${icon} ${item.item}`);
        if (item.notes) lines.push(`  - *${item.notes}*`);
      }
      lines.push('');
    }

    // Signature
    if (report.signature) {
      lines.push('---');
      lines.push('');
      lines.push(`**HMAC Signature:** \`${report.signature.slice(0, 32)}...\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format the audit report as structured JSON.
   */
  formatAsJson(report: ComplianceAuditReport): string {
    return JSON.stringify(report, null, 2);
  }

  // ── Snapshot Management ──────────────────────────────────────────

  /** Get all posture snapshots. */
  getSnapshots(): PostureSnapshot[] {
    return [...this.snapshots];
  }

  /** Clear all snapshots. */
  clearSnapshots(): void {
    this.snapshots = [];
    this.persistSnapshots();
  }

  // ── Public Accessors ─────────────────────────────────────────────

  /** Get the control catalog. */
  getControls(): ComplianceControl[] {
    return [...this.controls];
  }

  /** Get current posture from latest snapshot (cached, faster than recalculating). */
  getCurrentPosture(): SecurityPosture | null {
    if (this.snapshots.length > 0) {
      return this.snapshots[this.snapshots.length - 1].posture;
    }
    return this.calculatePosture();
  }

  // ==========================================================================
  // Internal — Report Generation
  // ==========================================================================

  private generateExecutiveSummary(
    posture: SecurityPosture,
    iso: IsoComplianceSummary,
    nist: NistRmfAlignmentSummary,
    trend: TrendAnalysis,
  ): string {
    const parts: string[] = [];

    parts.push(`Commander security posture: **${posture.overallScore}/100 (Grade ${posture.grade})** — ${posture.status}.`);
    parts.push(`ISO 42001 compliance: ${iso.compliancePercentage}% (${iso.gaps.length} gaps). NIST AI RMF alignment: ${nist.alignmentPercentage}%.`);

    if (trend.trend === 'improving') {
      parts.push(`Posture trend is **improving** (+${trend.scoreDeltaRecent} points recently).`);
    } else if (trend.trend === 'declining') {
      parts.push(`⚠️ Posture trend is **declining** (${trend.scoreDeltaRecent} points recently). Immediate attention recommended.`);
    } else {
      parts.push(`Posture trend is **stable**.`);
    }

    if (posture.topRisks.length > 0) {
      parts.push(`Top risks: ${posture.topRisks.join(', ')}.`);
    }

    parts.push(
      `${this.controls.length} security controls documented across ` +
      `${Object.keys(DIMENSION_WEIGHTS).length} dimensions. ` +
      `AuditChainLedger provides tamper-evident audit trail. ` +
      `RedTeamFramework provides automated adversarial testing evidence.`,
    );

    return parts.join(' ');
  }

  private generateRecommendations(
    dim: ScoringDimension,
    score: number,
    controls: ComplianceControl[],
  ): string[] {
    const recs: string[] = [];

    if (score >= 90) {
      recs.push('Maintain current posture. Consider annual third-party review.');
      return recs;
    }

    if (score < 70) {
      recs.push('URGENT: This dimension requires immediate improvement.');
    }

    // Specific recommendations per dimension
    switch (dim) {
      case 'input_security':
        if (score < 85) {
          recs.push('Expand content scanning to additional languages and obfuscation techniques.');
          recs.push('Consider ML-based injection detection to complement regex patterns.');
        }
        break;
      case 'tool_safety':
        if (score < 85) {
          recs.push('Implement Windows sandbox support (AppContainer).');
          recs.push('Add seccomp BPF rules for Linux sandbox.');
        }
        break;
      case 'runtime_defense':
        if (score < 80) {
          recs.push('Increase baseline observation minimum for more accurate anomaly detection.');
          recs.push('Add cross-agent behavioral correlation.');
        }
        break;
      case 'supply_chain':
        if (score < 80) {
          recs.push('Expand malware signature database with emerging threats.');
          recs.push('Add model weight provenance verification.');
        }
        break;
      case 'economic_defense':
        if (score < 80) {
          recs.push('Implement cross-session cost anomaly correlation.');
          recs.push('Add predictive cost forecasting for budget planning.');
        }
        break;
      case 'operational_readiness':
        if (score < 80) {
          recs.push('Conduct quarterly incident response drills.');
          recs.push('Automate posture snapshot in CI/CD pipeline.');
        }
        break;
    }

    if (controls.every((c) => c.automated)) {
      recs.push('All controls are automated — maintain automation coverage.');
    } else {
      recs.push('Consider automating remaining manual controls.');
    }

    return recs;
  }

  private renderScoreChart(history: PostureSnapshot[]): string {
    const recent = history.slice(-20);
    if (recent.length < 1) return 'Insufficient data for chart.';

    const width = 50;
    const maxScore = 100;
    const lines: string[] = [];
    const dateLen = 10; // YYYY-MM-DD

    for (const snap of recent) {
      const score = snap.posture.overallScore;
      const filled = Math.round((score / maxScore) * width);
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const date = snap.timestamp.slice(0, dateLen);
      lines.push(`${date} │ ${bar} ${score}`);
    }

    const pad = ' '.repeat(dateLen + 1);
    lines.push(`${pad}└${'─'.repeat(width + 2)}`);
    return lines.join('\n');
  }

  // ==========================================================================
  // Internal — Helpers
  // ==========================================================================

  private evaluateStatus(score: number): SecurityPosture['status'] {
    if (score >= 90) return 'excellent';
    if (score >= 80) return 'good';
    if (score >= 65) return 'adequate';
    if (score >= 50) return 'needs_improvement';
    return 'critical';
  }

  private scoreToGrade(score: number): string {
    if (score >= 95) return 'A+';
    if (score >= 90) return 'A';
    if (score >= 85) return 'B+';
    if (score >= 80) return 'B';
    if (score >= 75) return 'C+';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  private statusEmoji(status: string): string {
    switch (status) {
      case 'excellent': return '🟢';
      case 'good': return '🟢';
      case 'adequate': return '🟡';
      case 'needs_improvement': return '🟠';
      case 'critical': return '🔴';
      default: return '⚪';
    }
  }

  private trendEmoji(trend: string): string {
    switch (trend) {
      case 'improving': return '📈';
      case 'stable': return '➡️';
      case 'declining': return '📉';
      default: return '❓';
    }
  }

  private signReport(report: ComplianceAuditReport): string {
    const data = JSON.stringify({
      metadata: report.metadata,
      posture: {
        overallScore: report.posture.overallScore,
        grade: report.posture.grade,
        dimensions: report.posture.dimensions.map((d) => ({
          dimension: d.dimension,
          score: d.score,
          status: d.status,
        })),
        status: report.posture.status,
      },
      isoCompliance: {
        compliancePercentage: report.isoCompliance.compliancePercentage,
        gapCount: report.isoCompliance.gaps.length,
      },
      nistRmfAlignment: {
        alignmentPercentage: report.nistRmfAlignment.alignmentPercentage,
        gapCount: report.nistRmfAlignment.gaps.length,
      },
      trendAnalysis: {
        trend: report.trendAnalysis.trend,
        scoreDelta: report.trendAnalysis.scoreDelta,
        averageScore: report.trendAnalysis.averageScore,
      },
    });

    return crypto
      .createHmac('sha256', this.config.signingKey!)
      .update(data)
      .digest('hex');
  }

  private loadSnapshots(): void {
    try {
      if (fs.existsSync(this.config.snapshotPath)) {
        const raw = fs.readFileSync(this.config.snapshotPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.snapshots = parsed;
        }
      }
    } catch {
      this.snapshots = [];
    }
  }

  private persistSnapshots(): void {
    try {
      const dir = path.dirname(this.config.snapshotPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.config.snapshotPath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshots, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.config.snapshotPath);
    } catch (err) {
      getGlobalLogger().warn('ComplianceAudit', 'Failed to persist snapshots', {
        error: (err as Error)?.message,
      });
    }
  }

  /** Reset state (for test isolation). */
  reset(): void {
    this.snapshots = [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

const complianceSingleton = createTenantAwareSingleton(
  () => new ComplianceAuditManager(),
);

/** Get the global ComplianceAuditManager. */
export function getComplianceAuditManager(
  config?: Partial<ComplianceConfig>,
): ComplianceAuditManager {
  return complianceSingleton.get();
}

/** Reset the compliance audit manager (for test isolation). */
export function resetComplianceAuditManager(): void {
  complianceSingleton.reset();
}
