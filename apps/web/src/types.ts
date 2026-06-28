export type AgentStatus = 'READY' | 'RUNNING' | 'BLOCKED' | 'OFFLINE';
export type MissionStatus = 'PLANNED' | 'RUNNING' | 'BLOCKED' | 'DONE';
export type MissionPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MissionRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MissionGovernanceMode = 'AUTO' | 'GUARDED' | 'MANUAL';
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
export type ProjectStatus = 'ACTIVE' | 'AT_RISK' | 'STABILIZING';
export type ProjectMemoryKind = 'DECISION' | 'ISSUE' | 'LESSON' | 'SUMMARY';
export type MemoryKindFilter = 'ALL' | ProjectMemoryKind;
export type HealthColor = 'GREEN' | 'AMBER' | 'RED';

export interface Project {
  id: string;
  name: string;
  codename: string;
  objective: string;
  status: ProjectStatus;
  updatedAt: string;
}

export interface AgentWorkload {
  agentId: string;
  agentName: string;
  callsign: string;
  status: AgentStatus;
  specialty: string;
  assignedMissionCount: number;
  activeMissionCount: number;
  completedMissionCount: number;
  latestLogAt?: string;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  governanceMode: MissionGovernanceMode;
  assignedAgentId: string;
  updatedAt: string;
}

export interface ExecutionLog {
  id: string;
  missionId: string;
  agentId: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface ProjectMemoryItem {
  id: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: ProjectMemoryKind;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface BattleReport {
  generatedAt: string;
  health: HealthColor;
  totalAgents: number;
  activeAgents: number;
  totalMissions: number;
  runningMissionCount: number;
  blockedMissionCount: number;
  completedMissionCount: number;
  logVolume24h: number;
  completionRate: number;
  highRiskMissionCount: number;
  manualGovernanceMissionCount: number;
  topAgents: Array<{
    agentId: string;
    agentName: string;
    completedMissionCount: number;
  }>;
  narrative: string;
}

export interface WarRoomSnapshot {
  project: Project;
  agents: AgentWorkload[];
  missions: Mission[];
  latestLogs: ExecutionLog[];
  battleReport: BattleReport;
}

export interface MemoryOverview {
  totalItems: number;
  kindCounts: Record<ProjectMemoryKind, number>;
  topTags: Array<{
    tag: string;
    count: number;
  }>;
  missionLinkedCount: number;
  agentLinkedCount: number;
  latestCreatedAt?: string;
}

export interface CreateMissionPayload {
  title: string;
  objective: string;
  assignedAgentId: string;
  priority: MissionPriority;
  riskLevel: MissionRiskLevel;
  governanceMode: MissionGovernanceMode;
}

export interface CreateLogPayload {
  level: LogLevel;
  message: string;
}

export const MISSION_STATUS_ORDER: MissionStatus[] = ['PLANNED', 'RUNNING', 'BLOCKED', 'DONE'];
export const MISSION_PRIORITY_OPTIONS: MissionPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const MISSION_RISK_OPTIONS: MissionRiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const MISSION_GOVERNANCE_OPTIONS: MissionGovernanceMode[] = ['AUTO', 'GUARDED', 'MANUAL'];
export const LOG_LEVEL_OPTIONS: LogLevel[] = ['INFO', 'SUCCESS', 'WARN', 'ERROR'];
export const MEMORY_KIND_OPTIONS: MemoryKindFilter[] = [
  'ALL',
  'DECISION',
  'ISSUE',
  'LESSON',
  'SUMMARY',
];

export function nextMissionActions(status: MissionStatus): MissionStatus[] {
  switch (status) {
    case 'PLANNED':
      return ['RUNNING', 'BLOCKED'];
    case 'RUNNING':
      return ['DONE', 'BLOCKED'];
    case 'BLOCKED':
      return ['RUNNING', 'DONE'];
    case 'DONE':
      return [];
    default:
      return [];
  }
}

export function isMissionHighRisk(mission: Pick<Mission, 'riskLevel'>): boolean {
  return mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export interface ConfidenceAction {
  actionType: string;
  confidenceScore: number;
  rationale: string;
  recommendation?: string;
}

export interface ConfidenceTrend {
  direction: 'improving' | 'declining' | 'stable';
  changeRate: number;
}

export interface ConfidenceReport {
  overallScore: number;
  averageConfidence: number;
  totalDecisions: number;
  totalActions: number;
  trend: ConfidenceTrend;
  distribution: {
    low: number;
    medium: number;
    high: number;
    veryHigh: number;
  };
  lowConfidenceActions: ConfidenceAction[];
  recommendations: string[];
  missionId?: string;
  agentId?: string;
  generatedAt: string;
}

export interface CostRecord {
  runId: string;
  modelId: string;
  provider: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
  timestamp: string;
  agentId: string;
}

export interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  totalCalls: number;
  perModel: Record<string, { calls: number; tokens: number; costUsd: number }>;
  perAgent: Record<string, { calls: number; tokens: number; costUsd: number }>;
}

export interface BudgetAlert {
  type: 'soft_cap_warning' | 'hard_cap_reached' | 'cost_cap_reached' | 'budget_exhausted';
  runId: string;
  current: number;
  limit: number;
  message: string;
}

export interface BudgetStatus {
  monthlyUsed: number;
  monthlyLimit: number;
  usagePercent: number;
  alertCount: number;
  alerts: BudgetAlert[];
}

export interface CostRecordsResponse {
  records: CostRecord[];
  total: number;
}

// Pause / Resume panel types
export interface ActiveRun {
  runId: string;
  paused: boolean;
  checkpointPhase?: string;
}

export interface ActiveRunsResponse {
  runs: ActiveRun[];
  total: number;
}

export interface PauseResumeResponse {
  status: string;
  message: string;
  fromPhase?: string;
  stepNumber?: number;
  injectedInstructions?: boolean;
}

export interface ReplayRun {
  runId: string;
  agentId: string;
  missionId?: string;
  goal?: string;
  model?: string;
  status: 'completed' | 'failed';
  phase: string;
  startedAt: string;
  completedAt?: string;
  totalEvents: number;
  totalTokens: number;
  durationMs: number;
  stepCount: number;
}

export interface ReplayEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  agentId: string;
  type: string;
  timestamp: string;
  durationMs: number;
  data: { [key: string]: any };
  parentSpanId?: string;
}

export interface ReplayRunsResponse {
  runs: ReplayRun[];
  total: number;
}

export interface ReplayEventsResponse {
  events: ReplayEvent[];
  total: number;
}

// ============================================================================
// Security Posture Dashboard Types
// ============================================================================

export type ScoringDimension =
  | 'input_security'
  | 'tool_safety'
  | 'runtime_defense'
  | 'supply_chain'
  | 'economic_defense'
  | 'operational_readiness'
  | 'crypto_defense'
  | 'fuzz_testing';

export type IsoClause =
  | '6.1'
  | '6.2'
  | '7.1'
  | '7.2'
  | '7.3'
  | '7.4'
  | '7.5'
  | '8.1'
  | '8.2'
  | '8.3'
  | '9.1'
  | '9.2'
  | '9.3'
  | '10.1'
  | '10.2';

export type NistAirmfFunction = 'GOVERN' | 'MAP' | 'MEASURE' | 'MANAGE';

export interface ComplianceControl {
  id: string;
  name: string;
  description: string;
  isoClauses: IsoClause[];
  nistSubcategories: string[];
  effectivenessScore: number;
  automated: boolean;
}

export interface DimensionScore {
  dimension: ScoringDimension;
  label: string;
  weight: number;
  score: number;
  controls: ComplianceControl[];
  isoClausesCovered: IsoClause[];
  nistSubcategoriesCovered: string[];
  status: 'excellent' | 'good' | 'adequate' | 'needs_improvement' | 'critical';
  recommendations: string[];
}

export interface SecurityPosture {
  calculatedAt: string;
  overallScore: number;
  grade: string;
  dimensions: DimensionScore[];
  status: 'excellent' | 'good' | 'adequate' | 'needs_improvement' | 'critical';
  topRisks: string[];
  topStrengths: string[];
}

export interface IsoCoverageEntry {
  covered: boolean;
  controls: string[];
  score: number;
}

export interface IsoGap {
  clause: IsoClause;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface IsoComplianceSummary {
  fullyCompliant: boolean;
  clauseCoverage: Record<IsoClause, IsoCoverageEntry>;
  gaps: IsoGap[];
  compliancePercentage: number;
}

export interface NistFunctionCoverage {
  coveredSubcategories: number;
  totalSubcategories: number;
  coveragePercentage: number;
  controls: string[];
}

export interface NistGap {
  subcategory: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface NistRmfAlignmentSummary {
  functionCoverage: Record<NistAirmfFunction, NistFunctionCoverage>;
  gaps: NistGap[];
  alignmentPercentage: number;
}

export interface TrendAnalysis {
  snapshotCount: number;
  scoreDelta: number;
  scoreDeltaRecent: number;
  trend: 'improving' | 'stable' | 'declining' | 'insufficient_data';
  averageScore: number;
  minScore: number;
  maxScore: number;
  volatility: number;
  projectedScore: number;
}

export interface PostureSnapshot {
  id: string;
  timestamp: string;
  posture: SecurityPosture;
  trigger: 'manual' | 'scheduled' | 'ci_cd' | 'pre_release';
}

export interface AuditChecklistItem {
  id: string;
  category: string;
  item: string;
  status: 'passed' | 'failed' | 'not_applicable' | 'pending';
  evidence?: string;
  notes?: string;
}

export interface RedTeamSummary {
  securityScore: number;
  totalScenarios: number;
  blocked: number;
  detected: number;
  missed: number;
  errors: number;
  mode: 'smoke' | 'full' | 'critical-only';
  regressions: number;
  passed: boolean;
}

export interface ComplianceAuditReport {
  metadata: {
    reportId: string;
    generatedAt: string;
    version: number;
    commitHash?: string;
    branch?: string;
  };
  posture: SecurityPosture;
  postureHistory: PostureSnapshot[];
  isoCompliance: IsoComplianceSummary;
  nistRmfAlignment: NistRmfAlignmentSummary;
  trendAnalysis: TrendAnalysis;
  auditChecklist: AuditChecklistItem[];
  redTeam?: RedTeamSummary;
  signature?: string;
}

// ============================================================================
// Hallucination Detection — risk reports extracted from trace files (GAP-04)
// ============================================================================

export interface HallucinationSignal {
  type: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string;
  suggestion: string;
}

export interface HallucinationReportEntry {
  eventId: string;
  spanId: string;
  timestamp: string;
  agentId: string;
  eventType: string;
  riskScore: number;
  recommendation: 'pass' | 'flag_for_review' | 'reject';
  signals: HallucinationSignal[];
  summary: string;
}

export interface HallucinationReportResponse {
  runId: string;
  reports: HallucinationReportEntry[];
  total: number;
}

// ============================================================================
// Lineage Tracking — agent provenance tree (GAP-05)
// ============================================================================

export interface LineageNodeEntry {
  instanceId: string;
  parentInstanceId: string | null;
  agentId: string;
  role?: string;
  runId?: string;
  spawnedAt: string;
  revokedAt?: string;
  depth: number;
  toolCallCount: number;
  metadata?: Record<string, unknown>;
}

export interface LineageSummaryResponse {
  runId: string;
  root: LineageNodeEntry | null;
  nodes: LineageNodeEntry[];
  totalNodes: number;
  maxDepth: number;
  activeNodes: number;
}
