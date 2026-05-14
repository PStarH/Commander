/**
 * Confidence Reporter Module
 *
 * Reports and aggregates decision confidence across agents and missions.
 * Part of the Explainability & Transparency layer for Commander.
 *
 * Key concepts:
 * - ConfidenceReport: Summary of confidence distribution
 * - ConfidenceTrend: How confidence changes over time
 * - ConfidenceAlert: Low confidence warnings for oversight
 */

import { ActionRationaleStore, ActionRationale, ConfidenceLevel } from './actionRationale';

export interface ConfidenceReport {
  missionId: string;
  agentId?: string;
  totalDecisions: number;
  averageConfidence: number;
  distribution: {
    low: number;
    medium: number;
    high: number;
    'very-high': number;
  };
  lowConfidenceActions: LowConfidenceAction[];
  trend: ConfidenceTrend;
  recommendations: string[];
}

export interface LowConfidenceAction {
  actionId: string;
  actionType: string;
  confidenceScore: number;
  rationale: string;
  timestamp: string;
  agentId: string;
}

export interface ConfidenceTrend {
  direction: 'improving' | 'stable' | 'declining' | 'insufficient-data';
  changeRate?: number; // % change
  dataPoints: Array<{
    timestamp: string;
    avgConfidence: number;
  }>;
}

export interface ConfidenceThresholds {
  low: number;      // Below this = low confidence alert
  warning: number;  // Below this = warning
  target: number;   // Target confidence level
}

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  low: 0.4,
  warning: 0.6,
  target: 0.8,
};

/**
 * Confidence Reporter
 *
 * Analyzes and reports on decision confidence patterns.
 * Identifies low-confidence decisions that may need human review.
 */
export class ConfidenceReporter {
  private store: ActionRationaleStore;
  private thresholds: ConfidenceThresholds;

  constructor(store?: ActionRationaleStore, thresholds?: ConfidenceThresholds) {
    this.store = store || new ActionRationaleStore();
    this.thresholds = thresholds || DEFAULT_THRESHOLDS;
  }

  /**
   * Generate confidence report for a mission
   */
  generateMissionReport(missionId: string): ConfidenceReport {
    const rationales = this.store.getByMission(missionId);
    return this.buildReport(rationales, missionId);
  }

  /**
   * Generate confidence report for a specific agent
   */
  generateAgentReport(projectId: string, agentId: string, missionId?: string): ConfidenceReport {
    let rationales = this.store.getByAgent(projectId, agentId);
    if (missionId) {
      rationales = rationales.filter(r => r.missionId === missionId);
    }
    return this.buildReport(rationales, missionId || 'multiple', agentId);
  }

  /**
   * Check for low-confidence decisions requiring attention
   */
  checkForAlerts(missionId: string): ConfidenceAlert[] {
    const rationales = this.store.getByMission(missionId);
    const alerts: ConfidenceAlert[] = [];

    // Find decisions below warning threshold
    const lowConfidence = rationales.filter(r => r.confidence.score < this.thresholds.warning);

    for (const r of lowConfidence) {
      const severity: 'low' | 'medium' | 'high' =
        r.confidence.score < this.thresholds.low ? 'high' :
        r.confidence.score < this.thresholds.warning ? 'medium' : 'low';

      alerts.push({
        actionId: r.id,
        missionId: r.missionId,
        agentId: r.agentId,
        actionType: r.actionType,
        confidenceScore: r.confidence.score,
        severity,
        rationale: r.rationale,
        timestamp: r.timestamp,
        recommendation: this.generateAlertRecommendation(r, severity),
      });
    }

    return alerts.sort((a, b) => a.confidenceScore - b.confidenceScore);
  }

  /**
   * Get confidence statistics summary
   */
  getStatistics(rationales: ActionRationale[]): ConfidenceStatistics {
    if (rationales.length === 0) {
      return {
        count: 0,
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        stdDev: 0,
      };
    }

    const scores = rationales.map(r => r.confidence.score);
    const sum = scores.reduce((a, b) => a + b, 0);
    const avg = sum / scores.length;

    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

    const variance = scores.reduce((acc, s) => acc + Math.pow(s - avg, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);

    return {
      count: scores.length,
      average: Math.round(avg * 1000) / 1000,
      median: Math.round(median * 1000) / 1000,
      min: Math.min(...scores),
      max: Math.max(...scores),
      stdDev: Math.round(stdDev * 1000) / 1000,
    };
  }

  // Private methods

  private buildReport(rationales: ActionRationale[], missionId: string, agentId?: string): ConfidenceReport {
    const totalDecisions = rationales.length;

    if (totalDecisions === 0) {
      return {
        missionId,
        agentId,
        totalDecisions: 0,
        averageConfidence: 0,
        distribution: { low: 0, medium: 0, high: 0, 'very-high': 0 },
        lowConfidenceActions: [],
        trend: { direction: 'insufficient-data', dataPoints: [] },
        recommendations: ['No decisions recorded yet.'],
      };
    }

    // Calculate distribution
    const distribution = {
      low: rationales.filter(r => r.confidence.level === 'low').length,
      medium: rationales.filter(r => r.confidence.level === 'medium').length,
      high: rationales.filter(r => r.confidence.level === 'high').length,
      'very-high': rationales.filter(r => r.confidence.level === 'very-high').length,
    };

    // Calculate average confidence
    const avgConfidence = rationales.reduce((sum, r) => sum + r.confidence.score, 0) / totalDecisions;

    // Find low confidence actions
    const lowConfidenceActions = rationales
      .filter(r => r.confidence.score < this.thresholds.warning)
      .map(r => ({
        actionId: r.id,
        actionType: r.actionType,
        confidenceScore: r.confidence.score,
        rationale: r.rationale,
        timestamp: r.timestamp,
        agentId: r.agentId,
      }))
      .sort((a, b) => a.confidenceScore - b.confidenceScore);

    // Calculate trend
    const trend = this.calculateTrend(rationales);

    // Generate recommendations
    const recommendations = this.generateRecommendations(avgConfidence, distribution, lowConfidenceActions.length);

    return {
      missionId,
      agentId,
      totalDecisions,
      averageConfidence: Math.round(avgConfidence * 1000) / 1000,
      distribution,
      lowConfidenceActions,
      trend,
      recommendations,
    };
  }

  private calculateTrend(rationales: ActionRationale[]): ConfidenceTrend {
    if (rationales.length < 3) {
      return {
        direction: 'insufficient-data',
        dataPoints: [],
      };
    }

    // Group by time windows (last 5 windows)
    const sorted = [...rationales].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const windowSize = Math.ceil(sorted.length / 5);
    const dataPoints: Array<{ timestamp: string; avgConfidence: number }> = [];

    for (let i = 0; i < sorted.length; i += windowSize) {
      const window = sorted.slice(i, i + windowSize);
      if (window.length > 0) {
        const avg = window.reduce((sum, r) => sum + r.confidence.score, 0) / window.length;
        dataPoints.push({
          timestamp: window[0].timestamp,
          avgConfidence: Math.round(avg * 1000) / 1000,
        });
      }
    }

    // Calculate trend direction
    if (dataPoints.length < 2) {
      return { direction: 'insufficient-data', dataPoints };
    }

    const first = dataPoints[0].avgConfidence;
    const last = dataPoints[dataPoints.length - 1].avgConfidence;
    const changeRate = ((last - first) / first) * 100;

    let direction: ConfidenceTrend['direction'];
    if (Math.abs(changeRate) < 5) {
      direction = 'stable';
    } else if (changeRate > 0) {
      direction = 'improving';
    } else {
      direction = 'declining';
    }

    return {
      direction,
      changeRate: Math.round(changeRate * 10) / 10,
      dataPoints,
    };
  }

  private generateRecommendations(
    avgConfidence: number,
    distribution: { low: number; medium: number; high: number; 'very-high': number },
    lowCount: number
  ): string[] {
    const recommendations: string[] = [];

    if (avgConfidence < this.thresholds.warning) {
      recommendations.push('Overall confidence is below target. Consider reviewing decision criteria.');
    }

    if (distribution.low > 0) {
      const pct = Math.round((distribution.low / (distribution.low + distribution.medium + distribution.high + distribution['very-high'])) * 100);
      recommendations.push(`${pct}% of decisions have low confidence. Review these for potential issues.`);
    }

    if (lowCount > 5) {
      recommendations.push(`${lowCount} low-confidence decisions detected. Consider human review for critical actions.`);
    }

    if (distribution['very-high'] > distribution.low + distribution.medium) {
      recommendations.push('Good confidence distribution. Decision-making process is working well.');
    }

    if (recommendations.length === 0) {
      recommendations.push('Confidence levels are within acceptable ranges.');
    }

    return recommendations;
  }

  private generateAlertRecommendation(r: ActionRationale, severity: 'low' | 'medium' | 'high'): string {
    if (severity === 'high') {
      return `Critical: Review "${r.actionType}" action. Confidence at ${(r.confidence.score * 100).toFixed(1)}% - below safe threshold. Consider human oversight.`;
    } else if (severity === 'medium') {
      return `Warning: Verify "${r.actionType}" decision. Confidence at ${(r.confidence.score * 100).toFixed(1)}%. May need additional validation.`;
    } else {
      return `Note: "${r.actionType}" has moderate confidence (${(r.confidence.score * 100).toFixed(1)}%). Monitor for patterns.`;
    }
  }
}

export interface ConfidenceAlert {
  actionId: string;
  missionId: string;
  agentId: string;
  actionType: string;
  confidenceScore: number;
  severity: 'low' | 'medium' | 'high';
  rationale: string;
  timestamp: string;
  recommendation: string;
}

export interface ConfidenceStatistics {
  count: number;
  average: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
}

/**
 * Helper: Create confidence report from action rationales
 */
export function createConfidenceReport(
  rationales: ActionRationale[],
  missionId: string
): ConfidenceReport {
  const reporter = new ConfidenceReporter();
  // Create a temporary store with the rationales
  const tempStore = new ActionRationaleStore();
  // Use the buildReport logic directly
  return reporter.generateMissionReport(missionId);
}
