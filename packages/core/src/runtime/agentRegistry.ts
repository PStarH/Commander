/**
 * AgentRegistry — Persistent Agent Identity
 *
 * Tracks agent capabilities, performance history, and learned preferences.
 * Unlike ephemeral sub-agent IDs, the registry persists across sessions.
 *
 * Research backing: AutoGen's agent registry, CrewAI's agent memory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  createdAt: string;
  lastUsedAt: string;
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  totalTokensUsed: number;
  averageTaskDurationMs: number;
  preferredTools: string[];
  learnedPreferences: Record<string, unknown>;
}

interface RegistryData {
  agents: AgentProfile[];
  version: number;
}

const REGISTRY_FILE = '.commander/agent-registry.json';
const MAX_AGENTS = 100;

export class AgentRegistry {
  private agents: Map<string, AgentProfile> = new Map();
  private registryPath: string;

  constructor(basePath?: string) {
    this.registryPath = path.join(basePath ?? process.cwd(), REGISTRY_FILE);
    this.load();
  }

  /** Get or create a persistent agent ID by name. Returns stable ID for the agent type. */
  getOrCreateAgentId(
    name: string,
    meta?: { description?: string; capabilities?: string[] },
  ): string {
    const stableId = `agent-${name}`;
    if (!this.agents.has(stableId)) {
      this.register({
        id: stableId,
        name,
        description: meta?.description ?? '',
        capabilities: meta?.capabilities ?? [],
      });
    } else {
      // Update last used time
      const agent = this.agents.get(stableId)!;
      agent.lastUsedAt = new Date().toISOString();
    }
    return stableId;
  }

  /** Register or update an agent profile */
  register(profile: Partial<AgentProfile> & { id: string; name: string }): AgentProfile {
    const existing = this.agents.get(profile.id);
    const now = new Date().toISOString();

    if (existing) {
      // Update existing profile
      Object.assign(existing, profile, { lastUsedAt: now });
      this.save();
      return existing;
    }

    // Create new profile
    const newProfile: AgentProfile = {
      id: profile.id,
      name: profile.name,
      description: profile.description ?? '',
      capabilities: profile.capabilities ?? [],
      createdAt: now,
      lastUsedAt: now,
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      totalTokensUsed: 0,
      averageTaskDurationMs: 0,
      preferredTools: profile.preferredTools ?? [],
      learnedPreferences: profile.learnedPreferences ?? {},
    };

    // Enforce max agents with LRU eviction
    if (this.agents.size >= MAX_AGENTS) {
      const oldest = Array.from(this.agents.values()).sort(
        (a, b) => new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime(),
      )[0];
      if (oldest) this.agents.delete(oldest.id);
    }

    this.agents.set(newProfile.id, newProfile);
    this.save();
    return newProfile;
  }

  /** Record task completion for an agent */
  recordTask(
    agentId: string,
    outcome: {
      success: boolean;
      tokensUsed: number;
      durationMs: number;
      toolsUsed?: string[];
    },
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.totalTasks++;
    if (outcome.success) agent.successfulTasks++;
    else agent.failedTasks++;
    agent.totalTokensUsed += outcome.tokensUsed;
    agent.lastUsedAt = new Date().toISOString();

    // Update rolling average duration
    agent.averageTaskDurationMs =
      (agent.averageTaskDurationMs * (agent.totalTasks - 1) + outcome.durationMs) /
      agent.totalTasks;

    // Track preferred tools
    if (outcome.toolsUsed) {
      for (const tool of outcome.toolsUsed) {
        if (!agent.preferredTools.includes(tool)) {
          agent.preferredTools.push(tool);
        }
      }
      // Keep only top 10 preferred tools
      if (agent.preferredTools.length > 10) {
        agent.preferredTools = agent.preferredTools.slice(-10);
      }
    }

    this.save();
  }

  /** Get agent profile by ID */
  get(agentId: string): AgentProfile | undefined {
    return this.agents.get(agentId);
  }

  /** Find agents by capability, sorted by success rate */
  findByCapability(capability: string): AgentProfile[] {
    return Array.from(this.agents.values())
      .filter((a) => a.capabilities.includes(capability))
      .sort(
        (a, b) =>
          b.successfulTasks / Math.max(b.totalTasks, 1) -
          a.successfulTasks / Math.max(a.totalTasks, 1),
      );
  }

  /** Find the best agent for a task based on capabilities and success rate */
  findBestForTask(requiredCapabilities: string[]): AgentProfile | undefined {
    const candidates = Array.from(this.agents.values())
      .filter((a) => requiredCapabilities.some((c) => a.capabilities.includes(c)))
      .sort((a, b) => {
        // Score: capability match ratio * success rate
        const aMatch =
          requiredCapabilities.filter((c) => a.capabilities.includes(c)).length /
          requiredCapabilities.length;
        const bMatch =
          requiredCapabilities.filter((c) => b.capabilities.includes(c)).length /
          requiredCapabilities.length;
        const aRate = a.totalTasks > 0 ? a.successfulTasks / a.totalTasks : 0.5;
        const bRate = b.totalTasks > 0 ? b.successfulTasks / b.totalTasks : 0.5;
        return bMatch * bRate - aMatch * aRate;
      });
    return candidates[0];
  }

  /** Get all registered agents */
  list(): AgentProfile[] {
    return Array.from(this.agents.values());
  }

  /** Get agent success rate */
  getSuccessRate(agentId: string): number {
    const agent = this.agents.get(agentId);
    if (!agent || agent.totalTasks === 0) return 0;
    return agent.successfulTasks / agent.totalTasks;
  }

  /** Learn a preference for an agent */
  setPreference(agentId: string, key: string, value: unknown): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.learnedPreferences[key] = value;
    this.save();
  }

  /** Remove an agent */
  remove(agentId: string): boolean {
    const result = this.agents.delete(agentId);
    if (result) this.save();
    return result;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.registryPath)) return;
      const data: RegistryData = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (data.agents && Array.isArray(data.agents)) {
        for (const agent of data.agents) {
          if (agent.id && agent.name) {
            this.agents.set(agent.id, agent);
          }
        }
      }
    } catch (e) {
      getGlobalLogger().warn('AgentRegistry', 'Failed to load registry', {
        error: (e as Error)?.message,
      });
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.registryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: RegistryData = { agents: Array.from(this.agents.values()), version: 1 };
      const tmpPath = `${this.registryPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.registryPath);
    } catch (e) {
      getGlobalLogger().warn('AgentRegistry', 'Failed to save registry', {
        error: (e as Error)?.message,
      });
    }
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const agentRegistrySingleton = createTenantAwareSingleton(() => new AgentRegistry());

export function getAgentRegistry(): AgentRegistry {
  return agentRegistrySingleton.get();
}

export function resetAgentRegistry(): void {
  agentRegistrySingleton.reset();
}
