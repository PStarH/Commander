import type {
  SynthesisStrategy,
  SynthesisConfig,
  ArtifactReference,
  TaskTreeNode,
  QualityGateConfig,
} from './types';
import { getArtifactSystem } from './artifactSystem';
import { getGlobalLogger } from '../logging';
import { QualityGateEngine, type QualityGateEngineOptions } from './qualityGates';

/** Minimum result length to consider for voting */
const MIN_VOTE_RESULT_LENGTH = 50;

/** Weight for length-based quality in ensemble scoring */
const ENSEMBLE_LENGTH_WEIGHT = 0.3;

/** Weight for completeness (having a result at all) in ensemble scoring */
const ENSEMBLE_COMPLETENESS_WEIGHT = 0.4;

/** Weight for depth (shallower = higher priority) in ensemble scoring */
const ENSEMBLE_DEPTH_WEIGHT = 0.3;

export class MultiAgentSynthesizer {
  private artifactSystem = getArtifactSystem();
  private qualityGateEngine: QualityGateEngine;

  constructor(qualityGateOptions?: QualityGateEngineOptions) {
    this.qualityGateEngine = new QualityGateEngine(qualityGateOptions);
  }

  // Quality gates are regex-based heuristics, not LLM evaluation.
  // They penalize hedging language, uncertainty phrases, and known unsafe
  // patterns rather than performing semantic assessment.

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

    const gateResults = await this.qualityGateEngine.run(config.qualityGates, synthesis, {
      taskTree,
    });
    const qualityScore =
      gateResults.reduce((acc, g) => acc + (g.passed ? g.score : 0), 0) /
      Math.max(1, gateResults.length);

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
    if (completedNodes.length === 0) {
      return '# Synthesis\n\nNo completed results to synthesize.';
    }

    const parts: string[] = [];

    // Executive summary
    parts.push(`# Synthesis\n`);
    parts.push(
      `Synthesized from ${completedNodes.length} completed subtasks across ${artifacts.length} artifacts.\n`,
    );

    // Build a structured synthesis that develops each result section
    // For non-atomic nodes, prefer fullSubtaskResults (preserves original data)
    let sectionIndex = 0;
    for (const node of completedNodes) {
      const effectiveResult = node.fullSubtaskResults || node.result;
      if (!effectiveResult) continue;
      sectionIndex++;

      const resultLen = effectiveResult.length;
      const isSubstantial = resultLen > 200;

      // Section header with context
      parts.push(`\n## ${sectionIndex}. ${node.goal.slice(0, 120)}\n`);

      // Include the full result without truncation
      parts.push(effectiveResult);

      // For thin results from substantial tasks, add a note
      if (!isSubstantial && node.goal.length > 50) {
        parts.push(
          `\n*[Note: This subtask produced a brief result (${resultLen} chars). The analysis above may be incomplete.]*\n`,
        );
      }
    }

    // Cross-cutting analysis section
    if (completedNodes.length > 1) {
      const totalResultLen = completedNodes.reduce((sum, n) => sum + (n.result?.length ?? 0), 0);
      parts.push(`\n## Summary Statistics\n`);
      parts.push(`- Subtasks completed: ${completedNodes.length}`);
      parts.push(`- Total analysis depth: ${totalResultLen} characters`);
      parts.push(`- Artifacts generated: ${artifacts.length}`);
    }

    // Limitations section
    if (config.includeDissent) {
      const failedNodes = this.collectFailed(taskTree);
      if (failedNodes.length > 0) {
        parts.push('\n## Limitations and Caveats\n');
        parts.push(`${failedNodes.length} subtask(s) encountered issues during execution:\n`);
        for (const node of failedNodes) {
          parts.push(
            `- **${node.goal.slice(0, 100)}**: did not complete successfully (status: ${node.status})`,
          );
        }
        parts.push('\nConclusions drawn from partial results should be interpreted with caution.');
      }
    }

    return parts.join('\n');
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
    _artifacts: ArtifactReference[],
    _config: SynthesisConfig,
  ): Promise<string> {
    const completed = this.collectCompleted(taskTree);
    if (completed.length === 0) return 'No completed results to synthesize.';

    const results = completed
      .map((n) => ({
        text: n.result ?? '',
        goal: n.goal,
        length: (n.result ?? '').length,
        depth: this.getDepth(n, taskTree),
      }))
      .filter((r) => r.text.length >= MIN_VOTE_RESULT_LENGTH);

    if (results.length === 0) {
      return completed
        .map((n) => n.result ?? '')
        .filter(Boolean)
        .join('\n\n---\n\n');
    }

    // Diversity check: detect echo chamber when top results are too similar
    if (results.length >= 3) {
      const topResults = results.slice(0, 3);
      const fingerprints = topResults.map((r) =>
        r.text.slice(0, 100).toLowerCase().replace(/\s+/g, ' '),
      );
      const uniqueFingerprints = new Set(fingerprints);
      if (uniqueFingerprints.size === 1) {
        // All top results start identically — echo chamber detected
        getGlobalLogger().warn(
          'Synthesizer',
          'Echo chamber detected: top 3 results have identical openings',
          {
            fingerprint: fingerprints[0].slice(0, 60),
            resultCount: results.length,
          },
        );
      }
    }

    // Vote: score each result by quality heuristics and pick the best
    const scored = results.map((r) => {
      let score = 0;
      // Longer, more detailed results score higher (up to a point)
      score += Math.min(1, r.length / 2000) * 0.3;
      // Shallower results (closer to root) score higher
      score += (1 - r.depth / 5) * 0.2;
      // Results with structured content (headers, lists) score higher
      const hasHeaders = /^#+\s/m.test(r.text) ? 0.2 : 0;
      const hasLists = /^[-*]\s/m.test(r.text) ? 0.1 : 0;
      const hasNumbers = /\d+\.\s/.test(r.text) ? 0.1 : 0;
      score += hasHeaders + hasLists + hasNumbers;
      return { ...r, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Build voted synthesis: primary result + supporting evidence from others
    const primary = scored[0];
    const parts: string[] = [];

    parts.push(`# Voted Synthesis\n`);
    parts.push(
      `Selected from ${results.length} independent analyses via quality-weighted voting.\n`,
    );
    parts.push(`## Primary Analysis\n`);
    parts.push(primary.text);

    // Add unique contributions from other results
    if (scored.length > 1) {
      parts.push(`\n## Additional Perspectives\n`);
      for (let i = 1; i < scored.length; i++) {
        const other = scored[i];
        // Only include if it adds substantial new content
        if (other.length > MIN_VOTE_RESULT_LENGTH * 2) {
          parts.push(`\n### From: ${other.goal.slice(0, 80)}\n`);
          parts.push(other.text);
        }
      }
    }

    return parts.join('\n');
  }

  private async ensembleSynthesis(
    taskTree: TaskTreeNode,
    _artifacts: ArtifactReference[],
    _config: SynthesisConfig,
  ): Promise<string> {
    const completed = this.collectCompleted(taskTree);
    if (completed.length === 0) return 'No completed results to synthesize.';

    // Score each result by multiple quality dimensions
    const scored = completed
      .map((n) => {
        const text = n.result ?? '';
        const depth = this.getDepth(n, taskTree);
        const maxDepth = this.getMaxDepth(taskTree);

        // Length quality: reward proportional content, penalize too-short
        const lengthScore = Math.min(1, text.length / 500);

        // Completeness: having a result at all
        const completenessScore = text.length > 0 ? 1 : 0;

        // Depth quality: shallower = more context = higher priority
        const depthScore = maxDepth > 0 ? 1 - depth / maxDepth : 1;

        const totalScore =
          lengthScore * ENSEMBLE_LENGTH_WEIGHT +
          completenessScore * ENSEMBLE_COMPLETENESS_WEIGHT +
          depthScore * ENSEMBLE_DEPTH_WEIGHT;

        return { text, goal: n.goal, depth, score: totalScore };
      })
      .filter((r) => r.text.length > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return 'No results to ensemble.';

    // Ensemble: combine all results weighted by quality
    const parts: string[] = [];
    parts.push(`# Ensemble Synthesis\n`);
    parts.push(`Combined from ${scored.length} analyses, weighted by quality metrics.\n`);

    for (const result of scored) {
      const weightLabel =
        result.score > 0.7
          ? '★ High confidence'
          : result.score > 0.4
            ? '◆ Medium confidence'
            : '○ Lower confidence';
      parts.push(`\n## ${weightLabel}: ${result.goal.slice(0, 80)}\n`);
      parts.push(result.text);
    }

    return parts.join('\n');
  }

  async runQualityGatesStrict(
    gates: QualityGateConfig[],
    synthesis: string,
    taskTree: TaskTreeNode,
  ): Promise<Array<{ gate: string; passed: boolean; score: number }>> {
    return this.qualityGateEngine.run(gates, synthesis, { taskTree });
  }

  private collectCompleted(node: TaskTreeNode): TaskTreeNode[] {
    const completed: TaskTreeNode[] = [];
    if (node.status === 'COMPLETED' && node.result !== undefined && node.result !== null) {
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
      if (depth >= 0) return depth;
    }
    return -1; // not found — caller guarantees node is in tree, so this is defensive
  }

  private getMaxDepth(node: TaskTreeNode, currentDepth = 0): number {
    if (node.subtasks.length === 0) return currentDepth;
    let maxDepth = currentDepth;
    for (const sub of node.subtasks) {
      maxDepth = Math.max(maxDepth, this.getMaxDepth(sub, currentDepth + 1));
    }
    return maxDepth;
  }
}
