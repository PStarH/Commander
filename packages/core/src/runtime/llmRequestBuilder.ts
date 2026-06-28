/**
 * LLMRequestBuilder — extracted from AgentRuntime.execute().
 *
 * Owns step "2. Build LLM request with cache-optimized prompt structure":
 *   - Two-tier tool loading (lazy schema loading)
 *   - Tool schema compaction
 *   - request_tool registration for Tier 2 registry tools
 *   - Registry summary + project context loading
 *   - System prompt building
 *   - KV-cache prefix tracking
 *   - Cache config building (TTL, batch flag)
 *   - System prompt extraction detection (security: OWASP ASI07)
 *   - Base LLM request assembly
 *   - Structured output wiring (outputSchema -> responseFormat)
 *   - Parameter controller application
 *
 * The builder is dependency-injected via getters/setters so it can read and
 * mutate the runtime's mutable instance fields (tools, promotedTools,
 * lastPrefixCacheKey) without taking a hard reference to the God object.
 */
import type {
  LLMRequest,
  CacheConfig,
  ToolDefinition,
  Tool,
  AgentExecutionContext,
  AgentRuntimeConfig,
  RoutingDecision,
} from './types';
import type { TokenGovernor } from './tokenGovernor';
import type { ModelRouter } from './modelRouter';
import type { ProjectContext } from './projectContextLoader';
import type { TaskType } from './unifiedVerificationTypes';
import {
  compactToolDef,
  compactToolDefs,
  getCompactConfigForTier,
} from './programmaticToolFormatter';
import {
  buildTwoTierTools,
  buildRegistrySummary,
  calculateTierMetrics,
  detectContextPromotions,
} from './toolRetriever';
import { createRequestToolTool } from '../tools/requestToolTool';
import {
  buildSystemPrompt,
  buildCacheAwareUserPrompt,
  computePrefixCacheKey,
} from './promptBuilder';
import { loadProjectContext } from './projectContextLoader';
import { applyControllerParams } from './parameterController';
import { getMetricsCollector } from './metricsCollector';
import { reportSilentFailure } from '../silentFailureReporter';
import { getGlobalLogger } from '../logging';

/**
 * Dependency surface the builder needs from the host runtime.
 *
 * `getTools()` MUST return the live tools Map (the same instance that
 * `setTool` mutates) so that registry reads performed after `request_tool`
 * registration observe the newly-registered tool — mirroring the original
 * inline behavior where `this.tools` was read fresh at each call site.
 */
export interface LLMRequestBuilderDeps {
  getConfig(): AgentRuntimeConfig;
  getGovernor(): TokenGovernor;
  getRouter(): ModelRouter;
  getTools(): Map<string, Tool>;
  setPromotedTools(tools: Set<string>): void;
  setTool(name: string, tool: Tool): void;
  getLastPrefixCacheKey(): string | undefined;
  setLastPrefixCacheKey(key: string): void;
}

export interface LLMRequestBuildParams {
  ctx: AgentExecutionContext;
  routing: RoutingDecision;
  batchRouting: RoutingDecision | undefined;
  taskType: TaskType;
  tenantId: string | undefined;
}

export interface LLMRequestBuildResult {
  request: LLMRequest;
  projectContext: ProjectContext;
  toolDefs: ToolDefinition[];
}

/**
 * Derive a stable OpenAI prompt_cache_key for routing stickiness across
 * requests. Kept module-local since it is only used by the request builder.
 */
function derivePromptCacheKey(
  ctx: AgentExecutionContext,
  tenantId: string | undefined,
): string {
  const goal = ctx.goal ?? '';
  let hash = 0;
  for (let i = 0; i < goal.length; i++) {
    hash = ((hash << 5) - hash + goal.charCodeAt(i)) | 0;
  }
  const goalTag = Math.abs(hash).toString(36).slice(0, 12);
  const tenantTag = tenantId ?? 'default';
  const agentTag = ctx.agentId ?? 'shared';
  return `${tenantTag}:${agentTag}:${goalTag}`.slice(0, 64);
}

export class LLMRequestBuilder {
  private readonly deps: LLMRequestBuilderDeps;

  constructor(deps: LLMRequestBuilderDeps) {
    this.deps = deps;
  }

  /**
   * Build the LLM request with a cache-optimized prompt structure.
   *
   * Stable content (system, tools) FIRST for maximum cache hits.
   * Variable content (user message) LAST.
   */
  build(params: LLMRequestBuildParams): LLMRequestBuildResult {
    const { ctx, routing, batchRouting, taskType, tenantId } = params;

    const config = this.deps.getConfig();
    const governor = this.deps.getGovernor();
    const router = this.deps.getRouter();
    // Live tools map — reads after setTool() observe request_tool, matching
    // the original inline behavior that referenced this.tools at each site.
    const tools = this.deps.getTools();

    // --- Two-Tier Tool Loading (Lazy Schema Loading) ---
    // Research (arXiv:2604.21816): Eager schema injection costs 10k-60k tokens/turn.
    // Two-tier loading: Tier 1 (full schema for top-N) + Tier 2 (compact registry for rest).
    // Estimated savings: 60-80% of tool-related token cost.

    const allToolDefs = ctx.availableTools
      .map((name) => tools.get(name)?.definition)
      .filter((t): t is ToolDefinition => t !== undefined);

    const maxActiveTools = config.toolRetrieval?.maxTools ?? 8;
    const twoTier = buildTwoTierTools(ctx.goal, allToolDefs, maxActiveTools);

    const contextPromotions = detectContextPromotions(ctx.goal, twoTier.registry);
    if (contextPromotions.length > 0) {
      const toolMap = new Map(allToolDefs.map((t) => [t.name, t]));
      for (const toolName of contextPromotions) {
        const tool = toolMap.get(toolName);
        if (tool) {
          twoTier.active.push(tool);
          twoTier.registry = twoTier.registry.filter((r) => r.name !== toolName);
        }
      }
    }

    const tierMetrics = calculateTierMetrics(twoTier, allToolDefs.length);

    // Log token savings
    if (tierMetrics.registryCount > 0) {
      getGlobalLogger().debug(
        'AgentRuntime',
        `Two-tier tools: ${tierMetrics.activeCount} active (${tierMetrics.activeTokenEstimate} tok), ${tierMetrics.registryCount} registry (~${tierMetrics.registryTokenEstimate} tok), ~${tierMetrics.savingsPercent}% savings`,
      );
    }

    // Tier 1: Active tools with full schema
    let toolDefs = twoTier.active;
    // Track promoted tools for hallucination rejection gate
    const promotedTools = new Set(twoTier.active.map((t) => t.name));
    promotedTools.add('request_tool'); // always allow request_tool
    this.deps.setPromotedTools(promotedTools);

    // Compact active tool schemas: strip verbose descriptions/examples.
    // Parameter-name minification is off for active tools so validation stays simple.
    const TIER_TO_COMPACT: Record<string, 'low' | 'medium' | 'high'> = {
      eco: 'low',
      standard: 'medium',
      power: 'high',
      consensus: 'high',
    };
    const compactConfig = getCompactConfigForTier(
      TIER_TO_COMPACT[config.defaultModelTier] ?? 'high',
    );
    toolDefs = compactToolDefs(toolDefs, compactConfig);

    // Register request_tool for Tier 2 tools (if there are registry tools)
    if (twoTier.registry.length > 0) {
      const registryNames = twoTier.registry.map((t) => t.name);
      const requestTool = createRequestToolTool((name) => {
        const found = allToolDefs.find((t) => t.name === name);
        return found ? compactToolDef(found, compactConfig) : undefined;
      }, registryNames);
      // Add request_tool to active tools
      toolDefs = [...toolDefs, requestTool.definition];
      // Register for execution
      this.deps.setTool('request_tool', requestTool);
    }

    // Build registry summary for system prompt
    const registrySummary = buildRegistrySummary(twoTier.registry);

    // Load project context once per run. This is cached by file mtime and
    // injected into the stable prefix so it participates in KV-cache reuse.
    const projectContext = loadProjectContext();

    const systemPrompt = buildSystemPrompt(
      ctx,
      routing,
      config,
      tools,
      governor,
      registrySummary,
      twoTier.active.map((t) => t.name),
      taskType,
      projectContext,
    );

    // KV-cache: track whether the stable system-prompt prefix changed
    // since the prior call. The prefix is tool-list + governance +
    // registry summary + max-steps + task-type + project-context — all cacheable across requests.
    // A hit lets the provider reuse prefix tokens, cutting cost and
    // latency (Anthropic reports 5x cost reduction on cached prefixes).
    const activeToolNames = twoTier.active.map((t) => t.name);
    const newPrefixKey = computePrefixCacheKey(
      config,
      tools,
      governor,
      registrySummary,
      activeToolNames,
      taskType,
      projectContext.cacheKey,
    );
    const lastPrefixCacheKey = this.deps.getLastPrefixCacheKey();
    const cacheHit =
      lastPrefixCacheKey !== undefined && lastPrefixCacheKey === newPrefixKey;
    this.deps.setLastPrefixCacheKey(newPrefixKey);
    try {
      getMetricsCollector().recordPromptPrefixCache(cacheHit, ctx.tenantId);
      getMetricsCollector().setPromptPrefixCacheKey(newPrefixKey, ctx.tenantId);
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:1695');
      /* best-effort */
    }

    // Cache configuration: enable caching for system prompt + tools on providers that support it
    // 1h TTL is 2x write premium — only worth it on multi-step/long sessions, and the governor
    // forces 5m in 'critical' phase to avoid paying the write premium on tight budgets.
    const governorPhase = governor.getState().phase;
    const cacheTtl: '5m' | '1h' =
      config.promptCacheTtl === '1h' && governorPhase !== 'critical' ? '1h' : '5m';
    const cacheConfig: CacheConfig = {
      cacheSystemPrompt: true,
      cacheTools: toolDefs.length > 0,
      useCacheControl: true,
      cacheTtl,
      promptCacheKey: config.promptCacheKey ?? derivePromptCacheKey(ctx, tenantId),
      isBatch: !!batchRouting,
    };

    // When batch routing is active, switch to the batch-selected model.
    // The isBatch flag on cacheConfig tells the provider to use native
    // Batch API (50% cost discount). If the batch API fails, the provider
    // falls back to standard API (fail-closed).
    const activeRouting = batchRouting ?? routing;
    const apiModel = (activeRouting.modelId || '').replace(/@\w+$/, '') || activeRouting.modelId;
    const selectedModelCfg = router.getModel(activeRouting.modelId);

    // Security: System prompt extraction detection (OWASP ASI07).
    // Scan user input for common prompt extraction/leakage patterns before
    // sending to the LLM. Log and flag suspicious attempts.
    const userContent = buildCacheAwareUserPrompt(ctx, routing, governor, config);
    try {
      const extractionPatterns = [
        /repeat\s+(your\s+)?(instructions?|system\s*prompt|rules?)/i,
        /show\s+me\s+(your\s+)?(system\s*prompt|instructions?|rules?)/i,
        /ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/i,
        /what\s+(is|are)\s+your\s+(system\s+p|instructions?|rules?)/i,
        /print\s+(your\s+)?(system\s*p|instructions?|rules?)/i,
        /reveal\s+(your\s+)?(system\s*p|instructions?)/i,
      ];
      for (const pattern of extractionPatterns) {
        if (pattern.test(userContent)) {
          getGlobalLogger().warn('AgentRuntime', 'System prompt extraction attempt detected', {
            agentId: ctx.agentId,
            pattern: pattern.source,
          });
          break;
        }
      }
    } catch {
      /* best-effort detection */
    }

    const baseRequest: LLMRequest = {
      model: apiModel,
      // Order: [system (stable, cacheable), user (variable)]
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      maxTokens: routing.maxTokens,
      tools: toolDefs,
      cacheConfig,
    };

    // Wire provider-native structured output when an output schema is supplied.
    if (ctx.outputSchema && selectedModelCfg) {
      if (selectedModelCfg.supportsStructuredOutput) {
        baseRequest.responseFormat = {
          type: 'json_schema',
          schema: ctx.outputSchema,
          name: 'structured_output',
        };
      } else if (selectedModelCfg.supportsJSONMode) {
        baseRequest.responseFormat = { type: 'json_object' };
      }
      // Anthropic / unsupported providers fall through to tool-use fallback in their provider.
    }

    // Apply parameter controller (eval profile, reasoning config, adaptive params)
    const request = applyControllerParams(baseRequest, ctx.goal, baseRequest.messages, 0);

    return { request, projectContext, toolDefs };
  }
}
