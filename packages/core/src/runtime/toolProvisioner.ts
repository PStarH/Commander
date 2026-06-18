/**
 * Pre-LLM tool provisioning: detect tool needs, execute tools, inject results.
 * Bridges the GAIA gap where LLM answers without calling tools.
 *
 * Extracted from agentRuntime.ts to keep the runtime under 500 lines.
 */

import type { LLMRequest, Tool, ToolResult } from './types';
import { classifyProvisionIntent } from './taskAnalyzer';
import { ToolResultCache } from './toolResultCache';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Provisioned tool result injection config
// ============================================================================

interface ProvisionConfig {
  toolName: string;
  toolCallId: string;
  label: string;
  maxOutputChars: number;
  buildArgs: (goal: string) => Record<string, unknown>;
  validateOutput?: (output: string) => boolean;
}

// ============================================================================
// Shared provisioning helper — eliminates duplicated cache-check-execute pattern
// ============================================================================

async function provisionTool(
  config: ProvisionConfig,
  goal: string,
  request: LLMRequest,
  tools: Map<string, Tool>,
  toolCache: ToolResultCache,
): Promise<boolean> {
  const tool = tools.get(config.toolName);
  if (!tool) return false;

  const toolCall = {
    id: config.toolCallId,
    name: config.toolName,
    arguments: config.buildArgs(goal),
  };
  const cached = toolCache.get(toolCall);

  if (cached && !cached.error) {
    request.messages.push({
      role: 'system',
      content: `[Tool: ${config.label}]\n${cached.output.slice(0, config.maxOutputChars)}`,
    });
    return true;
  }

  try {
    const result = await tool.execute(toolCall.arguments);
    const isValid = config.validateOutput
      ? config.validateOutput(result)
      : result && !result.startsWith('Error');
    if (isValid) {
      const toolResult: ToolResult = {
        toolCallId: config.toolCallId,
        name: config.toolName,
        output: result,
        durationMs: 0,
      };
      toolCache.set(toolCall, toolResult);
      request.messages.push({
        role: 'system',
        content: `[Tool: ${config.label}]\n${result.slice(0, config.maxOutputChars)}`,
      });
      return true;
    }
  } catch (e) {
    getGlobalLogger().debug('AgentRuntime', `Provision ${config.toolName} failed`, {
      error: (e as Error)?.message,
    });
  }

  return false;
}

// ============================================================================
// Tool provisioning configs
// ============================================================================

const PROVISION_CONFIGS: ProvisionConfig[] = [
  {
    toolName: 'python_execute',
    toolCallId: 'provision_calc',
    label: 'Calculation result',
    maxOutputChars: 500,
    buildArgs: (goal) => ({
      code: `import math\nprint(${goal.replace(/[^0-9+\-*/.() ]/g, '').trim()})`,
    }),
  },
  {
    toolName: 'web_search',
    toolCallId: 'provision_search',
    label: 'Web search results',
    maxOutputChars: 1000,
    buildArgs: (goal) => ({ query: goal.slice(0, 100), numResults: 3 }),
  },
  {
    toolName: 'file_read',
    toolCallId: 'provision_read',
    label: 'File content',
    maxOutputChars: 2000,
    buildArgs: (goal) => {
      const fileMatch = goal.match(
        /(?:read|open|analyze|load|parse)\s+(?:the\s+)?(?:file\s+)?['"]?([\w./\\-]+\.[a-z]{2,4})['"]?/i,
      );
      return { path: fileMatch?.[1] ?? '' };
    },
    validateOutput: (output) => {
      // For file_read, we also check that we got a valid path
      return !output.startsWith('Error') && output.length > 0;
    },
  },
  {
    toolName: 'code_search',
    toolCallId: 'provision_search_code',
    label: 'Code search results',
    maxOutputChars: 2000,
    buildArgs: (goal) => {
      const patternMatch = goal.match(/(TODO|FIXME|HACK|XXX|comment)/i);
      const pattern =
        patternMatch?.[1] ??
        goal
          .replace(/count |find |search |all |the |in |this |project |code /gi, '')
          .trim()
          .slice(0, 50);
      return { pattern, maxResults: 30, contextLines: 2 };
    },
    validateOutput: (output) => !output.startsWith('Error') && !output.startsWith('No results'),
  },
];

// ============================================================================
// Intent → config mapping
// ============================================================================

const INTENT_TO_CONFIG: Record<string, ProvisionConfig> = {
  calculation: PROVISION_CONFIGS[0],
  web_search: PROVISION_CONFIGS[1],
  file_read: PROVISION_CONFIGS[2],
  code_search: PROVISION_CONFIGS[3],
};

/**
 * Pre-LLM tool provisioning: detect tool needs and inject results before LLM sees the question.
 * Uses scored intent classification for accuracy.
 */
export async function provisionTools(
  goal: string,
  request: LLMRequest,
  tools: Map<string, Tool>,
  toolCache: ToolResultCache,
): Promise<boolean> {
  const { bestIntent } = classifyProvisionIntent(goal);
  if (!bestIntent) return false;

  const config = INTENT_TO_CONFIG[bestIntent];
  if (!config) return false;

  return provisionTool(config, goal, request, tools, toolCache);
}
