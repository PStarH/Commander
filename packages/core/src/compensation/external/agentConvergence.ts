/**
 * Agent Convergence Mechanism — judge agent + round limit for multi-agent debate.
 *
 * Prevents endless agent drift in DEBATE topology by:
 *   1. Round limit: hard cap on debate rounds
 *   2. Judge agent: lightweight agent that computes convergence score
 *   3. Semantic dedup: detect repeated arguments
 *   4. Forced termination: output best result when budget exhausted
 */

export interface AgentArgument {
  agentId: string;
  round: number;
  content: string;
  timestamp: string;
  embeddings?: number[];
}

export interface ConvergenceConfig {
  maxRounds: number;
  convergenceThreshold: number;
  deduplicationThreshold: number;
  judgeModel?: string;
  timeoutMs: number;
}

export interface ConvergenceResult {
  converged: boolean;
  round: number;
  convergenceScore: number;
  reason: 'threshold_reached' | 'round_limit' | 'timeout' | 'dedup_detected';
  selectedArgument?: AgentArgument;
  allArguments: AgentArgument[];
}

export interface JudgeEvaluation {
  convergenceScore: number;
  repeatedArguments: string[];
  strongestPoints: string[];
  recommendation: string;
}

export class AgentConvergence {
  private config: ConvergenceConfig;
  private arguments: AgentArgument[] = [];
  private round = 0;
  private startTime: number;

  constructor(config: Partial<ConvergenceConfig> = {}) {
    this.config = {
      maxRounds: config.maxRounds ?? 5,
      convergenceThreshold: config.convergenceThreshold ?? 0.8,
      deduplicationThreshold: config.deduplicationThreshold ?? 0.9,
      judgeModel: config.judgeModel,
      timeoutMs: config.timeoutMs ?? 300000,
    };
    this.startTime = Date.now();
  }

  addArgument(argument: AgentArgument): void {
    this.arguments.push(argument);
    this.round = Math.max(this.round, argument.round);
  }

  checkConvergence(): ConvergenceResult {
    if (Date.now() - this.startTime > this.config.timeoutMs) {
      return this.buildResult('timeout');
    }

    if (this.round >= this.config.maxRounds) {
      return this.buildResult('round_limit');
    }

    const duplicates = this.detectDuplicates();
    if (duplicates.length > 0) {
      return this.buildResult('dedup_detected');
    }

    const score = this.computeConvergenceScore();
    if (score >= this.config.convergenceThreshold) {
      return this.buildResult('threshold_reached', score);
    }

    return {
      converged: false,
      round: this.round,
      convergenceScore: score,
      reason: 'threshold_reached',
      allArguments: [...this.arguments],
    };
  }

  private buildResult(reason: ConvergenceResult['reason'], score?: number): ConvergenceResult {
    const convergenceScore = score ?? this.computeConvergenceScore();
    return {
      converged: true,
      round: this.round,
      convergenceScore,
      reason,
      selectedArgument: this.selectBestArgument(),
      allArguments: [...this.arguments],
    };
  }

  private computeConvergenceScore(): number {
    if (this.arguments.length < 2) return 0;

    const uniqueAgents = new Set(this.arguments.map((a) => a.agentId));
    if (uniqueAgents.size < 2) return 0;

    const latestRound = this.arguments.filter((a) => a.round === this.round);
    if (latestRound.length < 2) return 0;

    const similarities = this.computePairwiseSimilarities(latestRound);
    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

    return avgSimilarity;
  }

  private computePairwiseSimilarities(args: AgentArgument[]): number[] {
    const similarities: number[] = [];
    for (let i = 0; i < args.length; i++) {
      for (let j = i + 1; j < args.length; j++) {
        const sim = this.textSimilarity(args[i].content, args[j].content);
        similarities.push(sim);
      }
    }
    return similarities;
  }

  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private detectDuplicates(): string[] {
    const duplicates: string[] = [];
    const seen = new Map<string, number>();

    for (const arg of this.arguments) {
      const key = `${arg.agentId}:${arg.content.slice(0, 100)}`;
      if (seen.has(key)) {
        duplicates.push(arg.agentId);
      } else {
        seen.set(key, arg.round);
      }
    }

    return duplicates;
  }

  private selectBestArgument(): AgentArgument | undefined {
    const latestRound = this.arguments.filter((a) => a.round === this.round);
    if (latestRound.length === 0) return undefined;

    return latestRound.reduce((best, current) =>
      current.content.length > best.content.length ? current : best,
    );
  }

  getRound(): number {
    return this.round;
  }

  getArguments(): AgentArgument[] {
    return [...this.arguments];
  }

  reset(): void {
    this.arguments = [];
    this.round = 0;
    this.startTime = Date.now();
  }
}

export class JudgeAgent {
  private convergence: AgentConvergence;
  private llmCall?: (prompt: string) => Promise<string>;

  constructor(
    config: Partial<ConvergenceConfig> = {},
    llmCall?: (prompt: string) => Promise<string>,
  ) {
    this.convergence = new AgentConvergence(config);
    this.llmCall = llmCall;
  }

  async evaluate(args: AgentArgument[]): Promise<JudgeEvaluation> {
    for (const arg of args) {
      this.convergence.addArgument(arg);
    }

    const result = this.convergence.checkConvergence();

    if (this.llmCall) {
      return this.llmWithJudge(args, result);
    }

    return this.ruleBasedJudge(args, result);
  }

  private ruleBasedJudge(
    args: AgentArgument[],
    convergenceResult: ConvergenceResult,
  ): JudgeEvaluation {
    const longestArgument = args.reduce((longest, current) =>
      current.content.length > longest.content.length ? current : longest,
    );

    const repeatedWords = this.findRepeatedPhrases(args);

    return {
      convergenceScore: convergenceResult.convergenceScore,
      repeatedArguments: repeatedWords,
      strongestPoints: [longestArgument.content.slice(0, 200)],
      recommendation: convergenceResult.converged
        ? `Convergence reached at round ${convergenceResult.round}. Reason: ${convergenceResult.reason}`
        : `Continue debate. Round ${convergenceResult.round}/${this.convergence['config'].maxRounds}`,
    };
  }

  private async llmWithJudge(
    args: AgentArgument[],
    convergenceResult: ConvergenceResult,
  ): Promise<JudgeEvaluation> {
    const prompt = this.buildJudgePrompt(args, convergenceResult);
    const response = await this.llmCall!(prompt);
    return this.parseJudgeResponse(response, convergenceResult);
  }

  private buildJudgePrompt(args: AgentArgument[], convergenceResult: ConvergenceResult): string {
    const argsText = args
      .map((a) => `[Agent ${a.agentId}, Round ${a.round}]: ${a.content}`)
      .join('\n\n');

    return `You are a judge agent evaluating a multi-agent debate.

DEBATE ARGUMENTS:
${argsText}

CONVERGENCE STATUS:
- Round: ${convergenceResult.round}
- Score: ${convergenceResult.convergenceScore}
- Converged: ${convergenceResult.converged}
- Reason: ${convergenceResult.reason}

Evaluate the debate and provide:
1. convergenceScore (0-1): How much consensus has been reached
2. repeatedArguments: List any repeated or duplicate arguments
3. strongestPoints: Top 3 strongest points made
4. recommendation: What should happen next

Respond in JSON format:
{
  "convergenceScore": number,
  "repeatedArguments": string[],
  "strongestPoints": string[],
  "recommendation": string
}`;
  }

  private parseJudgeResponse(
    response: string,
    convergenceResult: ConvergenceResult,
  ): JudgeEvaluation {
    try {
      const parsed = JSON.parse(response);
      return {
        convergenceScore: parsed.convergenceScore ?? convergenceResult.convergenceScore,
        repeatedArguments: parsed.repeatedArguments ?? [],
        strongestPoints: parsed.strongestPoints ?? [],
        recommendation: parsed.recommendation ?? 'No recommendation',
      };
    } catch {
      return this.ruleBasedJudge([], convergenceResult);
    }
  }

  private findRepeatedPhrases(args: AgentArgument[]): string[] {
    const phrases = new Map<string, number>();
    for (const arg of args) {
      const words = arg.content.toLowerCase().split(/\s+/);
      for (let i = 0; i < words.length - 2; i++) {
        const phrase = words.slice(i, i + 3).join(' ');
        phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
      }
    }
    return Array.from(phrases.entries())
      .filter(([_, count]) => count > 1)
      .map(([phrase]) => phrase);
  }

  getConvergence(): AgentConvergence {
    return this.convergence;
  }
}

export function createConvergenceCompensationHandler(convergence: AgentConvergence) {
  return async () => {
    convergence.reset();
    return { success: true };
  };
}

export function registerConvergenceCompensation(
  registry: { register: (toolName: string, handler: () => Promise<{ success: boolean }>) => void },
  convergence: AgentConvergence,
): void {
  registry.register('agent:convergence:reset', createConvergenceCompensationHandler(convergence));
}
