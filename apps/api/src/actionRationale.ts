/**
 * Action Rationale Tracking Module
 * 
 * Records "why" an action was taken, not just "what" was done.
 * Part of the Explainability & Transparency layer for Commander.
 * 
 * Key concepts:
 * - ActionRationale: The reasoning behind a single action
 * - ConfidenceLevel: How confident the agent was in this decision
 * - AlternativeOption: Options considered but not executed
 * - ActionAuditLog: Complete audit trail for accountability
 */

import fs from 'fs';
import path from 'path';

export interface ActionRationale {
  id: string;
  timestamp: string;
  projectId: string;
  missionId: string;
  agentId: string;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  
  // Core explainability fields
  rationale: string;                    // "Why" this action was chosen
  confidence: ConfidenceLevel;          // How confident the agent was
  triggerSource: ActionTriggerSource;   // What triggered this action
  goalContext: string;                  // The goal this action serves
  
  // Alternatives considered
  alternatives?: AlternativeOption[];
  
  // Data sources used in this decision
  dataSources?: string[];
  
  // Chain of reasoning (for multi-step decisions)
  reasoningChain?: ReasoningStep[];
  
  // Outcome tracking (filled after execution)
  outcome?: ActionOutcome;
}

export interface ConfidenceLevel {
  score: number;          // 0.0 - 1.0
  level: 'low' | 'medium' | 'high' | 'very-high';
  factors?: string[];     // What influenced this confidence
}

export interface AlternativeOption {
  description: string;
  rejectedReason: string;
  estimatedOutcome?: string;
}

export interface ReasoningStep {
  step: number;
  thought: string;
  evidence?: string;
}

export interface ActionOutcome {
  success: boolean;
  result?: string;
  sideEffects?: string[];
  followUpActions?: string[];
}

export type ActionTriggerSource = 
  | 'user-request'
  | 'mission-decomposition'
  | 'dependency-resolved'
  | 'conflict-detected'
  | 'governance-checkpoint'
  | 'scheduled'
  | 'agent-initiated'
  | 'error-recovery';

/**
 * Action Rationale Store
 * 
 * Persists action rationales for audit and explainability.
 * Supports querying by mission, agent, or time range.
 */
export class ActionRationaleStore {
  private items: ActionRationale[];
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(__dirname, '../data/action-rationales.json');
    this.items = this.load();
  }

  /**
   * Record a new action rationale
   */
  record(input: CreateActionRationaleInput): ActionRationale {
    const now = new Date().toISOString();
    
    const rationale: ActionRationale = {
      id: this.generateId(),
      timestamp: now,
      projectId: input.projectId,
      missionId: input.missionId,
      agentId: input.agentId,
      actionType: input.actionType,
      actionPayload: input.actionPayload,
      rationale: input.rationale,
      confidence: this.calculateConfidenceLevel(input.confidenceScore),
      triggerSource: input.triggerSource,
      goalContext: input.goalContext,
      alternatives: input.alternatives,
      dataSources: input.dataSources,
      reasoningChain: input.reasoningChain,
    };

    this.items.push(rationale);
    this.persist();
    
    return rationale;
  }

  /**
   * Get all rationales for a mission
   */
  getByMission(missionId: string): ActionRationale[] {
    return this.items.filter(item => item.missionId === missionId)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Get all rationales for an agent
   */
  getByAgent(projectId: string, agentId: string): ActionRationale[] {
    return this.items.filter(item => 
      item.projectId === projectId && item.agentId === agentId
    ).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Get rationales in a time range
   */
  getByTimeRange(start: Date, end: Date): ActionRationale[] {
    return this.items.filter(item => {
      const ts = new Date(item.timestamp);
      return ts >= start && ts <= end;
    }).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Get a single rationale by ID
   */
  get(id: string): ActionRationale | undefined {
    return this.items.find(item => item.id === id);
  }

  /**
   * Update outcome after action execution
   */
  updateOutcome(id: string, outcome: ActionOutcome): ActionRationale | undefined {
    const rationale = this.get(id);
    if (rationale) {
      rationale.outcome = outcome;
      this.persist();
    }
    return rationale;
  }

  /**
   * Generate explainability report for a mission
   */
  generateMissionReport(missionId: string): MissionExplainabilityReport {
    const rationales = this.getByMission(missionId);
    
    if (rationales.length === 0) {
      return {
        missionId,
        totalActions: 0,
        summary: 'No actions recorded for this mission',
        confidenceDistribution: { low: 0, medium: 0, high: 0, 'very-high': 0 },
        actionBreakdown: {},
        decisionPoints: [],
      };
    }

    // Calculate confidence distribution
    const confidenceDistribution = {
      low: rationales.filter(r => r.confidence.level === 'low').length,
      medium: rationales.filter(r => r.confidence.level === 'medium').length,
      high: rationales.filter(r => r.confidence.level === 'high').length,
      'very-high': rationales.filter(r => r.confidence.level === 'very-high').length,
    };

    // Action type breakdown
    const actionBreakdown: Record<string, number> = {};
    for (const r of rationales) {
      actionBreakdown[r.actionType] = (actionBreakdown[r.actionType] || 0) + 1;
    }

    // Key decision points (high complexity or alternatives)
    const decisionPoints = rationales
      .filter(r => r.alternatives && r.alternatives.length > 0)
      .map(r => ({
        actionId: r.id,
        actionType: r.actionType,
        rationale: r.rationale,
        alternativesCount: r.alternatives!.length,
        chosenAlternative: r.rationale,
      }));

    return {
      missionId,
      totalActions: rationales.length,
      summary: this.generateSummary(rationales),
      confidenceDistribution,
      actionBreakdown,
      decisionPoints,
      timeline: rationales.map(r => ({
        timestamp: r.timestamp,
        agentId: r.agentId,
        actionType: r.actionType,
        rationale: r.rationale,
        confidence: r.confidence.level,
      })),
    };
  }

  /**
   * Clean up old rationales (retain last N days)
   */
  cleanup(retentionDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    
    const before = this.items.length;
    this.items = this.items.filter(item => new Date(item.timestamp) >= cutoff);
    const removed = before - this.items.length;
    
    if (removed > 0) {
      this.persist();
    }
    
    return removed;
  }

  // Private methods

  private load(): ActionRationale[] {
    if (!fs.existsSync(this.filePath)) {
      this.write([]);
      return [];
    }
    
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    this.write(this.items);
  }

  private write(items: ActionRationale[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2));
  }

  private generateId(): string {
    return `ar_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private calculateConfidenceLevel(score: number): ConfidenceLevel {
    let level: ConfidenceLevel['level'];
    if (score >= 0.9) level = 'very-high';
    else if (score >= 0.7) level = 'high';
    else if (score >= 0.4) level = 'medium';
    else level = 'low';

    return { score, level };
  }

  private generateSummary(rationales: ActionRationale[]): string {
    const total = rationales.length;
    const avgConfidence = rationales.reduce((sum, r) => sum + r.confidence.score, 0) / total;
    const uniqueAgents = new Set(rationales.map(r => r.agentId)).size;
    
    return `Mission completed with ${total} actions across ${uniqueAgents} agent(s). ` +
           `Average decision confidence: ${(avgConfidence * 100).toFixed(1)}%. ` +
           `${rationales.filter(r => r.alternatives && r.alternatives.length > 0).length} decisions involved alternatives.`;
  }
}

export interface CreateActionRationaleInput {
  projectId: string;
  missionId: string;
  agentId: string;
  actionType: string;
  actionPayload?: Record<string, unknown>;
  rationale: string;
  confidenceScore: number;
  triggerSource: ActionTriggerSource;
  goalContext: string;
  alternatives?: AlternativeOption[];
  dataSources?: string[];
  reasoningChain?: ReasoningStep[];
}

export interface MissionExplainabilityReport {
  missionId: string;
  totalActions: number;
  summary: string;
  confidenceDistribution: {
    low: number;
    medium: number;
    high: number;
    'very-high': number;
  };
  actionBreakdown: Record<string, number>;
  decisionPoints: Array<{
    actionId: string;
    actionType: string;
    rationale: string;
    alternativesCount: number;
    chosenAlternative: string;
  }>;
  timeline?: Array<{
    timestamp: string;
    agentId: string;
    actionType: string;
    rationale: string;
    confidence: string;
  }>;
}

/**
 * Helper function to create a quick rationale
 */
export function quickRationale(
  projectId: string,
  missionId: string,
  agentId: string,
  actionType: string,
  rationale: string,
  confidenceScore: number,
  triggerSource: ActionTriggerSource,
  goalContext: string,
): CreateActionRationaleInput {
  return {
    projectId,
    missionId,
    agentId,
    actionType,
    rationale,
    confidenceScore,
    triggerSource,
    goalContext,
  };
}
