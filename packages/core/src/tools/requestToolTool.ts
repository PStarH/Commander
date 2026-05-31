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
export function createRequestToolTool(
  getToolSchema: (name: string) => ToolDefinition | undefined,
  registryTools: string[],
): Tool {
  const definition: ToolDefinition = {
    name: 'request_tool',
    description: 'Request the full schema of an available tool. Use this when you need to call a tool that is listed in the "Additional Tools" section of your system prompt. Returns the tool\'s complete input schema so you can construct a proper tool call.',
    category: 'meta',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'Name of the tool to request. Must be one of the tools listed in the "Additional Tools" section.',
          enum: registryTools.length > 0 ? registryTools : undefined,
        },
      },
      required: ['tool_name'],
    },
  };

  return {
    definition,
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = args.tool_name as string;

      if (!toolName) {
        return JSON.stringify({ error: 'tool_name is required' });
      }

      const schema = getToolSchema(toolName);
      if (!schema) {
        return JSON.stringify({
          error: `Tool "${toolName}" not found. Available: ${registryTools.join(', ')}`,
        });
      }

      // Return the full schema so the LLM can use it
      return JSON.stringify({
        name: schema.name,
        description: schema.description,
        input_schema: schema.inputSchema,
        examples: schema.examples?.slice(0, 2), // Limit examples to save tokens
      }, null, 2);
    },
  };
}
