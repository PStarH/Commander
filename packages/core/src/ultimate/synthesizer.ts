import type {
  SynthesisStrategy,
  SynthesisConfig,
  ArtifactReference,
  TaskTreeNode,
  QualityGateConfig,
} from './types';
import { getArtifactSystem } from './artifactSystem';

export class MultiAgentSynthesizer {
  private artifactSystem = getArtifactSystem();

  async synthesize(
    strategy: SynthesisStrategy,
    config: SynthesisConfig,
    taskTree: TaskTreeNode,
    artifacts: ArtifactReference[],
  ): Promise<{
    synthesis: string;
    artifactsUsed: string[];
    qualityScore: number;
    gateResults: Array<{ gate: string; passed: boolean; score: number }>;
  }> {
    const artifactsUsed: string[] = [];

    let synthesis: string;
    switch (strategy) {
      case 'LEAD_SYNTHESIS':
        synthesis = await this.leadSynthesis(taskTree, artifacts, config);
        break;
      case 'HIERARCHICAL':
        synthesis = await this.hierarchicalSynthesis(taskTree, config);
        break;
      case 'VOTE':
        synthesis = await this.voteSynthesis(taskTree, artifacts, config);
        break;
      case 'ENSEMBLE':
        synthesis = await this.ensembleSynthesis(taskTree, artifacts, config);
        break;
      default:
        synthesis = await this.leadSynthesis(taskTree, artifacts, config);
    }

    for (const artifact of artifacts) {
      artifactsUsed.push(artifact.id);
    }

    const gateResults = await this.runQualityGates(config.qualityGates, synthesis, taskTree);
    const qualityScore = gateResults.reduce((acc, g) => acc + (g.passed ? g.score : 0), 0)
      / Math.max(1, gateResults.length);

    return {
      synthesis,
      artifactsUsed,
      qualityScore,
      gateResults,
    };
  }

  private async leadSynthesis(
    taskTree: TaskTreeNode,
    artifacts: ArtifactReference[],
    config: SynthesisConfig,
  ): Promise<string> {
    const completedNodes = this.collectCompleted(taskTree);
    const parts: string[] = [];

    parts.push('# Synthesis\n');
    parts.push(`Synthesized from ${completedNodes.length} completed nodes across ${artifacts.length} artifacts.\n`);

    for (const node of completedNodes) {
      if (node.result) {
        const depth = this.getDepth(node, taskTree);
        const prefix = depth > 0 ? '  '.repeat(depth) : '';
        parts.push(`${prefix}## ${node.goal.slice(0, 100)}\n`);
        parts.push(`${prefix}${node.result}\n`);
      }
    }

    if (config.includeDissent) {
      const failedNodes = this.collectFailed(taskTree);
      if (failedNodes.length > 0) {
        parts.push('\n## Limitations\n');
        parts.push(`Note: ${failedNodes.length} subtasks encountered issues.`);
        for (const node of failedNodes) {
          parts.push(`- ${node.goal.slice(0, 100)}: not completed`);
        }
      }
    }

    const enriched = artifacts.length > 0
      ? parts.join('\n')
      : parts.join('\n');

    return enriched;
  }

  private async hierarchicalSynthesis(
    node: TaskTreeNode,
    config: SynthesisConfig,
  ): Promise<string> {
    if (node.isAtomic || node.subtasks.length === 0) {
      return node.result ?? `No result for: ${node.goal.slice(0, 100)}`;
    }

    const childResults: string[] = [];
    for (const child of node.subtasks) {
      const childResult = await this.hierarchicalSynthesis(child, config);
      if (childResult) {
        childResults.push(`### ${child.goal.slice(0, 80)}\n${childResult}`);
      }
    }

    const combined = childResults.join('\n\n');
    if (node.result) {
      return `${node.result}\n\n${combined}`;
    }
    return combined || `No results from subtasks of: ${node.goal.slice(0, 100)}`;
  }

  private async voteSynthesis(
    taskTree: TaskTreeNode,
    artifacts: ArtifactReference[],
    config: SynthesisConfig,
  ): Promise<string> {
    const completed = this.collectCompleted(taskTree);
    if (completed.length === 0) return 'No completed results to synthesize.';

    const results = completed.map(n => n.result ?? '').filter(Boolean);
    return results.join('\n\n---\n\n');
  }

  private async ensembleSynthesis(
    taskTree: TaskTreeNode,
    artifacts: ArtifactReference[],
    config: SynthesisConfig,
  ): Promise<string> {
    const completed = this.collectCompleted(taskTree);
    if (completed.length === 0) return 'No completed results to synthesize.';

    const results = completed
      .map(n => ({ text: n.result ?? '', depth: this.getDepth(n, taskTree) }))
      .filter(r => r.text.length > 0)
      .sort((a, b) => a.depth - b.depth);

    const sections = results.map(r => r.text);
    return sections.join('\n\n');
  }

  async runQualityGatesStrict(
    gates: QualityGateConfig[],
    synthesis: string,
    taskTree: TaskTreeNode,
  ): Promise<Array<{ gate: string; passed: boolean; score: number }>> {
    return this.runQualityGates(gates, synthesis, taskTree);
  }

  private async runQualityGates(
    gates: QualityGateConfig[],
    synthesis: string,
    taskTree: TaskTreeNode,
  ): Promise<Array<{ gate: string; passed: boolean; score: number }>> {
    const results: Array<{ gate: string; passed: boolean; score: number }> = [];

    for (const gate of gates) {
      if (!gate.enabled) continue;

      let score = 0;
      switch (gate.type) {
        case 'HALLUCINATION_CHECK':
          score = this.checkHallucination(synthesis);
          break;
        case 'CONSISTENCY':
          score = this.checkConsistency(synthesis, taskTree);
          break;
        case 'COMPLETENESS':
          score = this.checkCompleteness(synthesis, taskTree);
          break;
        case 'ACCURACY':
          score = this.checkAccuracy(synthesis);
          break;
        case 'SAFETY':
          score = this.checkSafety(synthesis);
          break;
      }

      results.push({
        gate: gate.name,
        passed: score >= gate.threshold,
        score,
      });
    }

    return results;
  }

  private checkHallucination(synthesis: string): number {
    let score = 1.0;

    const hallucinationSignals = [
      /\b(unverified|unsourced|allegedly|reportedly|supposedly)\b/i,
      /\b(as of my last|as of my knowledge cutoff)\b/i,
      /\b(I don't have|I cannot|I'm not able)\b/i,
      /\b(it is important to note that it is important)\b/i,
    ];

    for (const signal of hallucinationSignals) {
      if (signal.test(synthesis)) {
        score -= 0.1;
      }
    }

    return Math.max(0, score);
  }

  private checkConsistency(synthesis: string, taskTree: TaskTreeNode): number {
    let score = 1.0;
    const contradictions = [
      ['on one hand', 'on the other hand'],
      ['however', 'nevertheless'],
      ['but', 'although'],
    ];

    for (const [a, b] of contradictions) {
      if (synthesis.toLowerCase().includes(a) && synthesis.toLowerCase().includes(b)) {
        score -= 0.05;
      }
    }

    const completed = this.collectCompleted(taskTree);
    const hasResults = completed.filter(n => n.result && n.result.length > 20).length;
    if (completed.length > 0 && hasResults < completed.length) {
      score -= 0.2;
    }

    return Math.max(0, score);
  }

  private checkCompleteness(synthesis: string, taskTree: TaskTreeNode): number {
    const completed = this.collectCompleted(taskTree);
    const total = this.countAllNodes(taskTree);
    const completionRatio = total > 0 ? completed.length / total : 1;

    const minLength = 50;
    const lengthScore = synthesis.length > minLength
      ? Math.min(1, synthesis.length / (minLength * 10))
      : 0;

    return completionRatio * 0.6 + lengthScore * 0.4;
  }

  private checkAccuracy(synthesis: string): number {
    let score = 1.0;

    const uncertaintyPhrases = [
      'might be', 'could be', 'possibly', 'perhaps',
      'not sure', 'unclear', 'unknown', 'insufficient',
    ];
    for (const phrase of uncertaintyPhrases) {
      if (synthesis.toLowerCase().includes(phrase)) {
        score -= 0.05;
      }
    }

    if (synthesis.includes('[citation needed]')) score -= 0.2;
    if (synthesis.includes('[source missing]')) score -= 0.2;

    return Math.max(0, score);
  }

  private checkSafety(synthesis: string): number {
    let score = 1.0;

    const unsafePatterns = [
      /(bypass|circumvent|evade)\s+(security|safety|restriction|control)/i,
      /(malicious|harmful|dangerous)\s+(code|script|command|payload)/i,
      /(exploit|vulnerability)\s+(in|for)\s+(production|live|deployed)/i,
    ];

    for (const pattern of unsafePatterns) {
      if (pattern.test(synthesis)) {
        score -= 0.3;
      }
    }

    if (synthesis.length > 10000) score -= 0.1;

    return Math.max(0, score);
  }

  private collectCompleted(node: TaskTreeNode): TaskTreeNode[] {
    const completed: TaskTreeNode[] = [];
    if (node.status === 'COMPLETED' && node.result) {
      completed.push(node);
    }
    for (const sub of node.subtasks) {
      completed.push(...this.collectCompleted(sub));
    }
    return completed;
  }

  private collectFailed(node: TaskTreeNode): TaskTreeNode[] {
    const failed: TaskTreeNode[] = [];
    if (node.status === 'FAILED') {
      failed.push(node);
    }
    for (const sub of node.subtasks) {
      failed.push(...this.collectFailed(sub));
    }
    return failed;
  }

  private countAllNodes(node: TaskTreeNode): number {
    let count = 1;
    for (const sub of node.subtasks) {
      count += this.countAllNodes(sub);
    }
    return count;
  }

  private getDepth(node: TaskTreeNode, root: TaskTreeNode, currentDepth = 0): number {
    if (node.id === root.id) return currentDepth;
    for (const sub of root.subtasks) {
      if (node.id === sub.id) return currentDepth + 1;
      const depth = this.getDepth(node, sub, currentDepth + 1);
      if (depth > 0) return depth;
    }
    return 0;
  }
}
