/**
 * Conflict Detection Module for Commander
 *
 * Based on research: "Conflict Resolution Playbook" (Arion Research, Dec 2025)
 * https://www.arionresearch.com/blog/conflict-resolution-playbook-how-agentic-ai-systems-detect-negotiate-and-resolve-disputes-at-scale
 *
 * Key Concepts:
 * - Conflict Types: Goal, Resource, Policy, Interpretation
 * - Severity Levels: low, medium, high, critical
 * - Detection Lifecycle: Detection → Classification → Resolution Selection → Negotiation → Execution → Learning
 */

// ============================================
// Type Definitions
// ============================================

export type ConflictType = 'GOAL' | 'RESOURCE' | 'POLICY' | 'INTERPRETATION';

export type ConflictSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ConflictDetectionMode = 'proactive' | 'reactive';

export interface Agent {
  id: string;
  name: string;
  role?: string;
  specialties?: string[];
  currentTaskId?: string;
  resourceUsage?: {
    tokenBudget?: number;
    apiCallsRemaining?: number;
    computeUnits?: number;
  };
}

export interface ProposedAction {
  agentId: string;
  actionType: string;
  targetResource?: string;
  estimatedTokens?: number;
  estimatedApiCalls?: number;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  governanceLevel?: 'EXECUTOR' | 'REVIEWER' | 'APPROVER';
  metadata?: Record<string, unknown>;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  severity: ConflictSeverity;
  description: string;
  involvedAgents: string[];
  proposedActions: ProposedAction[];
  detectedAt: string;
  detectionMode: ConflictDetectionMode;
  metadata?: Record<string, unknown>;
}

export interface ConflictDetectionResult {
  hasConflict: boolean;
  conflict?: Conflict;
  reasoning: string;
}

// ============================================
// Conflict Detection Logic
// ============================================

/**
 * Detect potential conflicts before agents take action (proactive)
 */
export function proactiveConflictCheck(
  agent: Agent,
  proposedAction: ProposedAction,
  context: {
    otherAgents: Agent[];
    activeMissions?: Array<{ id: string; assignedAgentId: string; priority: string }>;
    governanceMode?: 'AUTO' | 'GUARDED' | 'MANUAL';
    resourcePool?: {
      totalTokens?: number;
      totalApiCalls?: number;
      totalComputeUnits?: number;
    };
  }
): ConflictDetectionResult {
  // 1. Goal Conflict: Check if agents have competing objectives
  const goalConflict = detectGoalConflict(agent, proposedAction, context);
  if (goalConflict.hasConflict) {
    return goalConflict;
  }

  // 2. Resource Conflict: Check for resource contention
  const resourceConflict = detectResourceConflict(agent, proposedAction, context);
  if (resourceConflict.hasConflict) {
    return resourceConflict;
  }

  // 3. Policy Conflict: Check governance/policy violations
  const policyConflict = detectPolicyConflict(agent, proposedAction, context);
  if (policyConflict.hasConflict) {
    return policyConflict;
  }

  // 4. Interpretation Conflict: Check for semantic/terminology disagreements
  const interpretationConflict = detectInterpretationConflict(agent, proposedAction, context);
  if (interpretationConflict.hasConflict) {
    return interpretationConflict;
  }

  return {
    hasConflict: false,
    reasoning: 'No conflicts detected in proactive check',
  };
}

/**
 * Detect conflicts by monitoring agent behavior (reactive)
 */
export function reactiveConflictMonitor(
  agents: Agent[],
  recentActions: ProposedAction[]
): Conflict[] {
  const conflicts: Conflict[] = [];

  // Group actions by target resource
  const resourceActions = new Map<string, ProposedAction[]>();
  for (const action of recentActions) {
    if (action.targetResource) {
      const existing = resourceActions.get(action.targetResource) || [];
      existing.push(action);
      resourceActions.set(action.targetResource, existing);
    }
  }

  // Detect resource contention (multiple agents targeting same resource)
  for (const [resource, actions] of resourceActions) {
    if (actions.length > 1) {
      const uniqueAgents = [...new Set(actions.map(a => a.agentId))];
      if (uniqueAgents.length > 1) {
        conflicts.push({
          id: `conflict-resource-${resource}-${Date.now()}`,
          type: 'RESOURCE',
          severity: assessResourceConflictSeverity(actions),
          description: `Multiple agents (${uniqueAgents.length}) competing for resource: ${resource}`,
          involvedAgents: uniqueAgents,
          proposedActions: actions,
          detectedAt: new Date().toISOString(),
          detectionMode: 'reactive',
        });
      }
    }
  }

  // Detect potential goal conflicts (agents working on same mission with different priorities)
  const missionActions = new Map<string, ProposedAction[]>();
  for (const action of recentActions) {
    const missionId = action.metadata?.missionId as string | undefined;
    if (missionId) {
      const existing = missionActions.get(missionId) || [];
      existing.push(action);
      missionActions.set(missionId, existing);
    }
  }

  for (const [missionId, actions] of missionActions) {
    const priorities = actions.map(a => a.priority);
    const uniquePriorities = [...new Set(priorities)];
    if (uniquePriorities.length > 1) {
      conflicts.push({
        id: `conflict-goal-${missionId}-${Date.now()}`,
        type: 'GOAL',
        severity: 'medium',
        description: `Agents have different priority levels for mission ${missionId}: ${uniquePriorities.join(', ')}`,
        involvedAgents: [...new Set(actions.map(a => a.agentId))],
        proposedActions: actions,
        detectedAt: new Date().toISOString(),
        detectionMode: 'reactive',
        metadata: { missionId },
      });
    }
  }

  return conflicts;
}

// ============================================
// Conflict Type Detection
// ============================================

function detectGoalConflict(
  agent: Agent,
  proposedAction: ProposedAction,
  context: { otherAgents: Agent[]; activeMissions?: Array<{ id: string; assignedAgentId: string; priority: string }> }
): ConflictDetectionResult {
  // Check if agent is trying to work on a mission assigned to another agent
  if (context.activeMissions) {
    const targetMission = context.activeMissions.find(
      m => m.id === proposedAction.metadata?.targetMissionId
    );
    if (targetMission && targetMission.assignedAgentId !== agent.id) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-goal-${Date.now()}`,
          type: 'GOAL',
          severity: 'medium',
          description: `Agent ${agent.id} attempting to work on mission assigned to ${targetMission.assignedAgentId}`,
          involvedAgents: [agent.id, targetMission.assignedAgentId],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: { missionId: targetMission.id },
        },
        reasoning: 'Goal conflict: mission ownership mismatch',
      };
    }
  }

  // Check if multiple agents with same specialty are trying to work on similar tasks
  if (agent.specialties && agent.specialties.length > 0) {
    const conflictingAgents = context.otherAgents.filter(other => {
      if (!other.specialties || other.specialties.length === 0) return false;
      const overlap = agent.specialties!.filter(s => other.specialties!.includes(s));
      return overlap.length > 0 && other.currentTaskId !== agent.currentTaskId;
    });

    if (conflictingAgents.length > 0 && proposedAction.metadata?.exclusiveSpecialty) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-goal-specialty-${Date.now()}`,
          type: 'GOAL',
          severity: 'low',
          description: `Agents with overlapping specialties (${agent.specialties!.join(', ')}) may have competing goals`,
          involvedAgents: [agent.id, ...conflictingAgents.map(a => a.id)],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
        },
        reasoning: 'Potential goal conflict: overlapping specialties',
      };
    }
  }

  return { hasConflict: false, reasoning: 'No goal conflict detected' };
}

function detectResourceConflict(
  agent: Agent,
  proposedAction: ProposedAction,
  context: {
    otherAgents: Agent[];
    resourcePool?: {
      totalTokens?: number;
      totalApiCalls?: number;
      totalComputeUnits?: number;
    };
  }
): ConflictDetectionResult {
  // Check token budget
  if (proposedAction.estimatedTokens && context.resourcePool?.totalTokens) {
    const totalUsage = proposedAction.estimatedTokens +
      context.otherAgents.reduce((sum, a) => sum + (a.resourceUsage?.tokenBudget || 0), 0);

    if (totalUsage > context.resourcePool.totalTokens) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-resource-tokens-${Date.now()}`,
          type: 'RESOURCE',
          severity: 'high',
          description: `Token budget exceeded: ${totalUsage} > ${context.resourcePool.totalTokens}`,
          involvedAgents: [agent.id, ...context.otherAgents.map(a => a.id)],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: {
            requested: proposedAction.estimatedTokens,
            available: context.resourcePool.totalTokens,
          },
        },
        reasoning: 'Resource conflict: token budget exceeded',
      };
    }
  }

  // Check API rate limits
  if (proposedAction.estimatedApiCalls && context.resourcePool?.totalApiCalls) {
    const totalCalls = proposedAction.estimatedApiCalls +
      context.otherAgents.reduce((sum, a) => sum + (a.resourceUsage?.apiCallsRemaining || 0), 0);

    if (totalCalls > context.resourcePool.totalApiCalls) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-resource-api-${Date.now()}`,
          type: 'RESOURCE',
          severity: 'medium',
          description: `API rate limit approaching: ${totalCalls} / ${context.resourcePool.totalApiCalls}`,
          involvedAgents: [agent.id],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: {
            requested: proposedAction.estimatedApiCalls,
            available: context.resourcePool.totalApiCalls,
          },
        },
        reasoning: 'Resource conflict: API rate limit',
      };
    }
  }

  // Check target resource contention
  if (proposedAction.targetResource) {
    const agentsUsingResource = context.otherAgents.filter(
      a => a.resourceUsage && proposedAction.targetResource!.includes(a.id)
    );

    if (agentsUsingResource.length > 0) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-resource-${proposedAction.targetResource}-${Date.now()}`,
          type: 'RESOURCE',
          severity: 'medium',
          description: `Resource ${proposedAction.targetResource} is currently in use by ${agentsUsingResource.length} agent(s)`,
          involvedAgents: [agent.id, ...agentsUsingResource.map(a => a.id)],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: { resource: proposedAction.targetResource },
        },
        reasoning: 'Resource conflict: resource contention detected',
      };
    }
  }

  return { hasConflict: false, reasoning: 'No resource conflict detected' };
}

function detectPolicyConflict(
  agent: Agent,
  proposedAction: ProposedAction,
  context: { governanceMode?: 'AUTO' | 'GUARDED' | 'MANUAL' }
): ConflictDetectionResult {
  // Check governance level permissions
  if (proposedAction.governanceLevel === 'APPROVER' && agent.role !== 'APPROVER') {
    return {
      hasConflict: true,
      conflict: {
        id: `conflict-policy-permission-${Date.now()}`,
        type: 'POLICY',
        severity: 'high',
        description: `Agent ${agent.id} lacks APPROVER permission for action ${proposedAction.actionType}`,
        involvedAgents: [agent.id],
        proposedActions: [proposedAction],
        detectedAt: new Date().toISOString(),
        detectionMode: 'proactive',
        metadata: { requiredLevel: 'APPROVER', actualLevel: agent.role },
      },
      reasoning: 'Policy conflict: insufficient permissions',
    };
  }

  // Check MANUAL governance mode restrictions
  if (context.governanceMode === 'MANUAL') {
    // In MANUAL mode, all actions require human approval
    if (proposedAction.metadata?.requiresApproval !== false) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-policy-manual-${Date.now()}`,
          type: 'POLICY',
          severity: 'critical',
          description: `MANUAL governance mode requires human approval for action`,
          involvedAgents: [agent.id],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: { governanceMode: 'MANUAL' },
        },
        reasoning: 'Policy conflict: MANUAL mode requires approval',
      };
    }
  }

  // Check GUARDED mode for high-risk actions
  if (context.governanceMode === 'GUARDED' && proposedAction.priority === 'CRITICAL') {
    return {
      hasConflict: true,
      conflict: {
        id: `conflict-policy-guarded-${Date.now()}`,
        type: 'POLICY',
        severity: 'high',
        description: `GUARDED mode: CRITICAL priority actions require supervisor review`,
        involvedAgents: [agent.id],
        proposedActions: [proposedAction],
        detectedAt: new Date().toISOString(),
        detectionMode: 'proactive',
        metadata: { governanceMode: 'GUARDED', priority: 'CRITICAL' },
      },
      reasoning: 'Policy conflict: GUARDED mode requires review for CRITICAL actions',
    };
  }

  return { hasConflict: false, reasoning: 'No policy conflict detected' };
}

function detectInterpretationConflict(
  agent: Agent,
  proposedAction: ProposedAction,
  context: { otherAgents: Agent[] }
): ConflictDetectionResult {
  // Check for potential terminology conflicts via metadata
  const terminology = proposedAction.metadata?.terminology as Record<string, string> | undefined;
  if (terminology && context.otherAgents.length > 0) {
    // If action uses domain-specific terminology, flag for potential interpretation issues
    const domainTerms = Object.keys(terminology).filter(k => terminology[k] !== 'common');
    if (domainTerms.length > 0) {
      return {
        hasConflict: true,
        conflict: {
          id: `conflict-interpretation-${Date.now()}`,
          type: 'INTERPRETATION',
          severity: 'low',
          description: `Action uses domain-specific terminology that may be interpreted differently: ${domainTerms.join(', ')}`,
          involvedAgents: [agent.id],
          proposedActions: [proposedAction],
          detectedAt: new Date().toISOString(),
          detectionMode: 'proactive',
          metadata: { terms: domainTerms },
        },
        reasoning: 'Interpretation conflict: domain-specific terminology detected',
      };
    }
  }

  return { hasConflict: false, reasoning: 'No interpretation conflict detected' };
}

// ============================================
// Severity Assessment
// ============================================

function assessResourceConflictSeverity(actions: ProposedAction[]): ConflictSeverity {
  const priorities = actions.map(a => a.priority);

  if (priorities.includes('CRITICAL')) {
    return 'critical';
  }

  if (priorities.includes('HIGH')) {
    return 'high';
  }

  if (priorities.filter(p => p === 'MEDIUM').length >= 2) {
    return 'medium';
  }

  return 'low';
}

/**
 * Assess overall severity based on conflict type and context
 */
export function assessConflictSeverity(
  conflict: Omit<Conflict, 'severity'>
): ConflictSeverity {
  const { type, proposedActions } = conflict;

  // Critical severity conditions
  if (type === 'POLICY' && proposedActions.some(a => a.governanceLevel === 'APPROVER')) {
    return 'critical';
  }

  if (type === 'RESOURCE' && proposedActions.some(a => a.priority === 'CRITICAL')) {
    return 'critical';
  }

  // High severity conditions
  if (type === 'GOAL' && proposedActions.length > 2) {
    return 'high';
  }

  if (type === 'POLICY') {
    return 'high';
  }

  // Medium severity conditions
  if (type === 'RESOURCE') {
    return 'medium';
  }

  if (type === 'GOAL') {
    return 'medium';
  }

  // Low severity (interpretation conflicts are typically low)
  return 'low';
}

// ============================================
// Utility Functions
// ============================================

/**
 * Classify conflict type based on characteristics
 */
export function classifyConflict(
  characteristics: {
    involvesResources?: boolean;
    involvesPermissions?: boolean;
    involvesCompetingObjectives?: boolean;
    involvesTerminology?: boolean;
  }
): ConflictType {
  if (characteristics.involvesPermissions) {
    return 'POLICY';
  }

  if (characteristics.involvesResources) {
    return 'RESOURCE';
  }

  if (characteristics.involvesCompetingObjectives) {
    return 'GOAL';
  }

  if (characteristics.involvesTerminology) {
    return 'INTERPRETATION';
  }

  return 'GOAL'; // Default to GOAL conflict
}

/**
 * Generate a human-readable conflict summary
 */
export function formatConflictSummary(conflict: Conflict): string {
  const typeLabel = {
    GOAL: 'Goal Conflict',
    RESOURCE: 'Resource Conflict',
    POLICY: 'Policy Conflict',
    INTERPRETATION: 'Interpretation Conflict',
  };

  const severityEmoji = {
    low: '🟢',
    medium: '🟡',
    high: '🟠',
    critical: '🔴',
  };

  return `${severityEmoji[conflict.severity]} ${typeLabel[conflict.type]}: ${conflict.description} (Agents: ${conflict.involvedAgents.join(', ')})`;
}
