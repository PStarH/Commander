/**
 * Tenant context resolver — extracted from `AgentRuntime.resolveTenantContext`
 * and `AgentRuntime.restoreTenantOverrides`.
 *
 * Bridges the runtime's store set with `TenantManager.resolveTenantContext` so
 * each agent run can switch `samplesStore`, `traceStore`, `checkpointer`,
 * `memory`, and `governor` to a tenant-scoped implementation when multi-tenancy
 * is enabled. The original overrides object is returned so that the finally
 * cleanup handler can restore the previous stores.
 */
import type { TenantConfig } from '../tenantProvider';
import type { TenantManager, TenantResolutionResult } from '../tenantManager';
import type { TenantOverrides } from '../finallyCleanupHandler';

export interface TenantContextResolverDeps {
  getTenantManager(): TenantManager;
  /** Snapshot the runtime's current tenant-scoped stores as overrides. */
  getTenantStores(): TenantOverrides;
  /** Replace the runtime's tenant-scoped stores from overrides. */
  setTenantStores(stores: TenantOverrides): void;
}

export class TenantContextResolver {
  constructor(private readonly deps: TenantContextResolverDeps) {}

  resolveTenantContext(
    tenantId: string | undefined,
    tenantCfg: TenantConfig | undefined,
    _runId: string,
    _agentId: string,
    _missionId?: string,
  ): TenantResolutionResult {
    // Snapshot the "original" stores before any tenant swap so the finally
    // cleanup handler can restore them when tenant context is not enabled.
    const overrides = this.deps.getTenantStores();

    if (!tenantCfg?.enabled || !tenantId) {
      return { allowed: true, overrides };
    }

    const result = this.deps.getTenantManager().resolveTenantContext(tenantId, tenantCfg, {
      samplesStore: overrides.origSamplesStore,
      traceStore: overrides.origTraceStore,
      checkpointer: overrides.origCheckpointer,
      memory: overrides.origMemory,
      governor: overrides.origGovernor,
    });

    if (result.allowed && tenantId && tenantCfg?.enabled) {
      const tenantStores = this.deps.getTenantManager().getTenantStores(tenantId);
      if (tenantStores) {
        this.deps.setTenantStores({
          origSamplesStore: tenantStores.samplesStore,
          origTraceStore: tenantStores.traceStore,
          origCheckpointer: tenantStores.checkpointer,
          origMemory: tenantStores.memory,
          // TenantManager does not provision a tenant-scoped governor; preserve
          // the original governor so cost governance keeps using the runtime's
          // configured instance.
          origGovernor: overrides.origGovernor,
        });
      }
    }

    return result;
  }

  restoreTenantOverrides(
    overrides: TenantOverrides | undefined,
    _tenantId: string | undefined,
  ): void {
    if (!overrides) return;
    this.deps.setTenantStores(overrides);
  }
}
