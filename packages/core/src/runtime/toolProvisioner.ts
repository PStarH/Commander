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
  const lower = goal.toLowerCase();
  let provisioned = false;

  // Use shared scored intent classification
  const { bestIntent, scores } = classifyProvisionIntent(goal);
  if (!bestIntent) return false;

  // --- Calculation ---
  if (bestIntent === 'calculation' && tools.has('python_execute')) {
    const calcToolCall = { id: 'provision_calc', name: 'python_execute', arguments: { code: `import math\nprint(${goal.replace(/[^0-9+\-*/.() ]/g, '').trim()})` } };
    const cached = toolCache.get(calcToolCall);
    if (cached && !cached.error) {
      request.messages.push({ role: 'system', content: `[Tool: Calculation result]\n${cached.output.slice(0, 500)}` });
      provisioned = true;
    } else {
      try {
        const calcResult = await tools.get('python_execute')!.execute({ code: `import math\nprint(${goal.replace(/[^0-9+\-*/.() ]/g, '').trim()})` });
        if (calcResult && !calcResult.startsWith('Error')) {
          const toolResult: ToolResult = { toolCallId: 'provision_calc', name: 'python_execute', output: calcResult, durationMs: 0 };
          toolCache.set(calcToolCall, toolResult);
          request.messages.push({ role: 'system', content: `[Tool: Calculation result]\n${calcResult.slice(0, 500)}` });
          provisioned = true;
        }
      } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Provision python_execute failed', { error: (e as Error)?.message }); }
    }
  }

  // --- Web search ---
  if (bestIntent === 'web_search' && tools.has('web_search')) {
    const searchToolCall = { id: 'provision_search', name: 'web_search', arguments: { query: goal.slice(0, 100), numResults: 3 } };
    const cached = toolCache.get(searchToolCall);
    if (cached && !cached.error) {
      request.messages.push({ role: 'system', content: `[Tool: Web search results]\n${cached.output.slice(0, 1000)}` });
      provisioned = true;
    } else {
      try {
        const searchResult = await tools.get('web_search')!.execute({ query: goal.slice(0, 100), numResults: 3 });
        if (searchResult && !searchResult.startsWith('Error')) {
          const toolResult: ToolResult = { toolCallId: 'provision_search', name: 'web_search', output: searchResult, durationMs: 0 };
          toolCache.set(searchToolCall, toolResult);
          request.messages.push({ role: 'system', content: `[Tool: Web search results]\n${searchResult.slice(0, 1000)}` });
          provisioned = true;
        }
      } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Provision web_search failed', { error: (e as Error)?.message }); }
    }
  }

  // --- File read ---
  if (bestIntent === 'file_read' && tools.has('file_read')) {
    const fileMatch = goal.match(/(?:read|open|analyze|load|parse)\s+(?:the\s+)?(?:file\s+)?['"]?([\w./\\-]+\.[a-z]{2,4})['"]?/i);
    const filePath = fileMatch?.[1];
    if (filePath) {
      const readToolCall = { id: 'provision_read', name: 'file_read', arguments: { path: filePath } };
      const cached = toolCache.get(readToolCall);
      if (cached && !cached.error) {
        request.messages.push({ role: 'system', content: `[Tool: File content]\n${cached.output.slice(0, 2000)}` });
        provisioned = true;
      } else {
        try {
          const readResult = await tools.get('file_read')!.execute({ path: filePath });
          if (readResult && !readResult.startsWith('Error')) {
            const toolResult: ToolResult = { toolCallId: 'provision_read', name: 'file_read', output: readResult, durationMs: 0 };
            toolCache.set(readToolCall, toolResult);
            request.messages.push({ role: 'system', content: `[Tool: File content]\n${readResult.slice(0, 2000)}` });
            provisioned = true;
          }
        } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Provision file_read failed', { error: (e as Error)?.message }); }
      }
    }
  }

  // --- Code search ---
    if (bestIntent === 'code_search' && tools.has('code_search')) {
    const patternMatch = goal.match(/(TODO|FIXME|HACK|XXX|comment)/i);
    const pattern = patternMatch?.[1] ?? goal.replace(/count |find |search |all |the |in |this |project |code /gi, '').trim().slice(0, 50);
    const searchToolCall = { id: 'provision_search_code', name: 'code_search', arguments: { pattern, maxResults: 30, contextLines: 2 } };
    const cached = toolCache.get(searchToolCall);
    if (cached && !cached.error) {
      request.messages.push({ role: 'system', content: `[Tool: Code search results for "${pattern}"]\n${cached.output.slice(0, 2000)}` });
      provisioned = true;
    } else {
      try {
        const searchResult = await tools.get('code_search')!.execute({ pattern, maxResults: 30, contextLines: 2 });
        if (searchResult && !searchResult.startsWith('Error') && !searchResult.startsWith('No results')) {
          const toolResult: ToolResult = { toolCallId: 'provision_search_code', name: 'code_search', output: searchResult, durationMs: 0 };
          toolCache.set(searchToolCall, toolResult);
          request.messages.push({ role: 'system', content: `[Tool: Code search results for "${pattern}"]\n${searchResult.slice(0, 2000)}` });
          provisioned = true;
        }
      } catch (e) { getGlobalLogger().debug('AgentRuntime', 'Provision code_search failed', { error: (e as Error)?.message }); }
    }
  }

  return provisioned;
}
