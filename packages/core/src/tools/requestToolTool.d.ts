/**
 * Request Tool - On-demand tool schema loading
 *
 * This tool allows the LLM to request the full schema of a tool that is
 * currently in the "registry" tier (name + description only). When called,
 * the tool returns the full JSON schema so the LLM can use it in the next turn.
 *
 * This is the key mechanism for lazy tool loading:
 * - Tier 1 tools (active): Full schema available immediately
 * - Tier 2 tools (registry): Listed in system prompt, schema available via request_tool
 *
 * Research basis (arXiv:2604.21816): This approach reduces per-turn tool tokens
 * from ~47k to ~2.4k (95% reduction) while maintaining tool availability.
 */
import type { Tool, ToolDefinition } from '../runtime/types';
/**
 * Create a request_tool tool that provides on-demand schema loading.
 *
 * @param getToolSchema - Function to retrieve a tool's full schema by name
 * @param registryTools - List of tools currently in the registry tier
 */
export declare function createRequestToolTool(getToolSchema: (name: string) => ToolDefinition | undefined, registryTools: string[]): Tool;
//# sourceMappingURL=requestToolTool.d.ts.map