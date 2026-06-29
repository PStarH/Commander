/**
 * Extracted from UltimateOrchestrator to shrink the god object.
 *
 * Responsible for the Phase 8 quality-gate auto-fix retry loop.
 * When quality gates fail, this module builds targeted fix prompts
 * (hallucination, consistency, completeness, accuracy), spawns a
 * quality-fixer agent, re-checks the gates, and uses reflexion context
 * to prevent repeated mistakes.
 *
 * Early-exit heuristics:
 *  - Stops when score is already above QUALITY_FIX_THRESHOLD
 *  - Stops when a fix attempt doesn't improve the score
 *  - Stops when a fix produces identical output
 */
import type { TaskTreeNode, QualityGateConfig } from './types';
import type { AgentRuntimeInterface } from '../runtime';
import type { MultiAgentSynthesizer } from './synthesizer';

// ── Constants ────────────────────────────────────────────────────────────────

const QUALITY_FIX_THRESHOLD = 0.7;
const MAX_FIX_ATTEMPTS = 2;
const QUALITY_FIX_TOKEN_BUDGET = 2000;
const QUALITY_FIX_MAX_STEPS = 2;
const MIN_FIX_RESULT_LENGTH = 50;

// ── Types ────────────────────────────────────────────────────────────────────

export interface GateResult {
  gate: string;
  passed: boolean;
  score: number;
}

export interface QualityGateFixerDeps {
  runtime: AgentRuntimeInterface;
  synthesizer: MultiAgentSynthesizer;
  qualityGates: QualityGateConfig[];
}

export interface FixParams {
  projectId: string;
  contextData?: Record<string, unknown>;
  taskTree: TaskTreeNode;
  initialSynthesis: string;
  initialQualityScore: number;
  initialGateResults: GateResult[];
}

export interface FixResult {
  finalSynthesis: string;
  finalQualityScore: number;
  finalGateResults: GateResult[];
}

// ── QualityGateFixer ─────────────────────────────────────────────────────────

export class QualityGateFixer {
  constructor(private readonly deps: QualityGateFixerDeps) {}

  /**
   * Run the auto-fix retry loop on a synthesis that failed quality gates.
   * Mutates nothing — returns the improved synthesis, score, and gate results.
   */
  async runAutoFixLoop(params: FixParams, reasoning: string[]): Promise<FixResult> {
    let finalSynthesis = params.initialSynthesis;
    let finalQualityScore = params.initialQualityScore;
    let finalGateResults = params.initialGateResults;
    let previousAttemptSynth = '';
    let previousAttemptScore = 0;

    for (let fixAttempt = 0; fixAttempt < MAX_FIX_ATTEMPTS; fixAttempt++) {
      const failedGates = finalGateResults.filter((g) => !g.passed);
      if (failedGates.length === 0) break;

      // Early exit: if score is already above threshold, don't burn tokens on marginal improvements
      if (finalQualityScore >= QUALITY_FIX_THRESHOLD && fixAttempt > 0) break;

      const autoFixGate = failedGates.find((g) => {
        const gc = this.deps.qualityGates.find((c) => c.name === g.gate);
        return gc?.autoFix;
      });
      if (!autoFixGate) break;

      reasoning.push(
        `Quality gate "${autoFixGate.gate}" failed (score: ${(autoFixGate.score * 100).toFixed(0)}%) — auto-fix attempt ${fixAttempt + 1}`,
      );

      // Build a fix prompt targeting the failed gate
      const fixInstructions: string[] = [];
      if (autoFixGate.gate === 'hallucination') {
        fixInstructions.push(
          'Remove unverified claims. Only include information supported by the subtask results. Be precise and factual.',
        );
      }
      if (autoFixGate.gate === 'consistency') {
        fixInstructions.push(
          'Ensure all statements are internally consistent. Resolve contradictions between subtask results.',
        );
      }
      if (autoFixGate.gate === 'completeness') {
        fixInstructions.push(
          'Ensure all key aspects from the subtask results are covered. Do not omit important findings.',
        );
      }
      if (autoFixGate.gate === 'accuracy') {
        fixInstructions.push(
          'Verify all numbers, names, and specific claims against the subtask results.',
        );
      }

      // Reflexion: Include context about previous failed attempts to prevent repeated mistakes
      let reflexionContext = '';
      if (previousAttemptSynth && previousAttemptScore <= finalQualityScore) {
        reflexionContext = `\n\nPrevious fix attempt scored ${(previousAttemptScore * 100).toFixed(0)}% but failed to pass the same gate. Do NOT repeat the same approach. Try a different strategy.`;
      }

      const fixGoal = `Revise the following synthesis to address quality issues.\n\nIssues to fix: ${fixInstructions.join(' ')}${reflexionContext}\n\nCurrent synthesis:\n${finalSynthesis}`;

      // Store current state before fix for comparison
      previousAttemptSynth = finalSynthesis;
      previousAttemptScore = finalQualityScore;

      try {
        const fixResult = await this.deps.runtime.execute({
          agentId: `quality-fixer`,
          projectId: params.projectId,
          goal: fixGoal,
          contextData: params.contextData ?? {},
          availableTools: ['file_read', 'file_edit'],
          maxSteps: QUALITY_FIX_MAX_STEPS,
          tokenBudget: QUALITY_FIX_TOKEN_BUDGET,
        });

        if (fixResult.status === 'success') {
          const fixedSynth = fixResult.summary;
          if (fixedSynth.length > MIN_FIX_RESULT_LENGTH && fixedSynth !== previousAttemptSynth) {
            finalSynthesis = fixedSynth;
            // Re-run quality gates on the fixed synthesis
            const recheck = await this.deps.synthesizer.runQualityGatesStrict(
              this.deps.qualityGates.filter((g) => g.enabled),
              finalSynthesis,
              params.taskTree,
            );
            finalGateResults = recheck;
            finalQualityScore =
              recheck.reduce((acc, g) => acc + (g.passed ? g.score : 0), 0) /
              Math.max(1, recheck.length);
            reasoning.push(
              `Auto-fix ${fixAttempt + 1}: quality score ${(finalQualityScore * 100).toFixed(0)}%`,
            );

            // Early exit: if fix didn't improve score, don't waste another attempt
            if (finalQualityScore <= previousAttemptScore) {
              reasoning.push(`Auto-fix ${fixAttempt + 1}: no score improvement, stopping fix loop`);
              break;
            }
          } else {
            reasoning.push(`Auto-fix ${fixAttempt + 1}: produced identical output, skipping`);
          }
        }
      } catch (err) {
        reasoning.push(
          `Auto-fix attempt ${fixAttempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { finalSynthesis, finalQualityScore, finalGateResults };
  }
}
