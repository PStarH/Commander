import { reportSilentFailure } from '../../silentFailureReporter';
import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage } from '../types';
import { getGlobalLogger } from '../../logging';

/**
 * AWS Bedrock Provider — invoke foundation models via AWS Bedrock.
 *
 * Uses the Bedrock Runtime Converse API for structured chat + tool calls.
 * Falls back to InvokeModel (Anthropic Messages API format) for edge cases.
 *
 * Models: anthropic.claude-sonnet-4-6-v1,
 *         anthropic.claude-opus-4-6-v1,
 *         anthropic.claude-haiku-4-5-v1:0,
 *         anthropic.claude-opus-4-5-20251101-v1:0,
 *         anthropic.claude-sonnet-4-5-20250929-v1:0,
 *         anthropic.claude-mythos-preview-v1
 *
 * Env: AWS_REGION or AWS_DEFAULT_REGION (default: us-east-1)
 *       AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_PROFILE)
 *       BEDROCK_MODEL (optional)
 *
 * Note: Claude 4.x models have up to 60-minute inference timeouts.
 * The SDK client is configured with a 10-minute request timeout.
 *
 * Requires: npm install @aws-sdk/client-bedrock-runtime
 */
export class BedrockProvider implements LLMProvider {
  readonly name = 'bedrock';
  private region: string;
  private defaultModel: string;
  private sdk: {
    BedrockRuntimeClient: new (config: Record<string, unknown>) => {
      send: (command: unknown) => Promise<unknown>;
    };
    ConverseCommand: new (body: Record<string, unknown>) => unknown;
    InvokeModelCommand: new (body: Record<string, unknown>) => unknown;
  } | null = null;
  private sdkLoaded = false;

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }) {
    this.region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    this.defaultModel =
      config.defaultModel || process.env.BEDROCK_MODEL || 'anthropic.claude-sonnet-4-6-v1';
  }

  private async loadSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    try {
      // String variable avoids compile-time module resolution (SDK is optional)
      const MODULE_NAME = '@aws-sdk/client-bedrock-runtime';
      const bedrockModule = (await import(MODULE_NAME)) as unknown as {
        BedrockRuntimeClient: new (config: Record<string, unknown>) => {
          send: (command: unknown) => Promise<unknown>;
        };
        ConverseCommand: new (...args: unknown[]) => unknown;
        InvokeModelCommand: new (...args: unknown[]) => unknown;
      };
      this.sdk = bedrockModule;
      this.sdkLoaded = true;
    } catch (err) {
      reportSilentFailure(err, 'bedrockProvider:60');
      throw new Error(
        'AWS Bedrock SDK not found. Install it: npm install @aws-sdk/client-bedrock-runtime',
      );
    }
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    await this.loadSDK();
    const model = request.model || this.defaultModel;

    // Build messages in Bedrock Converse format
    const messages = this.buildMessages(request);
    const system = this.buildSystem(request);

    const body: Record<string, unknown> = {
      modelId: model,
      messages,
      inferenceConfig: {
        maxTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (system) body.system = system;

    // Map tools to Bedrock tool format
    if (request.tools && request.tools.length > 0) {
      body.toolConfig = {
        tools: request.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.inputSchema },
          },
        })),
      };
    }

    // Prompt caching via Bedrock Converse cachePoint breakpoints.
    // Bedrock uses explicit cachePoint markers (not Anthropic cache_control).
    // Limits: max 4 cachePoints per request; 1h-TTL breakpoints must precede
    // 5m-TTL ones. We inject at most one breakpoint per block here, so ordering
    // and count stay within bounds.
    if (request.cacheConfig?.useCacheControl) {
      const ttl = request.cacheConfig.cacheTtl ?? '5m';
      // Append a cachePoint to the system block (only if a system block exists)
      if (Array.isArray(body.system) && (body.system as unknown[]).length > 0) {
        (body.system as unknown[]).push({
          text: '',
          cachePoint: { type: 'default', ttl },
        });
      }
      // Append a cachePoint tool entry (only when tools are present)
      const toolsArr = body.toolConfig
        ? (body.toolConfig as { tools?: unknown[] }).tools
        : undefined;
      if (Array.isArray(toolsArr) && toolsArr.length > 0) {
        toolsArr.push({
          toolSpec: {
            name: '__cache_point__',
            description: '',
            inputSchema: { json: { type: 'object' } },
          },
          cachePoint: { type: 'default', ttl },
        });
      }
    }

    // Extended Thinking for Claude models (Bedrock Converse API).
    // additionalModelRequestFields.thinking enables chain-of-thought reasoning
    // before the visible response. Only Claude models support this field.
    if (request.reasoningConfig?.enabled && /claude/i.test(model)) {
      body.additionalModelRequestFields = {
        thinking: {
          type: 'enabled',
          budget_tokens: request.reasoningConfig.budget ?? 4096,
        },
      };
    }

    try {
      if (!this.sdk) {
        throw new Error('Bedrock SDK not loaded');
      }
      const client = new this.sdk.BedrockRuntimeClient({
        region: this.region,
        requestHandler: { requestTimeout: 600_000 },
      });
      const command = new this.sdk.ConverseCommand(body);
      const response = (await client.send(command)) as {
        body?: Uint8Array;
        output?:
          | {
              message?:
                | {
                    content?:
                      | Array<{
                          text?: string;
                          toolUse?: { toolUseId: string; name: string; input: unknown };
                          reasoningContent?: { reasoningText?: { text?: string } };
                        }>
                      | undefined;
                  }
                | undefined;
            }
          | undefined;
        stopReason?: string | undefined;
        usage?:
          | {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheWriteInputTokens?: number;
            }
          | undefined;
      };
      return this.parseResponse(
        JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as {
          output?:
            | {
                message?:
                  | {
                      content?:
                        | Array<{
                            text?: string;
                            toolUse?: { toolUseId: string; name: string; input: unknown };
                            reasoningContent?: { reasoningText?: { text?: string } };
                          }>
                        | undefined;
                    }
                  | undefined;
              }
            | undefined;
          stopReason?: string | undefined;
          usage?:
            | {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadInputTokens?: number;
                cacheWriteInputTokens?: number;
              }
            | undefined;
        },
        model,
      );
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (
        e instanceof Error &&
        [
          'AccessDeniedException',
          'ValidationException',
          'ModelErrorException',
          'ModelTimeoutException',
        ].includes(e.name)
      ) {
        getGlobalLogger().debug('BedrockProvider', 'Converse API failed, trying invokeModel', {
          error: errMsg,
        });
        return this.callInvokeModel(request, model);
      }
      throw new Error(`Bedrock API error: ${errMsg}`);
    }
  }

  private buildMessages(request: LLMRequest): Array<{
    role: string;
    content: Array<{
      text?: string;
      toolUse?: Record<string, unknown>;
      toolResult?: Record<string, unknown>;
    }>;
  }> {
    const messages: Array<{
      role: string;
      content: Array<{
        text?: string;
        toolUse?: Record<string, unknown>;
        toolResult?: Record<string, unknown>;
      }>;
    }> = [];
    for (const m of request.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        // Find the corresponding tool result content
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.content.push({
            toolResult: {
              toolUseId: m.tool_call_id || '',
              content: [{ text: m.content }],
              status: 'success',
            },
          });
        }
        continue;
      }

      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content: Array<{ text?: string; toolUse?: Record<string, unknown> }> = [];

      if (m.content) {
        content.push({ text: m.content });
      }

      // Map tool_calls from assistant
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          content.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            },
          });
        }
      }

      messages.push({ role, content });
    }
    return messages;
  }

  private buildSystem(request: LLMRequest): Array<{ text: string }> | undefined {
    const systemMsg = request.messages.find((m) => m.role === 'system');
    return systemMsg ? [{ text: systemMsg.content }] : undefined;
  }

  private parseResponse(
    response: {
      output?: {
        message?: {
          content?: Array<{
            text?: string;
            toolUse?: { toolUseId: string; name: string; input: unknown };
            reasoningContent?: { reasoningText?: { text?: string } };
          }>;
        };
      };
      stopReason?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    },
    model: string,
  ): LLMResponse {
    const output = response.output || {};
    const message = output.message || {};
    const content = message.content || [];
    const textParts = content.filter((c): c is typeof c & { text: string } => !!c.text);
    const toolUseParts = content.filter(
      (c): c is typeof c & { toolUse: { toolUseId: string; name: string; input: unknown } } =>
        !!c.toolUse,
    );
    // Extended Thinking: concatenate reasoningText blocks into the `thinking` field.
    const reasoningParts = content.filter(
      (c): c is typeof c & { reasoningContent: { reasoningText?: { text?: string } } } =>
        !!c.reasoningContent,
    );
    const thinking = reasoningParts
      .map((c) => c.reasoningContent.reasoningText?.text ?? '')
      .filter((t) => t.length > 0)
      .join('');

    const stopReason = response.stopReason || 'end_turn';

    // With prompt caching enabled, inputTokens only counts non-cached input;
    // cacheReadInputTokens and cacheWriteInputTokens are billed separately.
    // totalTokens must aggregate all input sources plus output.
    const inputTokens = response.usage?.inputTokens ?? 0;
    const outputTokens = response.usage?.outputTokens ?? 0;
    const cacheReadTokens = response.usage?.cacheReadInputTokens ?? 0;
    const cacheWriteTokens = response.usage?.cacheWriteInputTokens ?? 0;

    const usage: TokenUsage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };

    return {
      content: textParts.map((c) => c.text).join(''),
      model,
      usage,
      thinking: thinking || undefined,
      finishReason:
        stopReason === 'end_turn'
          ? 'stop'
          : stopReason === 'tool_use'
            ? 'tool_calls'
            : stopReason === 'max_tokens'
              ? 'length'
              : 'stop',
      toolCalls:
        toolUseParts.length > 0
          ? toolUseParts.map((c) => ({
              id: c.toolUse.toolUseId,
              name: c.toolUse.name,
              arguments: (c.toolUse.input ?? {}) as Record<string, unknown>,
            }))
          : undefined,
    };
  }

  private async callInvokeModel(request: LLMRequest, model: string): Promise<LLMResponse> {
    // Use Anthropic Messages API format for InvokeModel fallback.
    // This is the standard format for Claude 3+ and handles the
    // most common Bedrock use case (Claude models).
    const messages = this.buildMessages(request);
    const system = this.buildSystem(request);

    const anthropicPayload: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      messages,
    };

    if (system) anthropicPayload.system = system;

    const body: Record<string, unknown> = {
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(anthropicPayload)),
    };

    try {
      if (!this.sdk) {
        throw new Error('Bedrock SDK not loaded');
      }
      const client = new this.sdk.BedrockRuntimeClient({
        region: this.region,
        requestHandler: { requestTimeout: 600_000 },
      });
      const command = new this.sdk.InvokeModelCommand(body);
      const response = (await client.send(command)) as { body?: Uint8Array };
      const data = JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as {
        content?: Array<{ text?: string }> | undefined;
        completion?: string | undefined;
        generation?: string | undefined;
        usage?:
          | {
              // Anthropic Messages API native fields (snake_case)
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              // camelCase aliases kept for backward compatibility
              inputTokens?: number;
              outputTokens?: number;
            }
          | undefined;
        stop_reason?: string | undefined;
      };

      // Messages API response: data.content[0].text
      // Legacy Text Completions response: data.completion
      const content = data.content?.[0]?.text || data.completion || data.generation || '';

      // InvokeModel returns Anthropic-native snake_case usage. Prefer snake_case
      // (always present for Claude), fall back to camelCase for compatibility.
      // With caching, input_tokens only counts non-cached input, so totalTokens
      // aggregates all input sources plus output.
      const inTokens = data.usage?.input_tokens ?? data.usage?.inputTokens ?? 0;
      const outTokens = data.usage?.output_tokens ?? data.usage?.outputTokens ?? 0;
      const cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = data.usage?.cache_creation_input_tokens ?? 0;

      return {
        content,
        model,
        usage: {
          promptTokens: inTokens,
          completionTokens: outTokens,
          totalTokens: inTokens + cacheReadTokens + cacheWriteTokens + outTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        finishReason:
          data.stop_reason === 'end_turn'
            ? 'stop'
            : data.stop_reason === 'max_tokens'
              ? 'length'
              : 'stop',
      };
    } catch (e: unknown) {
      throw new Error(`Bedrock invokeModel error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
