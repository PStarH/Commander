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
  'shell_execute', 'bash', 'exec',
  'file_delete', 'rm', 'file_write',
  'web_fetch', 'http_request',
  'database_write', 'sql_execute',
  'deploy', 'docker_run',
]);

const CRITICAL_RISK_TOOLS = new Set([
  'shell_execute', 'bash', 'exec',
  'deploy', 'docker_run', 'kubectl_apply',
  'database_drop', 'rm_rf',
]);

const MEDIUM_RISK_KEYWORDS = [
  'delete', 'remove', 'drop', 'wipe', 'reset', 'rollback',
  'modify', 'change', 'update', 'edit', 'patch',
  'send', 'publish', 'post', 'broadcast', 'email', 'notify',
  'commit', 'push', 'merge', 'deploy',
];

const CRITICAL_RISK_KEYWORDS = [
  'production', 'prod', 'live', 'customer', 'billing',
  'payment', 'credit card', 'pii', 'ssn', 'password',
  'secret', 'credential', 'token', 'key', 'auth',
  'irreversible', 'destructive', 'cascade', 'global',
  'migrate', 'migration',
];

const LOW_RISK_KEYWORDS = [
  'read', 'list', 'show', 'find', 'search', 'analyze',
  'summarize', 'explain', 'document', 'research', 'investigate',
];

const RISK_RANK: Record<NodeRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function assessNodeRisk(
  node: TaskTreeNode,
  riskProfile?: string,
): NodeRiskAssessment {
  const reasons: string[] = [];
  let level: NodeRiskLevel = 'low';

  const goal = node.goal.toLowerCase();
  const tools = node.context.availableTools ?? [];

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
    if (goal.includes(keyword)) {
      if (RISK_RANK.critical > RISK_RANK[level]) {
        level = 'critical';
        reasons.push(`Goal references critical concept: '${keyword}'`);
      }
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (goal.includes(keyword)) {
      if (RISK_RANK.medium > RISK_RANK[level]) {
        level = 'medium';
        reasons.push(`Goal references mutating action: '${keyword}'`);
      }
    }
  }

  if (level === 'low' && tools.length === 0) {
    const hasReadOnly = LOW_RISK_KEYWORDS.some((k) => goal.includes(k));
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

  const confidence = Math.min(1, 0.5 + reasons.length * 0.1);

  return {
    nodeId: node.id,
    level,
    reasons,
    confidence,
  };
}

export function shouldRequestApproval(
  gate: { enabled: boolean; nodeIds?: string[]; tags?: string[]; riskThreshold?: NodeRiskLevel; sampling?: number },
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
