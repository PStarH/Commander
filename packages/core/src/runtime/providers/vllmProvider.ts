import { reportSilentFailure } from '../../silentFailureReporter';
import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest, LLMResponse } from '../types';
import { getGlobalLogger } from '../../logging';

/**
 * vLLM Provider — local/self-hosted LLM inference via vLLM.
 *
 * Features:
 * - Auto-detects running vLLM instance via /health endpoint
 * - OpenAI-compatible API
 * - Supports tool calling
 * - Configurable via env vars
 *
 * Env: VLLM_BASE_URL (default: http://localhost:8000/v1)
 *       VLLM_MODEL (default: auto-detect or first model from /v1/models)
 *       VLLM_API_KEY (optional, for authenticated endpoints)
 *
 * Common models: meta-llama/Llama-3.2-3B-Instruct, mistralai/Mistral-7B-Instruct,
 *                Qwen/Qwen2.5-7B-Instruct, deepseek-coder
 */
export class VLLMProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'vllm';

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }) {
    super({
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel,
    });
  }

  protected getDefaultBaseUrl(): string {
    return process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
  }

  protected getDefaultModel(): string {
    return process.env.VLLM_MODEL || 'meta-llama/Llama-3.2-3B-Instruct';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {
      isLocal: true,
      apiKey: process.env.VLLM_API_KEY || '',
    };
  }

  /**
   * Check if vLLM server is running and healthy.
   */
  static async isRunning(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl || process.env.VLLM_BASE_URL || 'http://localhost:8000';
      const healthUrl = url.replace('/v1', '') + '/health';
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch (err) {
      reportSilentFailure(err, 'vllmProvider:60');
      return false;
    }
  }

  /**
   * List models available on the vLLM server (OpenAI-compatible /v1/models endpoint).
   */
  static async listModels(baseUrl?: string): Promise<string[]> {
    try {
      const url = baseUrl || process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
      const modelsUrl = url.replace(/\/v1$/, '') + '/v1/models';
      const response = await fetch(modelsUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data || []).map((m: { id: string }) => m.id);
    } catch (err) {
      reportSilentFailure(err, 'vllmProvider:80');
      return [];
    }
  }

  /**
   * Auto-detect vLLM: check if running and available models.
   */
  static async autoDetect(): Promise<{ baseUrl: string; defaultModel: string } | null> {
    const baseUrl = process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
    const running = await VLLMProvider.isRunning(baseUrl);
    if (!running) return null;

    const models = await VLLMProvider.listModels(baseUrl);
    let defaultModel = process.env.VLLM_MODEL || '';

    if (!defaultModel && models.length > 0) {
      // Prefer instruct/chat models
      const chatModels = models.filter(
        (m) => m.toLowerCase().includes('instruct') || m.toLowerCase().includes('chat'),
      );
      defaultModel = chatModels[0] || models[0];
    }

    if (!defaultModel) {
      defaultModel = 'meta-llama/Llama-3.2-3B-Instruct';
    }

    return { baseUrl, defaultModel };
  }

  private static healthCache: { healthy: boolean; timestamp: number } | null = null;
  private static readonly HEALTH_TTL_MS = 30_000;

  async call(request: LLMRequest): Promise<LLMResponse> {
    // Cache health check to avoid 1s overhead on every call
    const now = Date.now();
    if (
      !VLLMProvider.healthCache ||
      now - VLLMProvider.healthCache.timestamp > VLLMProvider.HEALTH_TTL_MS
    ) {
      const healthUrl = this.config.baseUrl.replace('/v1', '').replace(/\/+$/, '') + '/health';
      try {
        await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        });
        VLLMProvider.healthCache = { healthy: true, timestamp: now };
      } catch (err) {
        reportSilentFailure(err, 'vllmProvider:129');
        VLLMProvider.healthCache = { healthy: false, timestamp: now };
        getGlobalLogger().warn(
          'VLLMProvider',
          'vLLM does not appear to be running at ' + this.config.baseUrl,
        );
      }
    }
    return super.call(request);
  }
}
