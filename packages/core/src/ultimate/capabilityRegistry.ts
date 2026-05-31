import type { CapabilityVector, AgentCapability } from './types';

/** Maximum number of agents in the registry before stale eviction triggers */
const MAX_REGISTRY_SIZE = 200;

/** Weights for capability matching scoring */
const MATCH_WEIGHTS = {
  COVERAGE: 0.4,
  STRENGTH: 0.3,
  RELIABILITY: 0.3,
} as const;

/** Penalty for exceeding cost constraints */
const COST_PENALTY = 0.3;

/** Minimum fuzzy match score to consider a capability match (0-1) */
const FUZZY_MATCH_THRESHOLD = 0.6;

export class CapabilityRegistry {
  private registry = new Map<string, CapabilityVector>();

  register(agentId: string, vector: Omit<CapabilityVector, 'agentId' | 'version' | 'lastUpdated'>): CapabilityVector {
    if (this.registry.size > MAX_REGISTRY_SIZE) this.evictStale();
    const version = `1.0.0`;
    const entry: CapabilityVector = {
      agentId,
      version,
      ...vector,
      lastUpdated: new Date().toISOString(),
    };
    this.registry.set(agentId, entry);
    return entry;
  }

  update(agentId: string, updates: Partial<CapabilityVector>): CapabilityVector | null {
    const existing = this.registry.get(agentId);
    if (!existing) return null;

    const [major, minor, patch] = existing.version.split('.').map(Number);
    const updated: CapabilityVector = {
      ...existing,
      ...updates,
      agentId,
      version: `${major}.${minor}.${patch + 1}`,
      lastUpdated: new Date().toISOString(),
    };
    this.registry.set(agentId, updated);
    return updated;
  }

  get(agentId: string): CapabilityVector | null {
    return this.registry.get(agentId) ?? null;
  }

  findBestMatch(
    requiredCapabilities: string[],
    constraints?: {
      maxCostPerToken?: number;
      minSuccessRate?: number;
    },
  ): Array<{ agentId: string; matchScore: number; vector: CapabilityVector }> {
    const scored: Array<{ agentId: string; matchScore: number; vector: CapabilityVector }> = [];

    for (const [agentId, vector] of this.registry) {
      if (constraints?.minSuccessRate && vector.reliability.successRate < constraints.minSuccessRate) {
        continue;
      }

      const matchScore = this.calculateMatchScore(vector, requiredCapabilities, constraints);

      if (matchScore > 0) {
        scored.push({ agentId, matchScore, vector });
      }
    }

    return scored.sort((a, b) => b.matchScore - a.matchScore);
  }

  private calculateMatchScore(
    vector: CapabilityVector,
    required: string[],
    constraints?: { maxCostPerToken?: number },
  ): number {
    if (required.length === 0) return 0.5;

    let totalStrength = 0;
    let matchedCount = 0;

    const lowerCaps = vector.capabilities.map(c => ({ name: c.name.toLowerCase(), strength: c.strength, domain: c.domain.toLowerCase() }));
    for (const req of required) {
      const reqLower = req.toLowerCase();
      let bestMatch: { strength: number; score: number } | null = null;

      for (const cap of lowerCaps) {
        // Exact match
        if (cap.name === reqLower) {
          bestMatch = { strength: cap.strength, score: 1.0 };
          break;
        }

        // Substring match
        if (cap.name.includes(reqLower) || reqLower.includes(cap.name)) {
          const score = Math.min(cap.name.length, reqLower.length) / Math.max(cap.name.length, reqLower.length);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { strength: cap.strength, score };
          }
          continue;
        }

        // Domain-aware match: check if the capability domain relates to the requirement
        if (cap.domain && (reqLower.includes(cap.domain) || cap.domain.includes(reqLower))) {
          const score = 0.7; // Domain match is weaker than name match
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { strength: cap.strength, score };
          }
          continue;
        }

        // Fuzzy match using Levenshtein distance
        const fuzzyScore = this.fuzzyMatchScore(cap.name, reqLower);
        if (fuzzyScore >= FUZZY_MATCH_THRESHOLD) {
          if (!bestMatch || fuzzyScore > bestMatch.score) {
            bestMatch = { strength: cap.strength, score: fuzzyScore };
          }
        }
      }

      if (bestMatch) {
        totalStrength += bestMatch.strength * bestMatch.score;
        matchedCount++;
      }
    }

    if (matchedCount === 0) return 0;

    const coverageScore = matchedCount / required.length;
    const strengthScore = matchedCount > 0 ? totalStrength / matchedCount : 0;
    const reliabilityScore = vector.reliability.successRate;

    let costPenalty = 0;
    if (constraints?.maxCostPerToken) {
      const avgCost = (vector.cost.perInputToken + vector.cost.perOutputToken) / 2;
      if (avgCost > constraints.maxCostPerToken) {
        costPenalty = COST_PENALTY;
      }
    }

    return (coverageScore * MATCH_WEIGHTS.COVERAGE + strengthScore * MATCH_WEIGHTS.STRENGTH + reliabilityScore * MATCH_WEIGHTS.RELIABILITY) - costPenalty;
  }

  /**
   * Compute fuzzy match score between two strings using Levenshtein distance.
   * Returns a score between 0 (no match) and 1 (exact match).
   */
  private fuzzyMatchScore(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;

    const distance = this.levenshteinDistance(a, b);
    return 1 - distance / maxLen;
  }

  /**
   * Compute Levenshtein distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;

    // Use single-row DP for memory efficiency
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // deletion
          curr[j - 1] + 1,  // insertion
          prev[j - 1] + cost, // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  getStats(): {
    totalAgents: number;
    totalCapabilities: number;
    topCapabilities: Array<{ name: string; count: number }>;
  } {
    const capCounts = new Map<string, number>();

    for (const [, vector] of this.registry) {
      for (const cap of vector.capabilities) {
        capCounts.set(cap.name, (capCounts.get(cap.name) ?? 0) + 1);
      }
    }

    const topCapabilities = Array.from(capCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    const totalCapabilities = Array.from(capCounts.values()).reduce((a, b) => a + b, 0);

    return {
      totalAgents: this.registry.size,
      totalCapabilities,
      topCapabilities,
    };
  }

  deregister(agentId: string): boolean {
    return this.registry.delete(agentId);
  }

  /** Evict agents not updated within the given TTL (default 30 minutes) */
  evictStale(ttlMs: number = 30 * 60_000): number {
    const threshold = Date.now() - ttlMs;
    let removed = 0;
    for (const [agentId, vector] of this.registry) {
      if (new Date(vector.lastUpdated).getTime() < threshold) {
        this.registry.delete(agentId);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.registry.clear();
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const capabilityRegistrySingleton = createTenantAwareSingleton(() => new CapabilityRegistry());

export function getCapabilityRegistry(): CapabilityRegistry {
  return capabilityRegistrySingleton.get();
}

export function resetCapabilityRegistry(): void {
  capabilityRegistrySingleton.reset();
}
