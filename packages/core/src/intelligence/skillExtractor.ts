/**
 * Skill Extractor — Automatically extracts reusable skills from successful executions.
 *
 * Used internally by the agent to learn from successful patterns.
 * Users see: "已记住这个解决方案" — they don't call this directly.
 *
 * Analyzes execution traces and extracts patterns that can be reused.
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface ExtractedSkill {
  id: string;
  name: string;
  description: string;
  category: 'code' | 'config' | 'deploy' | 'debug' | 'test' | 'other';
  pattern: string;           // What triggers this skill
  steps: string[];           // What steps to take
  tools: string[];           // What tools are used
  confidence: number;        // 0-1
  usageCount: number;
  successRate: number;
  lastUsed: string;
  createdAt: string;
  examples: Array<{
    task: string;
    result: string;
    tokens: number;
  }>;
}

export interface ExtractionResult {
  skills: ExtractedSkill[];
  summary: string;
}

// ============================================================================
// Skill Extractor
// ============================================================================

export class SkillExtractor {
  private skills: Map<string, ExtractedSkill> = new Map();
  private skillsPath: string;

  constructor(baseDir?: string) {
    this.skillsPath = baseDir
      ? `${baseDir}/extracted-skills.json`
      : '.commander/intelligence/extracted-skills.json';
    this.loadSkills();
  }

  private loadSkills(): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.skillsPath)) {
        const data = JSON.parse(fs.readFileSync(this.skillsPath, 'utf-8'));
        for (const skill of data) {
          this.skills.set(skill.id, skill);
        }
      }
    } catch { /* ignore */ }
  }

  private saveSkills(): void {
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.dirname(this.skillsPath), { recursive: true });
      fs.writeFileSync(this.skillsPath, JSON.stringify(Array.from(this.skills.values()), null, 2));
    } catch { /* ignore */ }
  }

  /**
   * Extract skills from a successful execution.
   */
  extract(params: {
    task: string;
    taskType: string;
    steps: Array<{ action: string; tool: string; result: string }>;
    tokens: number;
    success: boolean;
  }): ExtractionResult {
    if (!params.success) return { skills: [], summary: 'Task failed, no skills extracted' };

    const extracted: ExtractedSkill[] = [];

    // Extract pattern from task
    const pattern = this.extractPattern(params.task);
    const category = this.inferCategory(params.taskType, params.steps);

    // Check if similar skill already exists
    const existing = this.findSimilarSkill(pattern, category);
    if (existing) {
      // Update existing skill
      existing.usageCount++;
      existing.lastUsed = new Date().toISOString();
      existing.examples.push({
        task: params.task,
        result: 'success',
        tokens: params.tokens,
      });
      // Keep only last 10 examples
      if (existing.examples.length > 10) {
        existing.examples = existing.examples.slice(-10);
      }
      this.saveSkills();
      return { skills: [existing], summary: `Updated existing skill: ${existing.name}` };
    }

    // Extract steps
    const steps = params.steps.map(s => `${s.action}: ${s.tool}`);
    const tools = [...new Set(params.steps.map(s => s.tool))];

    // Create new skill
    const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const skill: ExtractedSkill = {
      id,
      name: this.generateSkillName(params.task, category),
      description: `Auto-extracted from: ${params.task}`,
      category,
      pattern,
      steps,
      tools,
      confidence: 0.5, // Initial confidence
      usageCount: 1,
      successRate: 1.0,
      lastUsed: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      examples: [{
        task: params.task,
        result: 'success',
        tokens: params.tokens,
      }],
    };

    this.skills.set(id, skill);
    this.saveSkills();

    return {
      skills: [skill],
      summary: `Extracted new skill: ${skill.name}`,
    };
  }

  /**
   * Find matching skill for a task.
   */
  findMatchingSkill(task: string): ExtractedSkill | undefined {
    const taskLower = task.toLowerCase();

    let bestMatch: ExtractedSkill | undefined;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      const score = this.calculateSimilarity(taskLower, skill.pattern.toLowerCase());
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }

  /**
   * Get all extracted skills.
   */
  getSkills(): ExtractedSkill[] {
    return Array.from(this.skills.values())
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  /**
   * Get skills by category.
   */
  getSkillsByCategory(category: ExtractedSkill['category']): ExtractedSkill[] {
    return Array.from(this.skills.values())
      .filter(s => s.category === category)
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  /**
   * Record skill usage (success or failure).
   */
  recordUsage(skillId: string, success: boolean): void {
    const skill = this.skills.get(skillId);
    if (!skill) return;

    skill.usageCount++;
    skill.lastUsed = new Date().toISOString();

    // Update success rate with exponential moving average
    const alpha = 0.1;
    skill.successRate = skill.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;

    // Update confidence based on usage and success rate
    skill.confidence = Math.min(1, 0.5 + (skill.usageCount * 0.02) + (skill.successRate * 0.3));

    this.saveSkills();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private extractPattern(task: string): string {
    // Extract key action words
    const actionWords = ['create', 'build', 'fix', 'deploy', 'test', 'refactor', 'add', 'update', 'delete', 'configure', 'setup', 'install'];
    const words = task.toLowerCase().split(/\s+/);
    const actions = words.filter(w => actionWords.includes(w));
    const nouns = words.filter(w => w.length > 3 && !actionWords.includes(w));

    return [...actions, ...nouns].slice(0, 5).join(' ');
  }

  private inferCategory(taskType: string, steps: Array<{ tool: string }>): ExtractedSkill['category'] {
    const tools = steps.map(s => s.tool).join(' ').toLowerCase();
    const type = taskType.toLowerCase();

    if (type.includes('coding') || tools.includes('file_write') || tools.includes('apply_patch')) return 'code';
    if (type.includes('test') || tools.includes('test')) return 'test';
    if (type.includes('deploy') || tools.includes('deploy')) return 'deploy';
    if (type.includes('debug') || tools.includes('shell_execute')) return 'debug';
    if (type.includes('config')) return 'config';
    return 'other';
  }

  private findSimilarSkill(pattern: string, category: ExtractedSkill['category']): ExtractedSkill | undefined {
    for (const skill of this.skills.values()) {
      if (skill.category !== category) continue;
      if (this.calculateSimilarity(pattern, skill.pattern) > 0.5) {
        return skill;
      }
    }
    return undefined;
  }

  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private generateSkillName(task: string, category: ExtractedSkill['category']): string {
    const words = task.split(/\s+/).slice(0, 4).join(' ');
    return `${category}: ${words}`;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultExtractor: SkillExtractor | null = null;

export function getSkillExtractor(): SkillExtractor {
  if (!defaultExtractor) {
    defaultExtractor = new SkillExtractor();
  }
  return defaultExtractor;
}
