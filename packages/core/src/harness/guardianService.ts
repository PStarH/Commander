/**
 * Guardian Service — Automated approval reviewer.
 *
 * Extracted from CodeAgentHarness so both CodeAgentHarness and Tier1Harness
 * can share the same Guardian approval logic.
 *
 * Pattern from OpenAI Codex CLI:
 * - A secondary (cheaper) LLM reviews tool calls before execution
 * - Returns structured approval decision
 * - Fails CLOSED: if the reviewer cannot render a decision (provider missing,
 *   empty/unparseable response, or an error) the tool call is denied. A safety
 *   gate that auto-approves when it cannot decide provides no guarantee.
 * - Read-only tools are auto-approved without LLM call
 */

import type { ToolCall } from '../runtime/types';
import type { HarnessServices } from './harnessTypes';
import { getGlobalLogger } from '../logging';
import { extractDecisionObject } from './decisionJson';

export interface GuardianConfig {
  enabled: boolean;
  model: string;
  provider: string;
  maxTokens: number;
  tools: string[];
}

export const DEFAULT_GUARDIAN_CONFIG: GuardianConfig = {
  enabled: true,
  model: 'gpt-4o-mini',
  provider: 'openai',
  maxTokens: 512,
  tools: ['file_read', 'file_search', 'code_search'],
};

export interface GuardianDecision {
  approved: boolean;
  reason: string;
  suggestion?: string;
}

const ALWAYS_APPROVE_TOOLS = new Set([
  'file_read',
  'file_search',
  'file_list',
  'code_search',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
]);

const AUTO_APPROVE_EDIT_TOOLS = new Set(['file_write', 'file_edit']);

export class GuardianService {
  private config: GuardianConfig;

  constructor(config?: Partial<GuardianConfig>) {
    this.config = { ...DEFAULT_GUARDIAN_CONFIG, ...config };
  }

  updateConfig(config: Partial<GuardianConfig>): void {
    this.config = { ...this.config, ...config };
    getGlobalLogger().info(
      'GuardianService',
      `Config updated: enabled=${this.config.enabled}, model=${this.config.model}`,
    );
  }

  getConfig(): GuardianConfig {
    return { ...this.config };
  }

  /**
   * Review a tool call and return an approval decision.
   */
  async review(
    toolCall: ToolCall,
    goal: string,
    services: HarnessServices,
    _tenantId?: string,
  ): Promise<GuardianDecision> {
    if (!this.config.enabled) {
      return { approved: true, reason: 'Guardian disabled — auto-approved' };
    }

    // Fast-path: read-only tools are always safe
    if (ALWAYS_APPROVE_TOOLS.has(toolCall.name)) {
      return { approved: true, reason: 'Read-only tool — auto-approved' };
    }

    // Edit tools are approved via hashline/file policy
    if (AUTO_APPROVE_EDIT_TOOLS.has(toolCall.name)) {
      return { approved: true, reason: 'File editing tool — auto-approved via policy' };
    }

    const guardianPrompt = this.buildPrompt(toolCall, goal);

    try {
      const provider = services.getProvider(this.config.provider);
      if (!provider) {
        return {
          approved: false,
          reason: `Guardian provider "${this.config.provider}" not available — denied (fail-closed)`,
        };
      }

      const response = await provider.call({
        model: this.config.model,
        messages: [{ role: 'system', content: guardianPrompt }],
        maxTokens: this.config.maxTokens,
      });

      if (!response?.content) {
        return {
          approved: false,
          reason: 'Guardian returned empty response — denied (fail-closed)',
        };
      }

      const parsed = this.parseDecision(response.content);
      return {
        approved: parsed.approved === true,
        reason: parsed.reason || 'Guardian review complete',
        suggestion: parsed.suggestion,
      };
    } catch (err) {
      getGlobalLogger().warn('GuardianService', 'Review failed, denying', {
        error: (err as Error)?.message,
      });
      return { approved: false, reason: 'Guardian check failed — denied (fail-closed)' };
    }
  }

  private buildPrompt(toolCall: ToolCall, goal: string): string {
    return `You are a safety Guardian reviewing a tool call.

Task goal: "${goal.slice(0, 500)}"

Tool call to review:
  Tool: ${toolCall.name}
  Arguments: ${JSON.stringify(toolCall.arguments, null, 2)}

Decide if this tool call is:
1. SAFE — aligned with the task goal, no destructive side effects
2. RISKY — potentially dangerous (destructive commands, network access, data deletion)
3. MISALIGNED — not relevant to the task goal

Respond with JSON:
{
  "approved": true/false,
  "reason": "brief explanation",
  "suggestion": "alternative approach if rejected (optional)"
}`;
  }

  private parseDecision(content: string): {
    approved: boolean;
    reason: string;
    suggestion?: string;
  } {
    const parsed = extractDecisionObject(content, 'approved');
    if (!parsed) {
      return {
        approved: false,
        reason: 'Could not parse Guardian response — denied (fail-closed)',
      };
    }
    return {
      approved: parsed.approved === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'Guardian review complete',
      suggestion: typeof parsed.suggestion === 'string' ? parsed.suggestion : undefined,
    };
  }
}
