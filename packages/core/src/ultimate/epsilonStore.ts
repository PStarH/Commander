/**
 * P6: Per-tenant ε-greedy rate override store.
 *
 * Backs the live operator endpoint at
 * `PUT /api/v1/topology/exploration/epsilon`. Operators can pin a
 * specific ε-greedy rate for a tenant (e.g. lower ε for stable
 * production traffic, higher ε for a tenant that's still warming up
 * its posterior). The store is a simple in-memory map — no
 * persistence, no replication. If Commander restarts, overrides
 * reset to the router's default ε.
 *
 * The store is shared between:
 *  - the HTTP handler (so PUT/GET/DELETE can read/write)
 *  - the TopologyRouter (so route() picks up the override per call)
 *
 * ε is always clamped to [0, 1] and NaN falls back to the router's
 * default (0.05) so a malformed PUT cannot disable exploration.
 */
const MIN_EPSILON = 0;
const MAX_EPSILON = 1;
const FALLBACK_EPSILON = 0.05;

export interface EpsilonOverride {
  tenantId: string;
  epsilon: number;
  /** ISO-8601 timestamp the override was set. */
  setAt: string;
}

function clampEpsilon(value: number): number {
  if (Number.isNaN(value)) return FALLBACK_EPSILON;
  if (value === Number.POSITIVE_INFINITY) return MAX_EPSILON;
  if (value === Number.NEGATIVE_INFINITY) return MIN_EPSILON;
  if (!Number.isFinite(value)) return FALLBACK_EPSILON;
  return Math.max(MIN_EPSILON, Math.min(MAX_EPSILON, value));
}

export class EpsilonStore {
  private readonly overrides: Map<string, EpsilonOverride> = new Map();

  /**
   * Set the per-tenant ε override. Clamps to [0, 1]; NaN → fallback.
   * Overwrites any existing override for the tenant.
   */
  set(tenantId: string, epsilon: number): EpsilonOverride {
    const clamped = clampEpsilon(epsilon);
    const entry: EpsilonOverride = {
      tenantId,
      epsilon: clamped,
      setAt: new Date().toISOString(),
    };
    this.overrides.set(tenantId, entry);
    return entry;
  }

  /**
   * Get the per-tenant ε override. Returns undefined when no
   * override is set — the router then falls back to its constructor
   * default.
   */
  get(tenantId: string): EpsilonOverride | undefined {
    return this.overrides.get(tenantId);
  }

  /**
   * Resolve the effective ε for a tenant: override → fallback.
   * Pure read; never throws and never mutates.
   */
  resolve(tenantId: string, fallback: number = FALLBACK_EPSILON): number {
    const entry = this.overrides.get(tenantId);
    if (entry === undefined) return fallback;
    return entry.epsilon;
  }

  /**
   * List all overrides, sorted by tenantId ascending for stable
   * dashboard rendering. Returns a defensive copy so callers can't
   * mutate the store.
   */
  list(): EpsilonOverride[] {
    return Array.from(this.overrides.values())
      .map((e) => ({ ...e }))
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /**
   * Clear one tenant's override. Returns true if an entry was
   * removed, false if there was nothing to clear.
   */
  clear(tenantId: string): boolean {
    return this.overrides.delete(tenantId);
  }

  /** Clear all overrides. */
  clearAll(): number {
    const n = this.overrides.size;
    this.overrides.clear();
    return n;
  }

  /** Number of tenants with an active override. */
  size(): number {
    return this.overrides.size;
  }
}
