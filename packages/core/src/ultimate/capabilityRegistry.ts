import type { CapabilityVector, AgentCapability } from './types';

const CAPABILITY_REGISTRY = new Map<string, CapabilityVector>();

export class CapabilityRegistry {
  register(agentId: string, vector: Omit<CapabilityVector, 'agentId' | 'version' | 'lastUpdated'>): CapabilityVector {
    const version = `1.0.0`;
    const entry: CapabilityVector = {
      agentId,
      version,
      ...vector,
      lastUpdated: new Date().toISOString(),
    };
    CAPABILITY_REGISTRY.set(agentId, entry);
    return entry;
  }

  update(agentId: string, updates: Partial<CapabilityVector>): CapabilityVector | null {
    const existing = CAPABILITY_REGISTRY.get(agentId);
    if (!existing) return null;

    const [major, minor, patch] = existing.version.split('.').map(Number);
    const updated: CapabilityVector = {
      ...existing,
      ...updates,
      agentId,
      version: `${major}.${minor}.${patch + 1}`,
      lastUpdated: new Date().toISOString(),
    };
    CAPABILITY_REGISTRY.set(agentId, updated);
    return updated;
  }

  get(agentId: string): CapabilityVector | null {
    return CAPABILITY_REGISTRY.get(agentId) ?? null;
  }

  findBestMatch(
    requiredCapabilities: string[],
    constraints?: {
      maxCostPerToken?: number;
      minSuccessRate?: number;
    },
  ): Array<{ agentId: string; matchScore: number; vector: CapabilityVector }> {
    const scored: Array<{ agentId: string; matchScore: number; vector: CapabilityVector }> = [];

    for (const [agentId, vector] of CAPABILITY_REGISTRY) {
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

    for (const req of required) {
      const match = vector.capabilities.find(c =>
        c.name.toLowerCase().includes(req.toLowerCase()) ||
        req.toLowerCase().includes(c.name.toLowerCase()),
      );
      if (match) {
        totalStrength += match.strength;
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
        costPenalty = 0.3;
      }
    }

    return (coverageScore * 0.4 + strengthScore * 0.3 + reliabilityScore * 0.3) - costPenalty;
  }

  getStats(): {
    totalAgents: number;
    totalCapabilities: number;
    topCapabilities: Array<{ name: string; count: number }>;
  } {
    const capCounts = new Map<string, number>();

    for (const [, vector] of CAPABILITY_REGISTRY) {
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
      totalAgents: CAPABILITY_REGISTRY.size,
      totalCapabilities,
      topCapabilities,
    };
  }

  clear(): void {
    CAPABILITY_REGISTRY.clear();
  }
}

let globalCapabilityRegistry: CapabilityRegistry | null = null;

export function getCapabilityRegistry(): CapabilityRegistry {
  if (!globalCapabilityRegistry) {
    globalCapabilityRegistry = new CapabilityRegistry();
  }
  return globalCapabilityRegistry;
}
