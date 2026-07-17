/**
 * WS2 §1 — route LLM provider calls through EffectBroker.
 *
 * The broker owns a single EffectExecutor; LLM invocations register a
 * one-shot callback keyed by effectId (also placed on the ledger request)
 * so the executor can run the real provider.call without serializing functions.
 *
 * Capability tokens are minted **at call time** (not once per step): request
 * binding hashes include a per-call effectId, so a pre-signed step token would
 * always fail REQUEST_HASH_MISMATCH under requireRequestBinding.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { EffectBroker } from '@commander/effect-broker';
import { canonicalRequestHash, type CapabilityTokenIssuer } from '@commander/effect-broker';
import type { LLMProvider, LLMRequest, LLMResponse } from '@commander/core';

export const LLM_INVOKE_REGISTRY = new Map<string, () => Promise<LLMResponse>>();

export interface LlmEffectAuth {
  tenantId: string;
  runId: string;
  stepId: string;
  actor: string;
  lease: {
    workerId: string;
    workerGeneration?: number;
    token: string;
    fencingEpoch: number;
  };
  /**
   * Mint a short-lived grant bound to the exact broker request body.
   * Must use the same canonicalRequestHash the broker will verify.
   */
  mintCapabilityToken: (input: {
    effectType: string;
    request: Record<string, unknown>;
  }) => string;
}

const llmAuthStorage = new AsyncLocalStorage<LlmEffectAuth>();

export function runWithLlmEffectAuth<T>(auth: LlmEffectAuth, fn: () => T): T {
  return llmAuthStorage.run(auth, fn);
}

export function getLlmEffectAuth(): LlmEffectAuth | undefined {
  return llmAuthStorage.getStore();
}

/** Build ALS auth that mints per-call tokens via the worker's CapabilityTokenIssuer. */
export function createLlmEffectAuth(input: {
  tenantId: string;
  runId: string;
  stepId: string;
  actor: string;
  lease: LlmEffectAuth['lease'];
  issuer: CapabilityTokenIssuer;
  /** Token TTL in ms (default 5 minutes). */
  ttlMs?: number;
}): LlmEffectAuth {
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  return {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    actor: input.actor,
    lease: input.lease,
    mintCapabilityToken: ({ effectType, request }) =>
      input.issuer.issue({
        jti: randomUUID(),
        tenantId: input.tenantId,
        runId: input.runId,
        stepId: input.stepId,
        effectTypes: [effectType],
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        requestHash: canonicalRequestHash(request),
      }),
  };
}

/**
 * Hash the call-shaping payload (messages/model/params) for request binding
 * without placing raw prompt text on the effect ledger.
 */
export function hashLlmCallContent(request: LLMRequest): string {
  return canonicalRequestHash({
    model: request.model ?? null,
    messages: request.messages ?? [],
    maxTokens: request.maxTokens ?? null,
    temperature: request.temperature ?? null,
    stop: request.stop ?? null,
    tools: request.tools ?? null,
    responseFormat: request.responseFormat ?? null,
    reasoningConfig: request.reasoningConfig ?? null,
    safePrompt: request.safePrompt ?? null,
  } as Record<string, unknown>);
}

/**
 * Wrap an LLM provider so every call is mediated by EffectBroker.execute.
 * Fail-closed when auth context is missing.
 */
export function wrapProviderWithEffectBroker(
  provider: LLMProvider,
  broker: EffectBroker,
): LLMProvider {
  return {
    name: provider.name,
    async call(request: LLMRequest): Promise<LLMResponse> {
      const auth = getLlmEffectAuth();
      if (!auth) {
        throw new Error(
          'EFFECT_AUTHORIZATION_REQUIRED: LLM calls through EffectBroker need step lease + capability mint',
        );
      }
      const effectId = randomUUID();
      const effectType = `llm.${provider.name}`;
      // Freeze call payload so ledger hash and provider invoke stay atomic.
      const frozenRequest: LLMRequest = structuredClone(request);
      const contentHash = hashLlmCallContent(frozenRequest);
      // Ledger keeps metadata + contentHash (not raw prompt) for DLP-friendly binding.
      const requestBody: Record<string, unknown> = {
        effectId,
        provider: provider.name,
        model: frozenRequest.model ?? null,
        messageCount: Array.isArray(frozenRequest.messages) ? frozenRequest.messages.length : 0,
        contentHash,
      };
      const capabilityToken = auth.mintCapabilityToken({
        effectType,
        request: requestBody,
      });
      LLM_INVOKE_REGISTRY.set(effectId, () => {
        const liveHash = hashLlmCallContent(frozenRequest);
        if (liveHash !== contentHash) {
          throw new Error(
            'EFFECT_REQUEST_TAMPERED: LLM invoke payload diverged from admitted contentHash',
          );
        }
        return provider.call(frozenRequest);
      });
      try {
        const result = await broker.execute({
          effectId,
          token: capabilityToken,
          type: effectType,
          request: requestBody,
          idempotencyKey: `llm:${auth.runId}:${auth.stepId}:${effectId}`,
          lease: auth.lease,
          actor: auth.actor,
        });
        return result.response as unknown as LLMResponse;
      } finally {
        LLM_INVOKE_REGISTRY.delete(effectId);
      }
    },
  };
}

/** Dispatch helper for the worker EffectExecutor — llm.* → registry invoke. */
export async function dispatchLlmEffect(input: {
  type: string;
  request: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (!input.type.startsWith('llm.')) {
    throw new Error(`Not an LLM effect type: ${input.type}`);
  }
  const effectId = input.request.effectId;
  if (typeof effectId !== 'string' || !effectId) {
    throw new Error('LLM effect missing effectId for invoke registry lookup');
  }
  const expectedHash = input.request.contentHash;
  const invoke = LLM_INVOKE_REGISTRY.get(effectId);
  if (!invoke) {
    throw new Error(`LLM invoke registry miss for effectId=${effectId}`);
  }
  if (typeof expectedHash !== 'string' || !expectedHash) {
    throw new Error('LLM effect missing contentHash for invoke integrity check');
  }
  const response = await invoke();
  return response as unknown as Record<string, unknown>;
}
