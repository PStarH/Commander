/**
 * RuntimeGuardianBridge — Connects the harness-level GuardianService
 * (LLM-based tool call reviewer) to the runtime-level ToolExecutionService.
 *
 * Problem: GuardianService was designed for the harness layer and requires
 * HarnessServices (which provides LLM providers). The ToolExecutionService
 * is lower-level and doesn't have direct provider access. This bridge
 * decouples the two: it's initialized with a provider factory at startup
 * and exposes a simple async check that the runtime can call.
 *
 * Usage:
 *   1. At startup (serviceInitializer): initializeRuntimeGuardian(providerFactory, config)
 *   2. Before tool execution (toolExecutionService): await reviewToolCall(toolCall, goal)
 *   3. If no provider is available, the bridge falls back to rule-based
 *      checks (complementing GuardianAgent's existing checks)
 */

import type { ToolCall } from './types';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

export interface RuntimeGuardianConfig {
  enabled: boolean;
  model: string;
  providerName: string;
  maxTokens: number;
  /** Timeout for LLM review in ms (default: 5000) */
  timeoutMs: number;
}

export const DEFAULT_RUNTIME_GUARDIAN_CONFIG: RuntimeGuardianConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  providerName: 'openai',
  maxTokens: 512,
  timeoutMs: 5000,
};

export interface RuntimeGuardianDecision {
  approved: boolean;
  reason: string;
  reviewed: boolean;
}

/** Provider factory — returns a provider by name, or null */
export type ProviderFactory = (name: string) => {
  call: (input: {
    model: string;
    messages: { role: string; content: string }[];
    maxTokens: number;
  }) => Promise<{ content?: string }>;
} | null;

// --- Singleton state ---
let providerFactory: ProviderFactory | null = null;
let config: RuntimeGuardianConfig = { ...DEFAULT_RUNTIME_GUARDIAN_CONFIG };

// Tools that are always safe — skip LLM review
const SAFE_TOOLS = new Set([
  'file_read',
  'file_search',
  'file_list',
  'code_search',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'read_file',
  'list_files',
  'search_code',
]);

/**
 * Initialize the runtime guardian with a provider factory.
 * Called from serviceInitializer.ts after providers are set up.
 */
export function initializeRuntimeGuardian(
  factory: ProviderFactory,
  overrideConfig?: Partial<RuntimeGuardianConfig>,
): void {
  providerFactory = factory;
  config = { ...DEFAULT_RUNTIME_GUARDIAN_CONFIG, ...overrideConfig };
  getGlobalLogger().info('RuntimeGuardian', 'Initialized', {
    enabled: config.enabled,
    model: config.model,
    provider: config.providerName,
  });
}

/**
 * Check if the runtime guardian is available (has a provider factory).
 */
export function isRuntimeGuardianAvailable(): boolean {
  return providerFactory !== null && config.enabled;
}

/**
 * Reset the runtime guardian state — clears cache, provider factory, and config.
 * Used for test isolation.
 */
export function resetRuntimeGuardian(): void {
  providerFactory = null;
  config = { ...DEFAULT_RUNTIME_GUARDIAN_CONFIG };
  reviewCache.clear();
}

// --- LLM review result cache ---
// Cache recent decisions by (toolName, argsHash) to avoid redundant LLM calls.
// Entries expire after 5 minutes or when the cache reaches 200 entries.
interface CacheEntry {
  decision: RuntimeGuardianDecision;
  expiresAt: number;
}
const reviewCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 200;

function getCacheKey(toolCall: ToolCall): string {
  const argsStr = JSON.stringify(toolCall.arguments);
  let hash = 0;
  for (let i = 0; i < argsStr.length; i++) {
    hash = ((hash << 5) - hash + argsStr.charCodeAt(i)) | 0;
  }
  return `${toolCall.name}:${hash}`;
}

function getCachedDecision(key: string): RuntimeGuardianDecision | null {
  const entry = reviewCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    reviewCache.delete(key);
    return null;
  }
  return entry.decision;
}

function setCachedDecision(key: string, decision: RuntimeGuardianDecision): void {
  if (reviewCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entries (first inserted)
    const firstKey = reviewCache.keys().next().value;
    if (firstKey) reviewCache.delete(firstKey);
  }
  reviewCache.set(key, { decision, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Review a tool call using LLM-based semantic analysis.
 *
 * This complements GuardianAgent's rule-based checks with semantic
 * understanding — e.g., "is `shell_execute({ command: 'curl ... | bash' })`
 * dangerous even though it doesn't match any regex pattern?"
 *
 * Falls open (approves) on errors to avoid blocking runs.
 * Results are cached for 5 minutes to reduce LLM cost and latency.
 */
export async function reviewToolCall(
  toolCall: ToolCall,
  goal: string,
): Promise<RuntimeGuardianDecision> {
  // If not enabled or no provider, skip (GuardianAgent rules still apply)
  if (!config.enabled || !providerFactory) {
    return { approved: true, reason: 'Runtime guardian not available', reviewed: false };
  }

  // Fast-path: safe tools don't need LLM review
  if (SAFE_TOOLS.has(toolCall.name)) {
    return { approved: true, reason: 'Safe tool — auto-approved', reviewed: false };
  }

  // Check cache before making an LLM call
  const cacheKey = getCacheKey(toolCall);
  const cached = getCachedDecision(cacheKey);
  if (cached) {
    return { ...cached, reason: `${cached.reason} (cached)` };
  }

  const provider = providerFactory(config.providerName);
  if (!provider) {
    return {
      approved: true,
      reason: `Provider "${config.providerName}" not available — auto-approved`,
      reviewed: false,
    };
  }

  const prompt = buildReviewPrompt(toolCall, goal);

  try {
    // Race the LLM call against a timeout. Use a timer that we clearTimeout
    // to avoid leaking timers when the LLM responds before the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ content?: string }>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Runtime guardian timeout')), config.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const response = await Promise.race([
        provider.call({
          model: config.model,
          messages: [{ role: 'system', content: prompt }],
          maxTokens: config.maxTokens,
        }),
        timeoutPromise,
      ]);

      if (!response?.content) {
        const decision: RuntimeGuardianDecision = {
          approved: true,
          reason: 'Guardian returned empty — auto-approved',
          reviewed: true,
        };
        setCachedDecision(cacheKey, decision);
        return decision;
      }

      const parsed = parseDecision(response.content);
      const decision: RuntimeGuardianDecision = {
        approved: parsed.approved,
        reason: parsed.reason,
        reviewed: true,
      };
      setCachedDecision(cacheKey, decision);
      return decision;
    } finally {
      // Always clear the timeout timer to prevent leaks
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    // Fail-open on errors — GuardianAgent rules still provide baseline protection
    reportSilentFailure(err, 'runtimeGuardian:review');
    return {
      approved: true,
      reason: 'Guardian review failed — auto-approved (fail-open)',
      reviewed: false,
    };
  }
}

function buildReviewPrompt(toolCall: ToolCall, goal: string): string {
  const argsStr = JSON.stringify(toolCall.arguments, null, 2).slice(0, 2000);
  return `You are a safety Guardian reviewing a tool call for an AI agent.

Task goal: "${goal.slice(0, 500)}"

Tool call:
  name: ${toolCall.name}
  arguments: ${argsStr}

Evaluate whether this tool call is safe to execute. Consider:
1. Could this command cause irreversible damage (data loss, system compromise)?
2. Does the command match the stated goal, or is it suspicious/hijacked?
3. Are there destructive patterns (rm -rf, drop table, force push, etc.)?
4. Could this exfiltrate sensitive data or modify production systems?

Respond in EXACTLY this format:
APPROVED: true|false
REASON: <one sentence explanation>
SUGGESTION: <optional safer alternative>`;
}

function parseDecision(content: string): { approved: boolean; reason: string } {
  const approvedMatch = content.match(/APPROVED:\s*(true|false)/i);
  const reasonMatch = content.match(/REASON:\s*(.+)/i);

  return {
    approved: approvedMatch ? approvedMatch[1].toLowerCase() === 'true' : true,
    reason: reasonMatch ? reasonMatch[1].trim() : 'Guardian review complete',
  };
}
