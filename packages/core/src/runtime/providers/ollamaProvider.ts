import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMResponse, LLMRequest } from '../types';
import { getGlobalLogger } from '../../logging';

interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
}

interface OllamaTagResponse {
  models: OllamaModel[];
}

/**
 * Ollama Provider — local LLM inference via Ollama.
 *
 * Features:
 * - Auto-detects running Ollama instance (no API key needed)
 * - Lists available models via /api/tags
 * - OpenAI-compatible API at /v1/chat/completions
 * - Supports tool calling (Ollama 0.3.0+)
 * - Falls back gracefully if Ollama is not running
 *
 * Env: OLLAMA_HOST (primary, official Ollama env var, e.g. 127.0.0.1:11434)
 *       OLLAMA_BASE_URL (fallback, full URL, e.g. http://localhost:11434/v1)
 *       OLLAMA_MODEL (optional, default: llama3.2)
 *
 * Models: llama3.2, gpt-oss, mistral, codellama, qwen2.5, deepseek-coder, etc.
 */

/**
 * Resolve Ollama's base URL from environment.
 * - OLLAMA_HOST is the official Ollama env var (e.g. "127.0.0.1:11434")
 * - OLLAMA_BASE_URL is a common third-party convention (e.g. "http://localhost:11434/v1")
 */
export function resolveOllamaBaseUrl(): string {
  const host = process.env.OLLAMA_HOST;
  if (host) {
    const prefix = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
    const base = `${prefix}${host}`;
    return base.replace(/\/+$/, '') + '/v1';
  }
  return process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
}

/** Resolve the raw server URL (without /v1 path) for health checks and native API calls. */
function resolveOllamaServerUrl(): string {
  const host = process.env.OLLAMA_HOST;
  if (host) {
    const prefix = host.startsWith('http://') || host.startsWith('https://') ? '' : 'http://';
    return `${prefix}${host}`.replace(/\/+$/, '');
  }
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}
export class OllamaProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'ollama';

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel?: string }) {
    super({
      apiKey: config.apiKey ?? 'ollama',
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel,
    });
  }

  protected getDefaultBaseUrl(): string {
    return resolveOllamaBaseUrl();
  }

  protected getDefaultModel(): string {
    return process.env.OLLAMA_MODEL || 'llama3.2';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {
      isLocal: true,
    };
  }

  /**
   * Check if Ollama is running and accessible.
   * Tries the /api/tags endpoint (Ollama-native, no auth needed).
   */
  static async isRunning(baseUrl?: string): Promise<boolean> {
    try {
      const url = baseUrl || resolveOllamaServerUrl();
      const response = await fetch(`${url}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List models available in the local Ollama instance.
   */
  static async listModels(baseUrl?: string): Promise<string[]> {
    try {
      const url = baseUrl || resolveOllamaServerUrl();
      const response = await fetch(`${url}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data: OllamaTagResponse = await response.json();
      return (data.models || []).map((m: OllamaModel) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Auto-detect Ollama: check if running, and if so, pick a sensible default model.
   * Returns the provider config or null if not available.
   */
  static async autoDetect(): Promise<{ baseUrl: string; defaultModel: string } | null> {
    const baseUrl = resolveOllamaBaseUrl();
    const serverUrl = resolveOllamaServerUrl();
    const running = await OllamaProvider.isRunning(serverUrl);
    if (!running) return null;

    const models = await OllamaProvider.listModels(serverUrl);
    const preferred = [
      'llama3.2',
      'gpt-oss',
      'llama3.1',
      'llama3',
      'mistral',
      'qwen2.5',
      'qwen2',
      'codellama',
      'deepseek-coder',
    ];
    let defaultModel = process.env.OLLAMA_MODEL || 'llama3.2';

    if (models.length > 0) {
      // Pick first preferred model that's available
      for (const p of preferred) {
        const match = models.find((m) => m.startsWith(p));
        if (match) {
          defaultModel = match;
          break;
        }
      }
      if (!defaultModel || defaultModel === 'llama3.2') {
        defaultModel = models[0];
      }
    }

    return { baseUrl, defaultModel };
  }

  private static healthCache: { healthy: boolean; timestamp: number } | null = null;
  private static readonly HEALTH_TTL_MS = 30_000;

  async call(request: LLMRequest): Promise<LLMResponse> {
    // Cache health check to avoid 1s overhead on every call
    const now = Date.now();
    if (
      !OllamaProvider.healthCache ||
      now - OllamaProvider.healthCache.timestamp > OllamaProvider.HEALTH_TTL_MS
    ) {
      try {
        await fetch(`${resolveOllamaServerUrl()}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        });
        OllamaProvider.healthCache = { healthy: true, timestamp: now };
      } catch {
        OllamaProvider.healthCache = { healthy: false, timestamp: now };
        getGlobalLogger().warn(
          'OllamaProvider',
          'Ollama does not appear to be running. Start it with: ollama serve',
        );
      }
    }
    return super.call(request);
  }
}
