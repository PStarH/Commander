/**
 * Tenant Manager — Multi-tenant isolation for AgentRuntime
 *
 * Handles:
 * - Per-tenant rate limiting
 * - Per-tenant concurrency limits
 * - Per-tenant storage quota enforcement
 * - Per-tenant store isolation (samples, traces, checkpoints)
 * - Per-tenant memory isolation
 * - Tenant context resolution and restoration
 *
 * Extracted from agentRuntime.ts for better separation of concerns.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TenantConfig } from './tenantProvider';
import { SamplesStore } from './samplesStore';
import { PersistentTraceStore } from './traceStore';
import { StateCheckpointer } from './stateCheckpointer';
import { TokenGovernor } from './tokenGovernor';
import { getGlobalMemoryRegistry } from './tenantProvider';
import type { ThreeLayerMemory } from '../threeLayerMemory';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface TenantOverrides {
  origSamplesStore: SamplesStore;
  origTraceStore: PersistentTraceStore;
  origCheckpointer: StateCheckpointer;
  origMemory: ThreeLayerMemory | null;
  origGovernor: TokenGovernor;
}

export interface TenantResolutionResult {
  allowed: boolean;
  error?: string;
  overrides?: TenantOverrides;
}

// ============================================================================
// Tenant Manager
// ============================================================================

export class TenantManager {
  private tenantRateLimits: Map<string, { count: number; resetAt: number }> = new Map();
  private tenantRunningCounts: Map<string, number> = new Map();
  private tenantSamplesStores: Map<string, SamplesStore> = new Map();
  private tenantTraceStores: Map<string, PersistentTraceStore> = new Map();
  private tenantCheckpointers: Map<string, StateCheckpointer> = new Map();
  private tenantStorageBytes: Map<string, { used: number; lastChecked: number }> = new Map();

  private static readonly MAX_TENANT_STORES = 50;
  private static readonly STORAGE_CHECK_INTERVAL_MS = 60_000;

  /**
   * Resolve tenant context — enforce rate limits, concurrency limits,
   * and provision tenant-scoped stores.
   */
  resolveTenantContext(
    tenantId: string | undefined,
    tenantCfg: TenantConfig | undefined,
    currentStores: {
      samplesStore: SamplesStore;
      traceStore: PersistentTraceStore;
      checkpointer: StateCheckpointer;
      memory: ThreeLayerMemory | null;
      governor: TokenGovernor;
    },
  ): TenantResolutionResult {
    if (!tenantId || !tenantCfg?.enabled) {
      return { allowed: true };
    }

    // Enforce per-tenant rate limit
    if (tenantCfg.maxRunsPerMinute > 0) {
      this.cleanupExpiredRateLimits();
      const rateEntry = this.tenantRateLimits.get(tenantId);
      const now = Date.now();
      if (rateEntry && now < rateEntry.resetAt && rateEntry.count >= tenantCfg.maxRunsPerMinute) {
        return { allowed: false, error: 'TENANT_RATE_LIMIT: too many runs per minute' };
      }
      if (!rateEntry || now > rateEntry.resetAt) {
        this.tenantRateLimits.set(tenantId, { count: 1, resetAt: now + 60_000 });
      } else {
        rateEntry.count++;
      }
    }

    // Enforce per-tenant concurrency limit
    if (tenantCfg.maxConcurrency > 0) {
      const current = this.tenantRunningCounts.get(tenantId) ?? 0;
      if (current >= tenantCfg.maxConcurrency) {
        return { allowed: false, error: 'TENANT_CONCURRENCY_LIMIT: too many concurrent runs' };
      }
      this.tenantRunningCounts.set(tenantId, current + 1);
    }

    // Enforce per-tenant storage quota
    if (tenantCfg.maxStorageBytes && tenantCfg.maxStorageBytes > 0) {
      const storageEntry = this.tenantStorageBytes.get(tenantId);
      const now = Date.now();
      if (
        !storageEntry ||
        now - storageEntry.lastChecked > TenantManager.STORAGE_CHECK_INTERVAL_MS
      ) {
        const used = this.computeTenantStorageBytes(tenantId, tenantCfg);
        this.tenantStorageBytes.set(tenantId, { used, lastChecked: now });
        if (used >= tenantCfg.maxStorageBytes) {
          getGlobalLogger().warn('TenantManager', 'Tenant storage quota exceeded', {
            tenantId,
            usedBytes: used,
            maxBytes: tenantCfg.maxStorageBytes,
          });
          return { allowed: false, error: 'TENANT_STORAGE_QUOTA: storage quota exceeded' };
        }
      } else if (storageEntry.used >= tenantCfg.maxStorageBytes) {
        return { allowed: false, error: 'TENANT_STORAGE_QUOTA: storage quota exceeded' };
      }
    }

    // Save original values for restore
    const overrides: TenantOverrides = {
      origSamplesStore: currentStores.samplesStore,
      origTraceStore: currentStores.traceStore,
      origCheckpointer: currentStores.checkpointer,
      origMemory: currentStores.memory,
      origGovernor: currentStores.governor,
    };

    // Evict oldest tenant stores if too many accumulate
    this.evictOldTenantStores(tenantId);

    // Provision tenant-scoped stores
    if (!this.tenantSamplesStores.has(tenantId)) {
      this.tenantSamplesStores.set(tenantId, new SamplesStore(undefined, tenantId));
    }
    if (!this.tenantTraceStores.has(tenantId)) {
      this.tenantTraceStores.set(tenantId, new PersistentTraceStore(undefined, tenantId));
    }
    if (!this.tenantCheckpointers.has(tenantId)) {
      this.tenantCheckpointers.set(tenantId, new StateCheckpointer(undefined, tenantId));
    }

    return { allowed: true, overrides };
  }

  /**
   * Get tenant-scoped stores for a given tenant ID.
   */
  getTenantStores(tenantId: string): {
    samplesStore: SamplesStore;
    traceStore: PersistentTraceStore;
    checkpointer: StateCheckpointer;
    memory: ThreeLayerMemory | null;
  } {
    return {
      samplesStore: this.tenantSamplesStores.get(tenantId) ?? new SamplesStore(),
      traceStore: this.tenantTraceStores.get(tenantId) ?? new PersistentTraceStore(),
      checkpointer: this.tenantCheckpointers.get(tenantId) ?? new StateCheckpointer(),
      memory: getGlobalMemoryRegistry().getOrCreate(tenantId),
    };
  }

  /**
   * Release tenant concurrency slot.
   */
  releaseTenantConcurrency(tenantId: string | undefined): void {
    if (tenantId) {
      const current = this.tenantRunningCounts.get(tenantId) ?? 0;
      if (current > 0) {
        this.tenantRunningCounts.set(tenantId, current - 1);
      }
    }
  }

  /**
   * Restore original stores after tenant-scoped execution.
   */
  restoreTenantOverrides(
    overrides: TenantOverrides | undefined,
    target: {
      samplesStore: SamplesStore;
      traceStore: PersistentTraceStore;
      checkpointer: StateCheckpointer;
      memory: ThreeLayerMemory | null;
      governor: TokenGovernor;
    },
  ): void {
    if (!overrides) return;
    target.samplesStore = overrides.origSamplesStore;
    target.traceStore = overrides.origTraceStore;
    target.checkpointer = overrides.origCheckpointer;
    target.memory = overrides.origMemory;
    target.governor = overrides.origGovernor;
  }

  /**
   * Flush all tenant-scoped stores during dispose.
   */
  flushAll(): void {
    for (const store of this.tenantSamplesStores.values()) {
      try {
        store.flush();
      } catch (e) {
        getGlobalLogger().warn('TenantManager', 'Failed to flush tenant samples store', {
          error: (e as Error)?.message,
        });
      }
    }
    for (const store of this.tenantTraceStores.values()) {
      try {
        store.shutdown();
      } catch (e) {
        getGlobalLogger().warn('TenantManager', 'Failed to flush tenant trace store', {
          error: (e as Error)?.message,
        });
      }
    }
    for (const cp of this.tenantCheckpointers.values()) {
      try {
        cp.dispose();
      } catch (e) {
        getGlobalLogger().warn('TenantManager', 'Failed to dispose tenant checkpointer', {
          error: (e as Error)?.message,
        });
      }
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private cleanupExpiredRateLimits(): void {
    if (this.tenantRateLimits.size > 100) {
      const now = Date.now();
      for (const [tid, entry] of this.tenantRateLimits) {
        if (now > entry.resetAt) this.tenantRateLimits.delete(tid);
      }
    }
  }

  private computeTenantStorageBytes(tenantId: string, cfg: TenantConfig): number {
    let total = 0;
    const dirs = new Set<string>();
    const storePaths = [
      cfg.storagePath,
      process.env.COMMANDER_SAMPLES_DIR
        ? path.join(process.env.COMMANDER_SAMPLES_DIR, `tenant_${tenantId}`)
        : undefined,
      process.env.COMMANDER_TRACES_DIR
        ? path.join(process.env.COMMANDER_TRACES_DIR, `tenant_${tenantId}`)
        : undefined,
      process.env.COMMANDER_CHECKPOINT_DIR
        ? path.join(process.env.COMMANDER_CHECKPOINT_DIR, `tenant_${tenantId}`)
        : undefined,
      path.join(process.cwd(), '.commander', 'queues', `tenant_${tenantId}`),
    ];
    for (const dir of storePaths) {
      if (dir && !dirs.has(dir)) {
        dirs.add(dir);
        total += this.dirSizeBytes(dir);
      }
    }
    return total;
  }

  private dirSizeBytes(dirPath: string): number {
    try {
      if (!fs.existsSync(dirPath)) return 0;
      let total = 0;
      const walk = (p: string): void => {
        let entries: string[];
        try {
          entries = fs.readdirSync(p);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(p, entry);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            walk(full);
          } else if (stat.isFile()) {
            total += stat.size;
          }
        }
      };
      walk(dirPath);
      return total;
    } catch {
      return 0;
    }
  }

  private evictOldTenantStores(tenantId: string): void {
    if (
      this.tenantSamplesStores.size >= TenantManager.MAX_TENANT_STORES &&
      !this.tenantSamplesStores.has(tenantId)
    ) {
      const oldestKey = this.tenantSamplesStores.keys().next().value;
      if (oldestKey) {
        this.tenantSamplesStores.delete(oldestKey);
        this.tenantTraceStores.delete(oldestKey);
        this.tenantCheckpointers.delete(oldestKey);
      }
    }
  }
}
