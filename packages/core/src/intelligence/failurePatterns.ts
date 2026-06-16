/**
 * Failure Pattern Learning — Learns from user's past failures.
 *
 * Used internally by the agent to warn users about repeated mistakes.
 * Users see: "上次你在这里踩过坑" — they don't call this directly.
 *
 * Tracks failure patterns and provides proactive warnings.
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface FailurePattern {
  id: string;
  pattern: string; // e.g., "deploy without migration"
  category: 'deploy' | 'test' | 'config' | 'dependency' | 'security' | 'other';
  description: string; // Human-readable description
  occurrences: Array<{
    timestamp: string;
    context: string; // What was happening
    resolution?: string; // How it was fixed
  }>;
  lastOccurrence: string;
  confidence: number; // 0-1, how confident we are this is a real pattern
  autoWarn: boolean; // Should we warn automatically?
}

export interface FailureWarning {
  pattern: FailurePattern;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

// ============================================================================
// Failure Pattern Learner
// ============================================================================

export class FailurePatternLearner {
  private patterns: Map<string, FailurePattern> = new Map();
  private patternsPath: string;

  constructor(baseDir?: string) {
    this.patternsPath = baseDir
      ? `${baseDir}/failure-patterns.json`
      : '.commander/intelligence/failure-patterns.json';
    this.loadPatterns();
  }

  private loadPatterns(): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.patternsPath)) {
        const data = JSON.parse(fs.readFileSync(this.patternsPath, 'utf-8'));
        for (const p of data) {
          this.patterns.set(p.id, p);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private savePatterns(): void {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.dirname(this.patternsPath), { recursive: true });
      fs.writeFileSync(
        this.patternsPath,
        JSON.stringify(Array.from(this.patterns.values()), null, 2),
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * Record a failure event.
   */
  recordFailure(params: {
    task: string;
    error: string;
    context: string;
    resolution?: string;
    category?: FailurePattern['category'];
  }): void {
    // Try to match existing pattern
    const existing = this.findMatchingPattern(params.task, params.error);

    if (existing) {
      // Update existing pattern
      existing.occurrences.push({
        timestamp: new Date().toISOString(),
        context: params.context,
        resolution: params.resolution,
      });
      existing.lastOccurrence = new Date().toISOString();
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.autoWarn = existing.occurrences.length >= 2;
    } else {
      // Create new pattern
      const id = `fp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const pattern: FailurePattern = {
        id,
        pattern: this.extractPattern(params.task, params.error),
        category: params.category ?? this.inferCategory(params.task, params.error),
        description: `${params.task}: ${params.error}`,
        occurrences: [
          {
            timestamp: new Date().toISOString(),
            context: params.context,
            resolution: params.resolution,
          },
        ],
        lastOccurrence: new Date().toISOString(),
        confidence: 0.3,
        autoWarn: false,
      };
      this.patterns.set(id, pattern);
    }

    this.savePatterns();
  }

  /**
   * Record a successful resolution.
   */
  recordResolution(patternId: string, resolution: string): void {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return;

    const lastOccurrence = pattern.occurrences[pattern.occurrences.length - 1];
    if (lastOccurrence) {
      lastOccurrence.resolution = resolution;
    }
    this.savePatterns();
  }

  /**
   * Check if current task might trigger a known failure pattern.
   */
  checkWarnings(task: string, context?: string): FailureWarning[] {
    const warnings: FailureWarning[] = [];

    for (const pattern of this.patterns.values()) {
      if (!pattern.autoWarn) continue;

      const similarity = this.calculateSimilarity(task, pattern.pattern);
      if (similarity < 0.3) continue;

      // Check if this pattern was already resolved recently
      const lastOccurrence = pattern.occurrences[pattern.occurrences.length - 1];
      if (lastOccurrence?.resolution) {
        const lastResolution = new Date(lastOccurrence.timestamp).getTime();
        const hoursSinceResolution = (Date.now() - lastResolution) / (1000 * 60 * 60);
        if (hoursSinceResolution < 24) continue; // Don't warn if resolved in last 24h
      }

      const severity =
        pattern.occurrences.length >= 5
          ? 'high'
          : pattern.occurrences.length >= 3
            ? 'medium'
            : 'low';
      const suggestion = this.generateSuggestion(pattern);

      warnings.push({ pattern, suggestion, severity });
    }

    return warnings.sort((a, b) => {
      const severityOrder = { high: 3, medium: 2, low: 1 };
      return severityOrder[b.severity] - severityOrder[a.severity];
    });
  }

  /**
   * Get all patterns (for display).
   */
  getPatterns(): FailurePattern[] {
    return Array.from(this.patterns.values()).sort(
      (a, b) => new Date(b.lastOccurrence).getTime() - new Date(a.lastOccurrence).getTime(),
    );
  }

  /**
   * Get pattern by ID.
   */
  getPattern(id: string): FailurePattern | undefined {
    return this.patterns.get(id);
  }

  /**
   * Clear old patterns.
   */
  cleanup(keepDays: number = 90): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [id, pattern] of this.patterns) {
      if (new Date(pattern.lastOccurrence).getTime() < cutoff) {
        this.patterns.delete(id);
        removed++;
      }
    }

    if (removed > 0) this.savePatterns();
    return removed;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private findMatchingPattern(task: string, error: string): FailurePattern | undefined {
    const taskLower = task.toLowerCase();
    const errorLower = error.toLowerCase();

    for (const pattern of this.patterns.values()) {
      const patternLower = pattern.pattern.toLowerCase();
      const descLower = pattern.description.toLowerCase();

      // Check if task or error matches existing pattern
      if (
        this.calculateSimilarity(taskLower, patternLower) > 0.5 ||
        this.calculateSimilarity(errorLower, descLower) > 0.5
      ) {
        return pattern;
      }
    }

    return undefined;
  }

  private extractPattern(task: string, error: string): string {
    // Extract key words from task and error
    const taskWords = task
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const errorWords = error
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    return [...new Set([...taskWords, ...errorWords])].slice(0, 5).join(' ');
  }

  private inferCategory(task: string, error: string): FailurePattern['category'] {
    const text = `${task} ${error}`.toLowerCase();
    if (text.includes('deploy') || text.includes('production')) return 'deploy';
    if (text.includes('test') || text.includes('spec')) return 'test';
    if (text.includes('config') || text.includes('env')) return 'config';
    if (text.includes('depend') || text.includes('package') || text.includes('npm'))
      return 'dependency';
    if (text.includes('security') || text.includes('vulnerability')) return 'security';
    return 'other';
  }

  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private generateSuggestion(pattern: FailurePattern): string {
    const lastResolution = pattern.occurrences.reverse().find((o) => o.resolution)?.resolution;

    if (lastResolution) {
      return `上次的解决方案: ${lastResolution}`;
    }

    switch (pattern.category) {
      case 'deploy':
        return '建议先检查数据库迁移和环境变量';
      case 'test':
        return '建议先运行测试确认当前状态';
      case 'config':
        return '建议检查配置文件和环境变量';
      case 'dependency':
        return '建议检查依赖版本和兼容性';
      case 'security':
        return '建议运行安全扫描';
      default:
        return '建议仔细检查后再继续';
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultLearner: FailurePatternLearner | null = null;

export function getFailurePatternLearner(): FailurePatternLearner {
  if (!defaultLearner) {
    defaultLearner = new FailurePatternLearner();
  }
  return defaultLearner;
}
