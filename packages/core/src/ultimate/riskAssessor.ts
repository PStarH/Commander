/**
 * Risk Assessor — P3: Classify sub-agent nodes for human-in-the-loop gating.
 *
 * Pure function, no I/O. Derives a NodeRiskLevel from the node's goal,
 * available tools, and (optional) tenant risk profile. Heuristic only —
 * the orchestrator may override via the HumanApprovalGate nodeIds
 * allowlist.
 */
import type { NodeRiskAssessment, NodeRiskLevel, TaskTreeNode } from './types';

const HIGH_RISK_TOOLS = new Set([
  'shell_execute',
  'bash',
  'exec',
  'file_delete',
  'rm',
  'file_write',
  'web_fetch',
  'http_request',
  'database_write',
  'sql_execute',
  'deploy',
  'docker_run',
]);

const CRITICAL_RISK_TOOLS = new Set([
  'shell_execute',
  'bash',
  'exec',
  'deploy',
  'docker_run',
  'kubectl_apply',
  'database_drop',
  'rm_rf',
]);

const MEDIUM_RISK_KEYWORDS = [
  'delete',
  'remove',
  'drop',
  'wipe',
  'reset',
  'rollback',
  'modify',
  'change',
  'update',
  'edit',
  'patch',
  'send',
  'publish',
  'post',
  'broadcast',
  'email',
  'notify',
  'commit',
  'push',
  'merge',
  'deploy',
];

const CRITICAL_RISK_KEYWORDS = [
  'production',
  'prod',
  'live',
  'customer',
  'billing',
  'payment',
  'credit card',
  'pii',
  'ssn',
  'password',
  'secret',
  'credential',
  'token',
  'key',
  'auth',
  'irreversible',
  'destructive',
  'cascade',
  'global',
  'migrate',
  'migration',
];

const LOW_RISK_KEYWORDS = [
  'read',
  'list',
  'show',
  'find',
  'search',
  'analyze',
  'summarize',
  'explain',
  'document',
  'research',
  'investigate',
];

const RISK_RANK: Record<NodeRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Compiled `\bkeyword\b` patterns, keyed by keyword.
 *
 * Matching is word-boundary based, not substring based. The lists contain
 * short common tokens (`key`, `auth`, `live`, `prod`, `pii`), so substring
 * matching classified `monkey` as a `key` hit, `author` as an `auth` hit and
 * `lively` as a `live` hit — an innocuous goal could be escalated to CRITICAL
 * and routed into the human-approval path. Word boundaries keep the intended
 * signal (`deploy to production`, `rotate the auth token`) without the noise.
 */
const KEYWORD_PATTERNS = new Map<string, RegExp>();

function matchesKeyword(haystackLower: string, keyword: string): boolean {
  let pattern = KEYWORD_PATTERNS.get(keyword);
  if (!pattern) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`\\b${escaped}\\b`);
    KEYWORD_PATTERNS.set(keyword, pattern);
  }
  return pattern.test(haystackLower);
}

export interface RiskClassification {
  level: NodeRiskLevel;
  reasons: string[];
}

/**
 * Classify risk from a goal plus a tool list.
 *
 * Pure and I/O-free. Extracted from `assessNodeRisk` so the same heuristic can
 * serve both sub-agent nodes and top-level entry points, which previously
 * asserted `riskLevel: 'LOW'` without measuring anything.
 */
export function classifyRisk(
  goal: string,
  tools: readonly string[] = [],
  riskProfile?: string,
): RiskClassification {
  const reasons: string[] = [];
  let level: NodeRiskLevel = 'low';

  const goalLower = goal.toLowerCase();

  for (const tool of tools) {
    if (CRITICAL_RISK_TOOLS.has(tool)) {
      if (RISK_RANK.critical > RISK_RANK[level]) {
        level = 'critical';
        reasons.push(`Uses critical tool: ${tool}`);
      }
    } else if (HIGH_RISK_TOOLS.has(tool)) {
      if (RISK_RANK.high > RISK_RANK[level]) {
        level = 'high';
        reasons.push(`Uses high-risk tool: ${tool}`);
      }
    }
  }

  for (const keyword of CRITICAL_RISK_KEYWORDS) {
    if (matchesKeyword(goalLower, keyword)) {
      if (RISK_RANK.critical > RISK_RANK[level]) {
        level = 'critical';
        reasons.push(`Goal references critical concept: '${keyword}'`);
      }
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (matchesKeyword(goalLower, keyword)) {
      if (RISK_RANK.medium > RISK_RANK[level]) {
        level = 'medium';
        reasons.push(`Goal references mutating action: '${keyword}'`);
      }
    }
  }

  if (level === 'low' && tools.length === 0) {
    const hasReadOnly = LOW_RISK_KEYWORDS.some((k) => matchesKeyword(goalLower, k));
    if (hasReadOnly) {
      reasons.push('Read-only operation with no risky tools');
    } else {
      level = 'medium';
      reasons.push('No tools and ambiguous action verbs — assuming mutating intent');
    }
  }

  // Normalize to lowercase so both typed NodeRiskLevel values ('critical') and
  // config string values ('CRITICAL') match correctly.
  const profile = riskProfile?.toLowerCase();
  if (profile === 'critical' && level !== 'critical') {
    level = 'critical';
    reasons.push('Tenant risk profile is CRITICAL — escalating all nodes');
  } else if (profile === 'high' && RISK_RANK[level] < RISK_RANK.high) {
    level = 'high';
    reasons.push('Tenant risk profile is HIGH — escalating to high');
  } else if (profile === 'medium' && level === 'low') {
    level = 'medium';
    reasons.push('Tenant risk profile is MEDIUM — escalating low to medium');
  }

  if (reasons.length === 0) {
    reasons.push('Default low risk: no risky keywords or tools detected');
  }

  return { level, reasons };
}

/**
 * Uppercase risk level for `contextData.governanceProfile.riskLevel`.
 *
 * `CommanderCore.run`, `Commander.run` and `AgentLoop.run` used to hardcode
 * `'LOW'`. Because `telosOrchestrator.analyzeTask` derives
 * `requiresApproval: riskLevel === 'CRITICAL' || riskLevel === 'HIGH'`, that
 * constant made `requiresApproval` permanently false on the primary entry
 * paths — the human-in-the-loop path could never engage, and the model router
 * never scored risk. Deriving the level keeps the governance profile a
 * measurement instead of an assertion.
 */
export function assessGovernanceRiskLevel(
  goal: string,
  tools: readonly string[] = [],
  riskProfile?: string,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  return classifyRisk(goal, tools, riskProfile).level.toUpperCase() as
    'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function assessNodeRisk(node: TaskTreeNode, riskProfile?: string): NodeRiskAssessment {
  const { level, reasons } = classifyRisk(
    node.goal,
    node.context.availableTools ?? [],
    riskProfile,
  );

  return {
    nodeId: node.id,
    level,
    reasons,
    confidence: Math.min(1, 0.5 + reasons.length * 0.1),
  };
}

export function shouldRequestApproval(
  gate: {
    enabled: boolean;
    nodeIds?: string[];
    tags?: string[];
    riskThreshold?: NodeRiskLevel;
    sampling?: number;
  },
  assessment: NodeRiskAssessment,
  node: TaskTreeNode,
): boolean {
  if (!gate.enabled) return false;

  if (gate.nodeIds?.includes(node.id)) return true;

  if (gate.tags && gate.tags.length > 0) {
    const goal = node.goal.toLowerCase();
    if (gate.tags.some((tag) => goal.includes(tag.toLowerCase()))) return true;
  }

  if (gate.riskThreshold) {
    if (RISK_RANK[assessment.level] >= RISK_RANK[gate.riskThreshold]) {
      return true;
    }
  }

  if (gate.sampling !== undefined && gate.sampling > 0) {
    if (Math.random() < gate.sampling) return true;
  }

  return false;
}
