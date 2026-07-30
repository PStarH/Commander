import type { EffectExecutor } from '@commander/effect-broker';
import {
  ActionAdapterRegistry,
  EnvAdapterCredentialProvider,
  type AdapterCredentialProvider,
  type KubernetesCredentialProvider,
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
  credentials?: AdapterCredentialProvider & KubernetesCredentialProvider,
  env: NodeJS.ProcessEnv = process.env,
): ActionAdapterRegistry {
  const cellTenantId = env.COMMANDER_CELL_TENANT_ID;
  if (!cellTenantId) {
    return ActionAdapterRegistry.empty();
  }
  const cluster = env.COMMANDER_KUBERNETES_CLUSTER;
  const server = env.COMMANDER_KUBERNETES_SERVER;
  const tokenEnv = env.COMMANDER_KUBERNETES_TOKEN_ENV;
  if ((cluster || server || tokenEnv) && !(cluster && server && tokenEnv)) {
    throw new Error(
      'COMMANDER_KUBERNETES_CLUSTER, COMMANDER_KUBERNETES_SERVER, and COMMANDER_KUBERNETES_TOKEN_ENV must be configured together',
    );
  }
  const provider =
    credentials ??
    new EnvAdapterCredentialProvider({
      cellTenantId,
      kubernetesClusters:
        cluster && server && tokenEnv ? { [cluster]: { server, tokenEnv } } : undefined,
    });
  return ActionAdapterRegistry.production(provider);
}
