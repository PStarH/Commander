/**
 * Company Engine — Integration Layer
 *
 * Wraps the UltimateOrchestrator with Company Engine capabilities:
 * - CapabilityMatcher: Dynamic agent selection (Nucleus-Electron)
 * - QualityGater: Auto-escalation/de-escalation based on quality
 * - UnifiedMemory: Cross-session context and knowledge management
 *
 * This is the "glue" that connects the new components to the existing
 * orchestrator pipeline without modifying the orchestrator directly.
 *
 * Usage:
 *   const engine = new CompanyEngine(orchestrator, { projectId, userId });
 *   const result = await engine.execute({ goal: "..." });
 */

import { getGlobalLogger } from '../logging';
import { CapabilityMatcher, getCapabilityMatcher } from '../runtime/capabilityMatcher';
import type {
  CapabilityProfile,
  TaskRequirements,
  MatchResult,
} from '../runtime/capabilityMatcher';
import {
  QualityGater,
  getQualityGater,
  getInitialMode,
  getModeConfig,
} from '../runtime/qualityGater';
import type { ExecutionMode, QualityMetrics, EscalationDecision } from '../runtime/qualityGater';
import { UnifiedMemory, getUnifiedMemory } from '../memory/unifiedMemory';
import type { UnifiedContext } from '../memory/unifiedMemory';
import type { UltimateOrchestrator } from './orchestrator';
import type { UltimateExecutionResult } from './types';

// ============================================================================
// Types
// ============================================================================

export interface CompanyEngineConfig {
  /** Project ID */
  projectId: string;
  /** User ID (for personalization) */
  userId?: string;
  /** Enable capability matching */
  enableCapabilityMatching: boolean;
  /** Enable quality-gated escalation */
  enableQualityGating: boolean;
  /** Enable unified memory */
  enableMemory: boolean;
  /** Maximum agents per task */
  maxAgents: number;
  /** Token budget per task */
  tokenBudget: number;
}

export interface CompanyExecutionParams {
  /** Task goal */
  goal: string;
  /** Agent ID */
  agentId?: string;
  /** Context data */
  contextData?: Record<string, unknown>;
  /** Force a specific execution mode */
  forceMode?: ExecutionMode;
  /** Force specific agents */
  forceAgents?: string[];
  /** Progress callback */
  onProgress?: (phase: string, detail: string) => void;
}

export interface CompanyExecutionResult extends UltimateExecutionResult {
  /** Agents used */
  agentsUsed: CapabilityProfile[];
  /** Execution mode used */
  executionMode: ExecutionMode;
  /** Quality decision */
  qualityDecision: EscalationDecision;
  /** Match result */
  matchResult: MatchResult;
  /** Context used */
  context: UnifiedContext;
  /** Token savings estimate */
  estimatedSavings: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: CompanyEngineConfig = {
  projectId: 'default',
  enableCapabilityMatching: true,
  enableQualityGating: true,
  enableMemory: true,
  maxAgents: 8,
  tokenBudget: 500000,
};

// ============================================================================
// Company Engine
// ============================================================================

export class CompanyEngine {
  private orchestrator: UltimateOrchestrator;
  private matcher: CapabilityMatcher;
  private gater: QualityGater;
  private memory: UnifiedMemory;
  private config: CompanyEngineConfig;
  private executionHistory: Array<{
    goal: string;
    mode: ExecutionMode;
    quality: number;
    tokens: number;
    timestamp: number;
  }> = [];

  constructor(orchestrator: UltimateOrchestrator, config?: Partial<CompanyEngineConfig>) {
    this.orchestrator = orchestrator;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.matcher = getCapabilityMatcher();
    this.gater = getQualityGater();
    this.memory = getUnifiedMemory();
  }

  /**
   * Execute a task with Company Engine enhancements.
   *
   * Flow:
   * 1. Build context from UnifiedMemory
   * 2. Match agents via CapabilityMatcher
   * 3. Determine execution mode via QualityGater
   * 4. Execute via UltimateOrchestrator
   * 5. Record quality metrics
   * 6. Store results in memory
   */
  async execute(params: CompanyExecutionParams): Promise<CompanyExecutionResult> {
    const startTime = Date.now();
    const agentId = params.agentId ?? 'company-engine';
    const emit = params.onProgress ?? (() => {});

    // Step 1: Build context from memory
    emit('CONTEXT', 'Building unified context...');
    let context: UnifiedContext;
    try {
      context = await this.memory.buildContext({
        projectId: this.config.projectId,
        userId: this.config.userId,
        goal: params.goal,
      });
    } catch {
      context = {
        systemContext: '',
        userContext: '',
        conversationContext: '',
        workingContext: '',
        combined: '',
        estimatedTokens: 0,
      };
    }

    // Step 2: Determine task requirements
    const requirements = this.analyzeRequirements(params.goal, params.contextData);

    // Step 3: Match agents
    emit('MATCHING', 'Selecting optimal agents...');
    let matchResult: MatchResult;
    if (this.config.enableCapabilityMatching && !params.forceAgents) {
      matchResult = await this.matcher.match(requirements);
    } else {
      // Use all available agents (fallback)
      matchResult = {
        agents: this.matcher.getAvailableAgents().slice(0, this.config.maxAgents),
        fullyCovered: true,
        missingCapabilities: [],
        estimatedTokenCost: 0,
        strategy: 'reuse',
        confidence: 1,
      };
    }

    // Step 4: Determine execution mode
    emit('MODE', 'Determining execution mode...');
    let executionMode: ExecutionMode;
    let qualityDecision: EscalationDecision | null = null;

    if (params.forceMode) {
      executionMode = params.forceMode;
      this.gater.forceMode(executionMode, 'User override');
    } else if (this.config.enableQualityGating) {
      executionMode = this.gater.getCurrentMode();
      // If this is the first execution, use complexity-based initial mode
      if (this.executionHistory.length === 0) {
        executionMode = getInitialMode(requirements.complexity);
      }
    } else {
      executionMode = 'standard';
    }

    const modeConfig = getModeConfig(executionMode);
    emit(
      'MODE',
      `Execution mode: ${executionMode} (${modeConfig.maxAgents} agents, ${modeConfig.verificationLevel} verification)`,
    );

    // Step 5: Start conversation session
    let sessionId: string | null = null;
    if (this.config.enableMemory) {
      try {
        const session = await this.memory.startConversation({
          projectId: this.config.projectId,
          agentId,
          userId: this.config.userId,
          goal: params.goal,
        });
        sessionId = session.id;
      } catch (err) {
        getGlobalLogger().warn('CompanyEngine', 'Failed to start conversation session', {
          error: String(err),
        });
      }
    }

    // Step 6: Execute via orchestrator
    emit('EXECUTION', `Executing with ${matchResult.agents.length} agents...`);
    let result: UltimateExecutionResult;
    try {
      result = await this.orchestrator.execute({
        projectId: this.config.projectId,
        agentId,
        goal: params.goal,
        contextData: {
          ...params.contextData,
          // Inject Company Engine context
          companyEngine: {
            executionMode,
            modeConfig,
            matchedAgents: matchResult.agents.map((a) => a.agentId),
            matchConfidence: matchResult.confidence,
            strategy: matchResult.strategy,
          },
          // Inject unified context
          unifiedContext: context.combined,
        },
        onProgress: emit,
      });
    } catch (err) {
      // Record failure
      if (this.config.enableQualityGating) {
        this.gater.recordOutcome({
          quality: 0,
          passed: false,
          issueCount: 1,
          worstSeverity: 'critical',
          tokenCost: 0,
          timestamp: Date.now(),
        });
      }
      throw err;
    }

    // Step 7: Record quality metrics
    const qualityScore =
      result.metrics?.qualityScore ??
      (result.errors.length === 0
        ? 0.9
        : result.errors.every((e) => e.recovered)
          ? 0.7
          : Math.max(0.3, 1 - result.errors.length * 0.2));
    const totalTokens = result.metrics?.totalTokens ?? 0;

    if (this.config.enableQualityGating) {
      qualityDecision = this.gater.recordOutcome({
        quality: qualityScore,
        passed: result.errors.length === 0 || result.errors.every((e) => e.recovered),
        issueCount: result.errors.length,
        worstSeverity: result.errors.length > 0 ? 'high' : 'none',
        tokenCost: totalTokens,
        timestamp: Date.now(),
      });
    }

    // Step 8: Update agent scores
    if (this.config.enableCapabilityMatching) {
      for (const agent of matchResult.agents) {
        this.matcher.updateAgentScore(agent.agentId, {
          success: qualityScore >= 0.7,
          quality: qualityScore,
          speed: 1 - (Date.now() - startTime) / 60000, // Normalized speed
        });
      }
    }

    // Step 9: Store results in memory
    if (this.config.enableMemory) {
      try {
        await this.memory.remember({
          content: `Task completed: ${params.goal}\nQuality: ${(qualityScore * 100).toFixed(0)}%\nMode: ${executionMode}`,
          context: 'execution_result',
          importance: qualityScore,
          tags: ['execution', executionMode],
          kind: qualityScore >= 0.8 ? 'SUMMARY' : 'ISSUE',
          projectId: this.config.projectId,
          agentId,
        });

        // End conversation session
        if (sessionId) {
          await this.memory.endConversation(sessionId);
        }

        // Save user profile
        if (this.config.userId) {
          await this.memory.saveUserProfile(this.config.userId);
        }
      } catch (err) {
        getGlobalLogger().warn('CompanyEngine', 'Failed to store results', { error: String(err) });
      }
    }

    // Step 10: Record in history
    this.executionHistory.push({
      goal: params.goal,
      mode: executionMode,
      quality: qualityScore,
      tokens: totalTokens,
      timestamp: Date.now(),
    });

    // Calculate savings estimate
    const estimatedSavings = this.estimateSavings(executionMode, matchResult);

    return {
      ...result,
      agentsUsed: matchResult.agents,
      executionMode,
      qualityDecision: qualityDecision ?? {
        mode: executionMode,
        reason: 'Quality gating disabled',
        confidence: 1,
        rollingQuality: qualityScore,
        consecutiveFailures: 0,
        action: 'maintain',
      },
      matchResult,
      context,
      estimatedSavings,
    };
  }

  /**
   * Get execution statistics.
   */
  getStats(): {
    totalExecutions: number;
    averageQuality: number;
    averageTokens: number;
    currentMode: ExecutionMode;
    qualityGaterStats: ReturnType<QualityGater['getStats']>;
    poolSize: number;
    estimatedTotalSavings: number;
  } {
    const avgQuality =
      this.executionHistory.length > 0
        ? this.executionHistory.reduce((s, e) => s + e.quality, 0) / this.executionHistory.length
        : 0;
    const avgTokens =
      this.executionHistory.length > 0
        ? this.executionHistory.reduce((s, e) => s + e.tokens, 0) / this.executionHistory.length
        : 0;

    return {
      totalExecutions: this.executionHistory.length,
      averageQuality: Math.round(avgQuality * 100) / 100,
      averageTokens: Math.round(avgTokens),
      currentMode: this.gater.getCurrentMode(),
      qualityGaterStats: this.gater.getStats(),
      poolSize: this.matcher.getPool().length,
      estimatedTotalSavings: this.executionHistory.reduce((s, e) => {
        const modeConfig = getModeConfig(e.mode);
        return s + e.tokens * (modeConfig.tokenMultiplier - 1);
      }, 0),
    };
  }

  /**
   * Get the execution history.
   */
  getHistory(): Array<{
    goal: string;
    mode: ExecutionMode;
    quality: number;
    tokens: number;
    timestamp: number;
  }> {
    return this.executionHistory;
  }

  /**
   * Reset the engine (e.g., for a new project).
   */
  reset(): void {
    this.executionHistory = [];
    this.gater.reset();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Analyze task requirements from the goal and context.
   */
  private analyzeRequirements(
    goal: string,
    contextData?: Record<string, unknown>,
  ): TaskRequirements {
    const goalLower = goal.toLowerCase();

    // Infer required capabilities from goal keywords
    const requiredCapabilities: string[] = [];
    const preferredCapabilities: string[] = [];
    const requiredTools: string[] = [];

    // Code-related
    if (/\b(code|implement|build|create|write|fix|debug|refactor)\b/.test(goalLower)) {
      requiredCapabilities.push('typescript');
      requiredTools.push('file_read', 'file_write', 'file_edit');
    }
    if (/\b(test|testing|spec|jest|vitest|pytest)\b/.test(goalLower)) {
      requiredCapabilities.push('testing');
      requiredTools.push('shell_execute');
    }
    if (/\b(review|audit|check|verify)\b/.test(goalLower)) {
      requiredCapabilities.push('code_review');
      preferredCapabilities.push('security');
    }
    if (/\b(search|find|research|investigate|analyze)\b/.test(goalLower)) {
      requiredCapabilities.push('research');
      requiredTools.push('web_search', 'code_search');
    }
    if (/\b(deploy|ci|cd|docker|kubernetes|devops)\b/.test(goalLower)) {
      requiredCapabilities.push('devops');
      requiredTools.push('shell_execute');
    }
    if (/\b(security|vulnerability|xss|csrf|auth)\b/.test(goalLower)) {
      requiredCapabilities.push('security');
      preferredCapabilities.push('code_review');
    }
    if (/\b(api|rest|graphql|endpoint)\b/.test(goalLower)) {
      requiredCapabilities.push('api');
    }
    if (/\b(database|sql|postgres|mysql|mongo)\b/.test(goalLower)) {
      requiredCapabilities.push('database');
    }

    // Default capabilities if nothing matched
    if (requiredCapabilities.length === 0) {
      requiredCapabilities.push('typescript');
      requiredTools.push('file_read', 'shell_execute');
    }

    // Estimate complexity
    const complexity = this.estimateComplexity(goal, contextData);

    return {
      requiredCapabilities,
      preferredCapabilities,
      requiredTools,
      complexity,
      priority: 5,
      maxAgents: getModeConfig(this.gater.getCurrentMode()).maxAgents,
    };
  }

  /**
   * Estimate task complexity (0-10).
   */
  private estimateComplexity(goal: string, contextData?: Record<string, unknown>): number {
    let complexity = 3; // Baseline

    const goalLower = goal.toLowerCase();

    // Length-based
    if (goal.length > 500) complexity += 1;
    if (goal.length > 1000) complexity += 1;

    // Keyword-based
    if (/\b(complex|difficult|challenging|advanced)\b/.test(goalLower)) complexity += 2;
    if (/\b(simple|easy|quick|trivial)\b/.test(goalLower)) complexity -= 1;
    if (/\b(refactor|migrate|rewrite|architect)\b/.test(goalLower)) complexity += 2;
    if (/\b(multiple|many|several|across)\b/.test(goalLower)) complexity += 1;
    if (/\b(security|critical|production)\b/.test(goalLower)) complexity += 1;

    // Subtask indicators
    const sentences = goal.split(/[.!?]+/).filter((s) => s.trim().length > 10);
    if (sentences.length > 5) complexity += 1;

    return Math.max(1, Math.min(10, complexity));
  }

  /**
   * Estimate token savings from using Company Engine.
   */
  private estimateSavings(mode: ExecutionMode, match: MatchResult): number {
    // Base savings from quality-gated mode selection
    const modeConfig = getModeConfig(mode);
    const modeSavings = mode === 'compound' ? 0.5 : mode === 'standard' ? 0 : -1;

    // Savings from capability matching (reuse vs create)
    const matchSavings = match.strategy === 'reuse' ? 0.3 : match.strategy === 'hybrid' ? 0.15 : 0;

    return Math.round((modeSavings + matchSavings) * 100);
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a CompanyEngine instance with default configuration.
 */
export function createCompanyEngine(
  orchestrator: UltimateOrchestrator,
  config?: Partial<CompanyEngineConfig>,
): CompanyEngine {
  return new CompanyEngine(orchestrator, config);
}
