/**
 * Goal Gate — post-completion verification that the user's goal is satisfied.
 *
 * Mirrors MiMo-Code's goal gate pattern:
 * - After the agent signals completion, an independent judge model evaluates
 *   whether the active goal is genuinely satisfied.
 * - If not satisfied, the judge's reason is injected as a synthetic user turn
 *   and the loop continues (bounded by max re-entries).
 *
 * This prevents the agent from falsely claiming success when the goal is
 * only partially met or when critical constraints were ignored.
 *
 * Fails CLOSED: when the judge cannot render a verdict (provider missing,
 * empty/unparseable response, or an error) the goal is reported as NOT
 * satisfied rather than satisfied, so an unverifiable goal is never treated as
 * achieved. Each such outcome still counts toward maxReentries so the loop
 * terminates.
 */

import { extractDecisionObject } from './decisionJson';
export interface GoalGateConfig {
  enabled: boolean;
  judgeModel: string;
  judgeProvider: string;
  maxTokens: number;
  maxReentries: number;
}

export const DEFAULT_GOAL_GATE_CONFIG: GoalGateConfig = {
  enabled: true,
  judgeModel: 'gpt-4o-mini',
  judgeProvider: 'openai',
  maxTokens: 256,
  maxReentries: 3,
};

export interface GoalGateDecision {
  satisfied: boolean;
  reason: string;
  missing?: string[];
}

export class GoalGate {
  private config: GoalGateConfig;
  private reentries = 0;

  constructor(config?: Partial<GoalGateConfig>) {
    this.config = { ...DEFAULT_GOAL_GATE_CONFIG, ...config };
  }

  reset(): void {
    this.reentries = 0;
  }

  updateConfig(config: Partial<GoalGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): GoalGateConfig {
    return { ...this.config };
  }

  canReenter(): boolean {
    return this.reentries < this.config.maxReentries;
  }

  /**
   * Evaluate whether the goal is satisfied based on the conversation.
   * Returns a decision and an optional synthetic message to inject.
   */
  async evaluate(
    goal: string,
    messages: Array<{ role: string; content: string }>,
    services: {
      getProvider: (provider: string) => {
        call: (req: {
          model: string;
          messages: { role: string; content: string }[];
          maxTokens: number;
        }) => Promise<{ content?: string }>;
      } | null;
    },
  ): Promise<GoalGateDecision> {
    if (!this.config.enabled || !this.canReenter()) {
      return { satisfied: true, reason: 'Goal gate disabled or max reentries reached' };
    }

    const judgePrompt = `You are a goal evaluator. Determine if the agent has genuinely satisfied the user's goal.

User goal: "${goal.slice(0, 500)}"

Recent conversation (last ${Math.min(messages.length, 6)} turns):
${messages
  .slice(-6)
  .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
  .join('\n\n')}

Evaluate:
1. Has the agent addressed the core requirement of the goal?
2. Are there any critical constraints from the goal that were ignored?
3. Is the output complete and usable?

Respond with JSON:
{
  "satisfied": true/false,
  "reason": "brief explanation",
  "missing": ["list of missing requirements if any"]
}`;

    try {
      const provider = services.getProvider(this.config.judgeProvider);
      if (!provider) {
        return this.unverified(`Judge provider "${this.config.judgeProvider}" not available`);
      }

      const response = await provider.call({
        model: this.config.judgeModel,
        messages: [{ role: 'system', content: judgePrompt }],
        maxTokens: this.config.maxTokens,
      });

      if (!response?.content) {
        return this.unverified('Judge returned empty response');
      }

      const parsed = this.parseDecision(response.content);
      if (!parsed.satisfied) {
        this.reentries++;
      }
      return parsed;
    } catch (err) {
      return this.unverified(`Goal gate evaluation failed: ${(err as Error)?.message}`);
    }
  }

  /**
   * A goal that cannot be verified is never reported as satisfied. Counts
   * toward the re-entry budget so a persistently unavailable judge still
   * terminates instead of looping forever.
   */
  private unverified(reason: string): GoalGateDecision {
    this.reentries++;
    return { satisfied: false, reason: `${reason} — not verified (fail-closed)` };
  }

  /**
   * Build a synthetic user message from the judge's feedback.
   */
  buildSyntheticMessage(decision: GoalGateDecision): string {
    if (decision.satisfied) return '';
    const missing = decision.missing?.length ? `\nMissing: ${decision.missing.join(', ')}` : '';
    return `[System goal check: the previous response does not fully satisfy the goal.\nReason: ${decision.reason}${missing}\nPlease continue to complete the goal.]`;
  }

  private parseDecision(content: string): GoalGateDecision {
    const parsed = extractDecisionObject(content, 'satisfied');
    if (!parsed) {
      return {
        satisfied: false,
        reason: 'Could not parse judge response — not verified (fail-closed)',
      };
    }
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing.filter((m): m is string => typeof m === 'string')
      : undefined;
    return {
      satisfied: parsed.satisfied === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'Judge review complete',
      missing,
    };
  }
}
