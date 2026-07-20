import type { EffectExecutor } from '@commander/effect-broker';
import {
  ActionAdapterRegistry,
  EnvAdapterCredentialProvider,
  type AdapterCredentialProvider,
} from '@commander/action-adapters';

export function createActionAdapterEffectExecutor(
  registry: ActionAdapterRegistry,
): EffectExecutor {
  return {
    execute: async (input) => {
      const adapter = registry.resolve(input.type);
      if (!adapter) {
        throw new Error(`UNREGISTERED_EFFECT_TYPE: ${input.type}`);
      }
      const ctx = input.executionContext;
      if (
        !ctx?.tenantId ||
        !ctx.effectId ||
        typeof input.request.idempotencyKey !== 'string'
      ) {
        throw new Error('EFFECT_AUTHORIZATION_REQUIRED');
      }
      const destination = String(input.request.destination ?? '');
      if (input.type.startsWith('compensate.')) {
        return adapter.compensate({
          tenantId: ctx.tenantId,
          effectId: ctx.effectId,
          originalEffectId: String(
            (input.request as Record<string, unknown>).originalEffectId ?? '',
          ),
          idempotencyKey: input.request.idempotencyKey,
          destination,
          forwardResponse:
            ((input.request as Record<string, unknown>).forwardResponse as Record<string, unknown>) ??
            {},
          compensationPatch:
            ((input.request as Record<string, unknown>).compensationPatch as Record<string, unknown>) ??
            {},
          signal: input.signal,
        });
      }
      return adapter.execute({
        tenantId: ctx.tenantId,
        effectId: ctx.effectId,
        idempotencyKey: input.request.idempotencyKey,
        destination,
        args: (input.request.args as Record<string, unknown>) ?? {},
        signal: input.signal,
      });
    },
  };
}

export function createProductionAdapterRegistry(
  credentials?: AdapterCredentialProvider,
): ActionAdapterRegistry {
  const cellTenantId = process.env.COMMANDER_CELL_TENANT_ID;
  if (!cellTenantId) {
    return ActionAdapterRegistry.empty();
  }
  const provider =
    credentials ??
    new EnvAdapterCredentialProvider({
      cellTenantId,
    });
  return ActionAdapterRegistry.production(provider);
}
