import { BaseOpenAICompatibleProvider } from './baseOpenAICompatible';
import type { LLMRequest } from '../types';

/**
 * StepFun Provider — StepFun's OpenAI-compatible API (Step Plan channel).
 * Endpoint: https://api.stepfun.com/step_plan/v1
 * Models: step-3.7-flash, step-3.5-flash, step-3.5-flash-2603, step-router-v1
 *
 * StepFun-specific behavior:
 * - Supports `reasoning_effort` (low / medium / high) for reasoning models.
 * - Uses standard OpenAI chat completions format.
 */
export class StepFunProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'stepfun';

  protected getDefaultBaseUrl(): string {
    return 'https://api.stepfun.com/step_plan/v1';
  }

  protected getDefaultModel(): string {
    return 'step-3.7-flash';
  }

  protected getExtraBody(request: LLMRequest): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (request.temperature === undefined) {
      extra.temperature = 0.7;
    }
    const model = (request.model || this.config.defaultModel).toLowerCase();
    if (model.startsWith('step-3')) {
      // Respect caller-provided reasoningConfig; fall back to medium effort
      const rc = request.reasoningConfig;
      if (rc?.enabled) {
        if (rc.effort) {
          extra.reasoning_effort = rc.effort;
        }
        if (rc.budget && rc.budget > 0) {
          extra.max_thinking_tokens = rc.budget;
        }
      } else if (!rc || rc.enabled === undefined) {
        // Default: medium reasoning effort for step-3 models
        extra.reasoning_effort = 'medium';
      }
    }
    return extra;
  }
}
