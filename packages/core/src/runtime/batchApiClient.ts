/**
 * BatchAPIClient — Native Batch API integration for OpenAI and Anthropic.
 *
 * Batch APIs offer 50% cost discount for non-urgent tasks with up to 24h
 * turnaround. This client handles:
 *   1. Submitting requests to the batch API
 *   2. Polling for completion (with configurable interval and max attempts)
 *   3. Retrieving results
 *   4. Fail-closed fallback: if batch fails or times out, falls back to
 *      standard API call (never blocks the user indefinitely)
 *
 * OpenAI Batch API: POST /v1/batches (JSONL file upload)
 *   - Max 50,000 requests per batch
 *   - 24h turnaround
 *   - 50% discount on input + output tokens
 *
 * Anthropic Message Batches: POST /v1/messages/batches
 *   - Max 100,000 requests per batch
 *   - 24h turnaround
 *   - 50% discount on input + output tokens
 */

import type { LLMRequest, LLMResponse, TokenUsage } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface BatchAPIConfig {
  /** Polling interval in ms (default: 10s for short batches) */
  pollIntervalMs: number;
  /** Maximum poll attempts before fallback (default: 60 = 10min at 10s interval) */
  maxPollAttempts: number;
  /** API key for the provider */
  apiKey: string;
  /** Base URL override */
  baseUrl?: string;
}

export interface BatchSubmissionResult {
  batchId: string;
  status: 'submitted' | 'failed';
  provider: 'openai' | 'anthropic';
  error?: string;
}

export interface BatchPollResult {
  status: 'completed' | 'failed' | 'expired' | 'in_progress' | 'cancelling' | 'cancelled';
  result?: LLMResponse;
  error?: string;
}

// ============================================================================
// OpenAI Batch API Client
// ============================================================================

/**
 * Submit a single request to OpenAI Batch API.
 * Returns a batch ID that can be polled for completion.
 *
 * OpenAI Batch API requires:
 * 1. Upload a JSONL file containing the request
 * 2. Create a batch referencing the file
 */
async function submitOpenAIBatch(
  request: LLMRequest,
  config: BatchAPIConfig,
): Promise<BatchSubmissionResult> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const model = request.model || 'gpt-4o';

  // Build the JSONL content for the batch request
  const customId = `cmdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    })),
    max_tokens: request.maxTokens ?? 4096,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }

  const jsonlLine = JSON.stringify({
    custom_id: customId,
    method: 'POST',
    url: '/v1/chat/completions',
    body,
  });

  try {
    // Step 1: Upload the JSONL file
    const uploadResponse = await fetch(`${baseUrl}/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: createMultipartForm(jsonlLine),
    });

    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      return {
        batchId: '',
        status: 'failed',
        provider: 'openai',
        error: `File upload failed: ${err}`,
      };
    }

    const uploadData = (await uploadResponse.json()) as { id: string };
    const fileId = uploadData.id;

    // Step 2: Create the batch
    const batchResponse = await fetch(`${baseUrl}/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        input_file_id: fileId,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
      }),
    });

    if (!batchResponse.ok) {
      const err = await batchResponse.text();
      return {
        batchId: '',
        status: 'failed',
        provider: 'openai',
        error: `Batch creation failed: ${err}`,
      };
    }

    const batchData = (await batchResponse.json()) as { id: string };
    return { batchId: batchData.id, status: 'submitted', provider: 'openai' };
  } catch (err) {
    return {
      batchId: '',
      status: 'failed',
      provider: 'openai',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Poll OpenAI batch status until completion or timeout.
 */
async function pollOpenAIBatch(batchId: string, config: BatchAPIConfig): Promise<BatchPollResult> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';

  for (let attempt = 0; attempt < config.maxPollAttempts; attempt++) {
    await sleep(config.pollIntervalMs);

    try {
      const response = await fetch(`${baseUrl}/batches/${batchId}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      if (!response.ok) {
        const err = await response.text();
        getGlobalLogger().warn(
          'BatchAPIClient',
          `OpenAI batch poll error (attempt ${attempt + 1})`,
          { error: err },
        );
        continue;
      }

      const data = (await response.json()) as {
        status: string;
        output_file_id?: string;
        error_file_id?: string;
        errors?: { object: string; message: string }[];
      };

      if (data.status === 'completed') {
        // Retrieve the output file
        if (data.output_file_id) {
          const fileResponse = await fetch(`${baseUrl}/files/${data.output_file_id}/content`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
          if (fileResponse.ok) {
            const fileContent = await fileResponse.text();
            return parseOpenAIBatchResult(fileContent);
          }
        }
        return { status: 'completed', error: 'No output file in completed batch' };
      }

      if (data.status === 'failed' || data.status === 'expired' || data.status === 'cancelled') {
        const errMsg = data.errors?.[0]?.message ?? `Batch ${data.status}`;
        return { status: data.status as BatchPollResult['status'], error: errMsg };
      }
      // status: 'in_progress' | 'finalizing' | 'cancelling' — keep polling
    } catch (err) {
      getGlobalLogger().warn(
        'BatchAPIClient',
        `OpenAI batch poll exception (attempt ${attempt + 1})`,
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return {
    status: 'expired',
    error: `Batch ${batchId} did not complete within ${(config.maxPollAttempts * config.pollIntervalMs) / 1000}s`,
  };
}

/**
 * Parse OpenAI batch result JSONL and extract the first response.
 */
function parseOpenAIBatchResult(jsonlContent: string): BatchPollResult {
  const lines = jsonlContent.trim().split('\n');
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        response?: {
          body?: {
            choices?: Array<{
              message?: {
                content?: string;
                tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
              };
              finish_reason?: string;
            }>;
            usage?: {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
          };
          status?: number;
        };
        error?: { message: string };
      };

      if (entry.error) {
        return { status: 'failed', error: entry.error.message };
      }

      const choice = entry.response?.body?.choices?.[0];
      if (!choice) {
        return { status: 'failed', error: 'No choice in batch response' };
      }

      const usage: TokenUsage = {
        promptTokens: entry.response?.body?.usage?.prompt_tokens ?? 0,
        completionTokens: entry.response?.body?.usage?.completion_tokens ?? 0,
        totalTokens: entry.response?.body?.usage?.total_tokens ?? 0,
        cacheReadTokens: entry.response?.body?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      };

      const result: LLMResponse = {
        content: choice.message?.content ?? '',
        model: '',
        usage,
        finishReason:
          choice.finish_reason === 'stop'
            ? 'stop'
            : choice.finish_reason === 'tool_calls'
              ? 'tool_calls'
              : 'stop',
        toolCalls: choice.message?.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
      };

      return { status: 'completed', result };
    } catch {
      // skip malformed lines
    }
  }
  return { status: 'failed', error: 'No valid results in batch output' };
}

// ============================================================================
// Anthropic Batch API Client
// ============================================================================

/**
 * Submit a single request to Anthropic Message Batches API.
 */
async function submitAnthropicBatch(
  request: LLMRequest,
  config: BatchAPIConfig,
): Promise<BatchSubmissionResult> {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
  const model = request.model || 'claude-sonnet-4-6-20250514';
  const customId = `cmdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Build messages (Anthropic requires separate system field)
  const systemMsg = request.messages.find((m) => m.role === 'system');
  const messages = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? 4096,
    messages,
  };
  if (systemMsg) body.system = systemMsg.content;

  try {
    const response = await fetch(`${baseUrl}/messages/batches`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        requests: [
          {
            custom_id: customId,
            params: body,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        batchId: '',
        status: 'failed',
        provider: 'anthropic',
        error: `Batch creation failed: ${err}`,
      };
    }

    const data = (await response.json()) as { id: string };
    return { batchId: data.id, status: 'submitted', provider: 'anthropic' };
  } catch (err) {
    return {
      batchId: '',
      status: 'failed',
      provider: 'anthropic',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Poll Anthropic batch status until completion or timeout.
 */
async function pollAnthropicBatch(
  batchId: string,
  config: BatchAPIConfig,
): Promise<BatchPollResult> {
  const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';

  for (let attempt = 0; attempt < config.maxPollAttempts; attempt++) {
    await sleep(config.pollIntervalMs);

    try {
      const response = await fetch(`${baseUrl}/messages/batches/${batchId}`, {
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        const err = await response.text();
        getGlobalLogger().warn(
          'BatchAPIClient',
          `Anthropic batch poll error (attempt ${attempt + 1})`,
          { error: err },
        );
        continue;
      }

      const data = (await response.json()) as {
        processing_status: string;
        result_type?: string;
        results?: Record<string, unknown>;
      };

      if (data.processing_status === 'ended') {
        if (data.result_type === 'succeeded' || data.result_type === 'partially_succeeded') {
          // Retrieve results
          const resultsResponse = await fetch(`${baseUrl}/messages/batches/${batchId}/results`, {
            headers: {
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
          });

          if (resultsResponse.ok) {
            const resultsData = (await resultsResponse.json()) as Record<
              string,
              {
                result?: {
                  content?: Array<{ type: string; text?: string }>;
                  usage?: {
                    input_tokens: number;
                    output_tokens: number;
                    cache_read_input_tokens?: number;
                  };
                  stop_reason?: string;
                };
                error?: { type: string; message: string };
              }
            >;

            for (const key of Object.keys(resultsData)) {
              const entry = resultsData[key];
              if (entry.error) {
                return { status: 'failed', error: entry.error.message };
              }
              if (entry.result) {
                const textParts =
                  entry.result.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '') ??
                  [];
                const usage: TokenUsage = {
                  promptTokens: entry.result.usage?.input_tokens ?? 0,
                  completionTokens: entry.result.usage?.output_tokens ?? 0,
                  totalTokens:
                    (entry.result.usage?.input_tokens ?? 0) +
                    (entry.result.usage?.output_tokens ?? 0),
                  cacheReadTokens: entry.result.usage?.cache_read_input_tokens ?? 0,
                };
                const result: LLMResponse = {
                  content: textParts.join(''),
                  model: '',
                  usage,
                  finishReason: entry.result.stop_reason === 'end_turn' ? 'stop' : 'stop',
                };
                return { status: 'completed', result };
              }
            }
            return { status: 'completed', error: 'No result in batch response' };
          }
        }
        if (data.result_type === 'errored' || data.result_type === 'canceled') {
          return { status: 'failed', error: `Batch ${data.result_type}` };
        }
        // result_type === 'expired'
        return { status: 'expired', error: 'Batch expired' };
      }
      // processing_status: 'in_progress' | 'canceling' — keep polling
    } catch (err) {
      getGlobalLogger().warn(
        'BatchAPIClient',
        `Anthropic batch poll exception (attempt ${attempt + 1})`,
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return {
    status: 'expired',
    error: `Batch ${batchId} did not complete within ${(config.maxPollAttempts * config.pollIntervalMs) / 1000}s`,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Execute a request via batch API with fail-closed fallback.
 *
 * Flow:
 *   1. Submit request to batch API
 *   2. Poll for completion (up to maxPollAttempts × pollIntervalMs)
 *   3. If completed → return result (with 50% cost savings)
 *   4. If failed/expired/timeout → return null (caller falls back to standard API)
 *
 * @returns LLMResponse if batch completed successfully, null otherwise
 */
export async function executeViaBatchAPI(
  request: LLMRequest,
  provider: string,
  config: BatchAPIConfig,
): Promise<LLMResponse | null> {
  const isAnthropic = provider === 'anthropic';
  const submitFn = isAnthropic ? submitAnthropicBatch : submitOpenAIBatch;
  const pollFn = isAnthropic ? pollAnthropicBatch : pollOpenAIBatch;

  getGlobalLogger().info('BatchAPIClient', `Submitting ${provider} batch request`, {
    model: request.model,
    pollInterval: config.pollIntervalMs,
    maxAttempts: config.maxPollAttempts,
  });

  // Step 1: Submit
  const submission = await submitFn(request, config);
  if (submission.status === 'failed' || !submission.batchId) {
    getGlobalLogger().warn('BatchAPIClient', `${provider} batch submission failed, falling back`, {
      error: submission.error,
    });
    return null; // fail-closed: caller falls back to standard API
  }

  // Step 2: Poll
  const pollResult = await pollFn(submission.batchId, config);

  if (pollResult.status === 'completed' && pollResult.result) {
    getGlobalLogger().info('BatchAPIClient', `${provider} batch completed successfully`, {
      batchId: submission.batchId,
    });
    return pollResult.result;
  }

  // Step 3: Fail-closed — batch didn't complete
  getGlobalLogger().warn(
    'BatchAPIClient',
    `${provider} batch did not complete, falling back to standard API`,
    {
      batchId: submission.batchId,
      status: pollResult.status,
      error: pollResult.error,
    },
  );
  return null;
}

/**
 * Check if a provider supports native batch API.
 */
export function supportsNativeBatchAPI(provider: string): boolean {
  return provider === 'openai' || provider === 'anthropic';
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a multipart/form-data body for file upload.
 */
function createMultipartForm(jsonlContent: string): FormData {
  const formData = new FormData();
  const blob = new Blob([jsonlContent], { type: 'application/jsonl' });
  formData.append('file', blob, 'batch.jsonl');
  formData.append('purpose', 'batch');
  return formData;
}
