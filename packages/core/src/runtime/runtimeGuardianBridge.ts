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
 *   3. Review is FAIL-CLOSED. When the guardian is ENABLED but no explicit
 *      provider decision can be obtained — missing provider, timeout, empty
 *      response, unparseable response, or any thrown error — the decision is
 *      `approved: false` with a "review unavailable" reason. Only an explicit,
 *      well-formed `APPROVED: true` from the provider approves a tool call.
 *   4. When `runtimeGuardian.enabled === false` the bridge is a documented
 *      pass-through: it approves without review (GuardianAgent's rule-based
 *      checks still run upstream). This is the only non-provider approval path.
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
  /**
   * True only when the provider returned an explicit, well-formed decision
   * that was actually used. Unavailable reviews are never `reviewed: true`.
   */
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
 * Reset the runtime guardian state — clears the provider factory and config.
 * Used for test isolation.
 */
export function resetRuntimeGuardian(): void {
  providerFactory = null;
  config = { ...DEFAULT_RUNTIME_GUARDIAN_CONFIG };
}

/**
 * Fail-closed outcome for an ENABLED review that could not produce an explicit
 * provider decision. The reason prefix distinguishes an unavailable review from
 * a policy denial, whose reason is the provider's own REASON text.
 */
function unavailable(detail: string): RuntimeGuardianDecision {
  return {
    approved: false,
    reason: `Runtime guardian review unavailable: ${detail}`,
    reviewed: false,
  };
}

/**
 * Review a tool call using LLM-based semantic analysis.
 *
 * This complements GuardianAgent's rule-based checks with semantic
 * understanding — e.g., "is `shell_execute({ command: 'curl ... | bash' })`
 * dangerous even though it doesn't match any regex pattern?"
 *
 * Fail-closed: for an ENABLED review, anything other than an explicit,
 * well-formed approval from the provider denies the tool call. A denial whose
 * reason starts with "Runtime guardian review unavailable" means the review
 * could not be performed (missing provider, timeout, empty/unparseable
 * response, thrown error); any other denial reason is the provider's policy
 * decision. No decision is cached: the bridge is a module singleton shared by
 * every runtime in the process, so a (tool, args) key cannot identify the
 * runtime, tenant, goal, provider or policy that produced a decision.
 */
export async function reviewToolCall(
  toolCall: ToolCall,
  goal?: string,
): Promise<RuntimeGuardianDecision> {
  // Explicitly disabled by the operator: documented pass-through. GuardianAgent
  // rules and the caller's other gates still run; this path is unchanged.
  if (!config.enabled) {
    return {
      approved: true,
      reason: 'Runtime guardian disabled — review skipped',
      reviewed: false,
    };
  }

  // Fast-path: safe tools don't need LLM review
  if (SAFE_TOOLS.has(toolCall.name)) {
    return { approved: true, reason: 'Safe tool — auto-approved', reviewed: false };
  }

  // Enabled review with no provider wired up is UNAVAILABLE, never an approval.
  if (!providerFactory) {
    return unavailable('no provider factory initialized');
  }

  const provider = providerFactory(config.providerName);
  if (!provider) {
    return unavailable(`provider "${config.providerName}" not available`);
  }

  const prompt = buildReviewPrompt(toolCall, goal);

  try {
    // Race the LLM call against a timeout. Use a timer that we clearTimeout
    // to avoid leaking timers when the LLM responds before the timeout.
    // The provider contract exposes no abort/cancellation channel, so the
    // timeout only unblocks this await; the finally below still clears the
    // timer so nothing leaks.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
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

      const parsed = parseDecision(response?.content);
      if (parsed.kind === 'unavailable') {
        return unavailable(parsed.detail);
      }
      return { approved: parsed.approved, reason: parsed.reason, reviewed: true };
    } finally {
      // Always clear the timeout timer to prevent leaks
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    // Fail closed: an enabled review that never produced a decision is
    // unavailable, not an approval.
    reportSilentFailure(err, 'runtimeGuardian:review');
    return unavailable(err instanceof Error ? err.message : String(err));
  }
}

function buildReviewPrompt(toolCall: ToolCall, goal?: string): string {
  const argsStr = JSON.stringify(toolCall.arguments, null, 2).slice(0, 2000);
  // Render the goal only when the caller actually has one. A genuinely absent
  // goal is omitted rather than fabricated into the prompt.
  const goalSection =
    typeof goal === 'string' && goal.trim() !== '' ? `Task goal: "${goal.slice(0, 500)}"\n\n` : '';

  return `You are a safety Guardian reviewing a tool call for an AI agent.

${goalSection}Tool call:
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

type ParsedDecision =
  { kind: 'decision'; approved: boolean; reason: string } | { kind: 'unavailable'; detail: string };

/**
 * Parse an explicit provider decision. Every response that does not carry a
 * well-formed `APPROVED: true|false` token is UNAVAILABLE — never an implicit
 * approval.
 */
function parseDecision(content: string | undefined): ParsedDecision {
  if (!content || content.trim() === '') {
    return { kind: 'unavailable', detail: 'provider returned an empty response' };
  }

  const approvedMatch = content.match(/APPROVED:\s*(true|false)/i);
  if (!approvedMatch) {
    return {
      kind: 'unavailable',
      detail: 'provider response contained no well-formed "APPROVED: true|false" decision',
    };
  }

  const reasonMatch = content.match(/REASON:\s*(.+)/i);
  return {
    kind: 'decision',
    approved: approvedMatch[1].toLowerCase() === 'true',
    reason: reasonMatch ? reasonMatch[1].trim() : 'Guardian review complete',
  };
}
