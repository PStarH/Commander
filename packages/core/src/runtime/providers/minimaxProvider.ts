import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest } from '../types';

/**
 * MiniMax Provider — MiniMax's OpenAI-compatible API.
 *
 * Endpoint: https://api.minimax.io/v1
 * Models: MiniMax-M3 (released 2026-06-01)
 *
 * MiniMax M3 features:
 * - OpenAI-compatible chat completions format (/v1/chat/completions)
 * - 1M token context window
 * - Supports tool calls and structured outputs
 * - Supports reasoning_effort parameter for reasoning models
 *
 * Env: MINIMAX_API_KEY (required)
 *       MINIMAX_BASE_URL (optional)
 *       MINIMAX_MODEL (optional)
 *
 * Note: The older MiniMax API (api.minimax.chat) uses a proprietary format
 * with prompt/role_meta/sender_type fields. This provider targets the newer
 * OpenAI-compatible endpoint at api.minimax.io.
 */
export class MiniMaxProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'minimax';

  protected getDefaultBaseUrl(): string {
    return process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
  }

  protected getDefaultModel(): string {
    return process.env.MINIMAX_MODEL || 'MiniMax-M3';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
}
