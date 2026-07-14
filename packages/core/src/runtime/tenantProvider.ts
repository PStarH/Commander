/**
 * TenantProvider — Multi-tenant isolation for Commander.
 *
 * Defines the contract for tenant identification, configuration, and
 * resource quota enforcement. Two built-in implementations:
 *  - NullTenantProvider: single-tenant mode, no isolation (default)
 *  - SimpleTenantProvider: static config map for multi-tenant deployments
 */
import * as path from 'node:path';
// NOTE: ThreeLayerMemory is imported lazily to break a value-import cycle:
// threeLayerMemory → tenantProvider → tenantContext → tenantAwareSingleton →
// tenantContext → tenantProvider. Loading it at module load time creates a
// circular dependency. The lazy wrappers below resolve it on first use.
import { getCurrentTenantId as readCurrentTenantId, setMultiTenantEnabled } from './tenantContext';

let _ThreeLayerMemory: typeof import('../threeLayerMemory').ThreeLayerMemory | null = null;
let _getGlobalThreeLayerMemory:
  | typeof import('../threeLayerMemory').getGlobalThreeLayerMemory
  | null = null;
function lazyThreeLayerMemoryClass(): typeof import('../threeLayerMemory').ThreeLayerMemory {
  if (!_ThreeLayerMemory) {
    const mod = require('../threeLayerMemory');
    _ThreeLayerMemory = mod.ThreeLayerMemory;
    _getGlobalThreeLayerMemory = mod.getGlobalThreeLayerMemory;
  }
  return _ThreeLayerMemory!;
}
function lazyGetGlobalThreeLayerMemory(): ReturnType<
  typeof import('../threeLayerMemory').getGlobalThreeLayerMemory
> {
  lazyThreeLayerMemoryClass();
  return _getGlobalThreeLayerMemory!();
}

// ============================================================================
// Types
// ============================================================================

export interface TenantConfig {
  tenantId: string;
  /** Max tokens per run. 0 = inherit runtime default. */
  tokenBudget: number;
  /** Max concurrent runs for this tenant. 0 = inherit runtime default. */
  maxConcurrency: number;
  /** Max runs per minute (rate limit). 0 = unlimited. */
  maxRunsPerMinute: number;
  /** Enables quota enforcement for this tenant. */
  enabled: boolean;
  /** When true, the tenant token budget is enforced as a hard cap. */
  hardCap?: boolean;
  /** Isolation model: pool (shared), bridge (dedicated db/workspace), silo (dedicated infra). */
  isolation?: 'pool' | 'bridge' | 'silo';
  /** Optional workspace root for file operations (chroot-like). */
  workspacePath?: string;
  /** Optional override for storage base directory. */
  storagePath?: string;
  /** Max storage bytes across all tenant-scoped stores. 0 = unlimited. */
  maxStorageBytes?: number;
  /** Arbitrary metadata (labels, tags, billing code). */
  metadata?: Record<string, string>;
}

// ============================================================================
// TenantProvider Interface
// ============================================================================

export interface TenantProvider {
  /** Look up tenant config by tenant ID. Returns undefined if unknown. */
  getTenantConfig(tenantId: string): TenantConfig | undefined;
  /** List all known tenant IDs. */
  getKnownTenants(): string[];
  /** Current tenant ID from tenant context (single-tenant returns undefined). */
  getCurrentTenantId(): string | undefined;
  /**
   * Validate that a file path is within the tenant's allowed workspace.
   * Returns true if allowed, false if the path escapes the workspace.
   * NullTenantProvider always returns true (no isolation).
   */
  validateWorkspacePath(tenantId: string, filePath: string): boolean;
}

// ============================================================================
// NullTenantProvider — single-tenant mode, no isolation
// ============================================================================

export class NullTenantProvider implements TenantProvider {
  getTenantConfig(_tenantId: string): TenantConfig | undefined {
    return undefined;
  }
  getKnownTenants(): string[] {
    return [];
  }
  getCurrentTenantId(): string | undefined {
    return readCurrentTenantId();
  }
  validateWorkspacePath(_tenantId: string, _filePath: string): boolean {
    return true;
  }
}

// ============================================================================
// SimpleTenantProvider — static config map
// ============================================================================

export class SimpleTenantProvider implements TenantProvider {
  private tenants: Map<string, TenantConfig>;

  constructor(tenants: TenantConfig[] = []) {
    this.tenants = new Map(tenants.map((t) => [t.tenantId, t]));
  }

  getTenantConfig(tenantId: string): TenantConfig | undefined {
    return this.tenants.get(tenantId);
  }

  getKnownTenants(): string[] {
    return Array.from(this.tenants.keys());
  }

  getCurrentTenantId(): string | undefined {
    return readCurrentTenantId();
  }

  validateWorkspacePath(tenantId: string, filePath: string): boolean {
    const config = this.tenants.get(tenantId);
    if (!config?.workspacePath) return true;
    const resolved = path.resolve(filePath);
    const workspace = path.resolve(config.workspacePath);
    return resolved === workspace || resolved.startsWith(workspace + path.sep);
  }

  addTenant(config: TenantConfig): void {
    this.tenants.set(config.tenantId, config);
  }

  removeTenant(tenantId: string): void {
    this.tenants.delete(tenantId);
  }
}

// ============================================================================
// ThreeLayerMemory Registry — per-tenant memory isolation
// ============================================================================

export class ThreeLayerMemoryRegistry {
  private instances: Map<
    string,
    InstanceType<typeof import('../threeLayerMemory').ThreeLayerMemory>
  > = new Map();
  private defaultInstance: InstanceType<
    typeof import('../threeLayerMemory').ThreeLayerMemory
  > | null = null;
  private static readonly MAX_INSTANCES = 50;

  /** Get or create a memory instance for a tenant. */
  getOrCreate(
    tenantId?: string,
  ): InstanceType<typeof import('../threeLayerMemory').ThreeLayerMemory> {
    if (!tenantId) {
      if (!this.defaultInstance) {
        this.defaultInstance = lazyGetGlobalThreeLayerMemory();
      }
      return this.defaultInstance;
    }
    let mem = this.instances.get(tenantId);
    if (!mem) {
      if (this.instances.size >= ThreeLayerMemoryRegistry.MAX_INSTANCES) {
        // Evict the first (oldest) entry
        const firstKey = this.instances.keys().next().value;
        if (firstKey) this.instances.delete(firstKey);
      }
      mem = new (lazyThreeLayerMemoryClass())();
      this.instances.set(tenantId, mem);
    }
    return mem;
  }

  /** Remove a tenant's memory instance (free memory). */
  remove(tenantId: string): void {
    this.instances.delete(tenantId);
  }

  /** Get count of tenant-specific instances (excludes default). */
  getTenantCount(): number {
    return this.instances.size;
  }
}

// ============================================================================
// Global singleton
// ============================================================================

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let globalTenantProvider: TenantProvider = new NullTenantProvider();

export function getGlobalTenantProvider(): TenantProvider {
  return globalTenantProvider;
}

export function setGlobalTenantProvider(provider: TenantProvider): void {
  globalTenantProvider = provider;
  setMultiTenantEnabled(!(provider instanceof NullTenantProvider));
}

export function resetGlobalTenantProvider(): void {
  globalTenantProvider = new NullTenantProvider();
  setMultiTenantEnabled(false);
}

const memoryRegistrySingleton = createTenantAwareSingleton(
  () => new ThreeLayerMemoryRegistry(),
  {},
);

export function getGlobalMemoryRegistry(): ThreeLayerMemoryRegistry {
  return memoryRegistrySingleton.get();
}

export function resetGlobalMemoryRegistry(): void {
  memoryRegistrySingleton.reset();
}
