import { z } from 'zod';

const stringRecordSchema = z.record(z.string(), z.string());

export const invokeCommanderToolInputSchema = z
  .object({
    mode: z.enum(['deterministic', 'live']),
    model: z.string().min(1).optional(),
    modelApi: z.enum(['responses', 'chat_completions']).optional(),
    modelBaseUrl: z.url().optional(),
    toolName: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    mcpCommand: z.string().min(1),
    mcpArgs: z.array(z.string()).default([]),
    mcpCwd: z.string().min(1).optional(),
    mcpEnv: stringRecordSchema.default({}),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  })
  .superRefine((input, context) => {
    if (input.mode === 'live' && !input.model) {
      context.addIssue({ code: 'custom', message: 'LIVE_MODEL_REQUIRED', path: ['model'] });
    }
  });

export type InvokeCommanderToolInput = z.infer<typeof invokeCommanderToolInputSchema>;

export interface InvokeCommanderToolResult {
  schema: 'commander-openai-agents-mcp-invocation/v1';
  transport: 'mcp-stdio';
  runtime: 'openai-agents-sdk';
  agentPid: number;
  toolName: string;
  discoveredTools: string[];
  gatewayPayload: unknown;
  model?: string;
  openaiRequestOrTraceId?: string;
}
