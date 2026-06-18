/**
 * Pre-LLM tool provisioning: detect tool needs, execute tools, inject results.
 * Bridges the GAIA gap where LLM answers without calling tools.
 *
 * Extracted from agentRuntime.ts to keep the runtime under 500 lines.
 */
import type { LLMRequest, Tool } from './types';
import { ToolResultCache } from './toolResultCache';
/**
 * Pre-LLM tool provisioning: detect tool needs and inject results before LLM sees the question.
 * Uses scored intent classification for accuracy.
 */
export declare function provisionTools(goal: string, request: LLMRequest, tools: Map<string, Tool>, toolCache: ToolResultCache): Promise<boolean>;
//# sourceMappingURL=toolProvisioner.d.ts.map