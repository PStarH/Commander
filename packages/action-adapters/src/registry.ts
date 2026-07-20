import type { EffectOutcomeQuerier } from '@commander/effect-broker';
import type { ActionAdapterDescriptorV1 } from '@commander/contracts';
import type { ActionAdapter, AdapterCredentialProvider } from './types.js';
import { createGitHubPullRequestCreateAdapter } from './github/pullRequestCreate.js';
import { createServiceNowIncidentCreateAdapter } from './servicenow/incidentCreate.js';

export class ActionAdapterRegistry {
  private readonly adapters: Map<string, ActionAdapter>;

  constructor(adapters: readonly ActionAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.descriptor.effectType, adapter);
      this.adapters.set(adapter.descriptor.compensationEffectType, adapter);
    }
  }

  static production(credentials: AdapterCredentialProvider): ActionAdapterRegistry {
    return new ActionAdapterRegistry([
      createGitHubPullRequestCreateAdapter({ credentials }),
      createServiceNowIncidentCreateAdapter({ credentials }),
    ]);
  }

  static empty(): ActionAdapterRegistry {
    return new ActionAdapterRegistry([]);
  }

  resolve(effectType: string): ActionAdapter | null {
    return this.adapters.get(effectType) ?? null;
  }

  outcomeQuerierFor(effectType: string): EffectOutcomeQuerier | null {
    const adapter = this.resolve(effectType);
    if (!adapter) return null;
    return {
      queryOutcome: async (input) =>
        adapter.queryOutcome({
          tenantId: input.tenantId,
          effectId: input.effectId,
          idempotencyKey: input.idempotencyKey,
          destination: String(input.request.destination ?? ''),
          request: input.request,
          signal: input.signal,
        }),
    };
  }

  listDescriptors(): readonly ActionAdapterDescriptorV1[] {
    const seen = new Set<string>();
    const descriptors: ActionAdapterDescriptorV1[] = [];
    for (const adapter of this.adapters.values()) {
      if (seen.has(adapter.descriptor.adapterId)) continue;
      seen.add(adapter.descriptor.adapterId);
      descriptors.push(adapter.descriptor);
    }
    return descriptors;
  }
}
