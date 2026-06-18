import type { AgentExecutionContext, RoutingDecision, Tool, AgentRuntimeConfig } from './types';
import type { TokenGovernor } from './tokenGovernor';
import type { TaskType } from './unifiedVerificationTypes';
import type { ProjectContext } from './projectContextLoader';
/**
 * Build system prompt with budget-aware verbosity.
 *
 * KV-cache strategy: the prompt is split into a STABLE PREFIX (cacheable
 * across calls) and a DYNAMIC SUFFIX (varies per call). Anthropic, OpenAI,
 * and other providers cache the system prompt based on content identity
 * (byte-for-byte match of the prefix). Manus (2025) reports that
 * cache-hit rate is the #1 cost metric; this layout maximizes it.
 */
export declare function buildSystemPrompt(ctx: AgentExecutionContext, routing: RoutingDecision, config: AgentRuntimeConfig, tools: Map<string, Tool>, governor: TokenGovernor, registrySummary?: string, activeToolNames?: string[], taskType?: TaskType, projectContext?: ProjectContext): string;
/**
 * Build the cache-stable system-prompt prefix. Returned string is
 * byte-identical across calls that share the same tool set, governance
 * profile, runtime config, and task type — making it eligible for
 * provider-level prompt caching.
 *
 * Do not add fields that vary per call (agent ID, goal, budget, model).
 */
export declare function buildStableSystemPrefix(config: AgentRuntimeConfig, tools: Map<string, Tool>, governanceProfile: unknown, registrySummary?: string, activeToolNames?: string[], taskType?: TaskType, projectContext?: ProjectContext): string;
/** Per-call dynamic context. Appended after the stable prefix. */
export declare function buildDynamicContext(ctx: AgentExecutionContext, routing: RoutingDecision, config: AgentRuntimeConfig): string;
/**
 * Cache key for the stable system-prompt prefix. Two calls with the same
 * key produce the same prefix; the provider cache will hit.
 */
export declare function computePrefixCacheKey(config: AgentRuntimeConfig, tools: Map<string, Tool>, governanceProfile: unknown, registrySummary?: string, activeToolNames?: string[], taskType?: TaskType, projectContextCacheKey?: string): string;
/**
 * Build cache-aware user prompt.
 * Variable content goes LAST for maximum cache hit ratio on preceding system block.
 */
export declare function buildCacheAwareUserPrompt(ctx: AgentExecutionContext, _routing: RoutingDecision, governor: TokenGovernor, config?: AgentRuntimeConfig): string;
/**
 * Detect whether a task is complex enough to warrant comprehensive output.
 * Complex tasks: analysis, audit, research, multi-file, refactor, design, implementation.
 * Simple tasks: factual lookup, single question, short command.
 */
export declare function isComplexTask(goal: string): boolean;
//# sourceMappingURL=promptBuilder.d.ts.map