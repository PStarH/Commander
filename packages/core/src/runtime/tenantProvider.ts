/**
 * TenantProvider — Multi-tenant isolation for Commander.
 *
 * Defines the contract for tenant identification, configuration, and
 * resource quota enforcement. Two built-in implementations:
 *  - NullTenantProvider: single-tenant mode, no isolation (default)
 *  - SimpleTenantProvider: static config map for multi-tenant deployments
 */
import * as path from 'node:path';
import { ThreeLayerMemory, getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { getCurrentTenantId as readCurrentTenantId } from './tenantContext';

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
  /** Optional workspace root for file operations (chroot-like). */
  workspacePath?: string;
  /** Optional override for storage base directory. */
  storagePath?: string;
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
  private instances: Map<string, ThreeLayerMemory> = new Map();
  private defaultInstance: ThreeLayerMemory | null = null;
  private static readonly MAX_INSTANCES = 50;

  /** Get or create a memory instance for a tenant. */
  getOrCreate(tenantId?: string): ThreeLayerMemory {
    if (!tenantId) {
      if (!this.defaultInstance) {
        this.defaultInstance = getGlobalThreeLayerMemory();
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
      mem = new ThreeLayerMemory();
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
}

export function resetGlobalTenantProvider(): void {
  globalTenantProvider = new NullTenantProvider();
}

const memoryRegistrySingleton = createTenantAwareSingleton(() => new ThreeLayerMemoryRegistry());

export function getGlobalMemoryRegistry(): ThreeLayerMemoryRegistry {
  return memoryRegistrySingleton.get();
}

export function resetGlobalMemoryRegistry(): void {
  memoryRegistrySingleton.reset();
}
