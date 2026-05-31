/**
 * Capability-Based Agent Matching (Nucleus-Electron Pattern)
 *
 * Implements ATOM's hybrid architecture (arXiv:2605.26178):
 * - Nucleus: Stable, always-available core agents
 * - Electrons: Dynamically spawned specialists matched by capability
 *
 * Instead of rigid roles (developer, reviewer, QA), agents are defined by
 * their capabilities (typescript, testing, security, etc.) and the system
 * matches task requirements to agent profiles.
 *
 * Key benefits:
 * - 30% token efficiency improvement over static assignment
 * - Complexity-aware budgeting: simple tasks get fewer agents
 * - Agent reuse: existing agents with matching capabilities are reused
 * - Dynamic creation: new agents spawned only when no match exists
 */

import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface CapabilityProfile {
  /** Unique agent identifier */
  agentId: string;
  /** Technical capabilities (e.g., 'typescript', 'react', 'security') */
  capabilities: string[];
  /** Tool access (e.g., 'file_read', 'shell_execute', 'web_search') */
  tools: string[];
  /** Model tier preference */
  modelTier: 'eco' | 'standard' | 'power';
  /** Cost per token (for budget optimization) */
  costPerToken: number;
  /** Quality score (0-1, from past performance) */
  qualityScore: number;
  /** Speed score (0-1, from past performance) */
  speedScore: number;
  /** Whether this is a nucleus (persistent) or electron (dynamic) agent */
  role: 'nucleus' | 'electron';
  /** Specialization depth (0=generalist, 1=highly specialized) */
  specialization: number;
  /** Current availability */
  available: boolean;
  /** Active task count */
  activeTasks: number;
  /** Maximum concurrent tasks */
  maxConcurrent: number;
}

export interface TaskRequirements {
  /** Required capabilities */
  requiredCapabilities: string[];
  /** Preferred capabilities (nice to have) */
  preferredCapabilities?: string[];
  /** Required tools */
  requiredTools?: string[];
  /** Complexity estimate (0-10) */
  complexity: number;
  /** Priority (0-10) */
  priority: number;
  /** Token budget */
  tokenBudget?: number;
  /** Whether parallel execution is needed */
  parallel?: boolean;
  /** Maximum agents to spawn */
  maxAgents?: number;
}

export interface MatchResult {
  /** Matched agent profiles */
  agents: CapabilityProfile[];
  /** Whether all required capabilities are covered */
  fullyCovered: boolean;
  /** Missing capabilities (not covered by any agent) */
  missingCapabilities: string[];
  /** Estimated token cost */
  estimatedTokenCost: number;
  /** Match strategy used */
  strategy: 'reuse' | 'create' | 'hybrid';
  /** Match confidence (0-1) */
  confidence: number;
}

export interface AgentPoolConfig {
  /** Maximum total agents in the pool */
  maxPoolSize: number;
  /** Maximum electrons (dynamic agents) */
  maxElectrons: number;
  /** Minimum quality score to reuse an agent */
  minQualityForReuse: number;
  /** Complexity threshold for spawning electrons */
  complexityThreshold: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_POOL_CONFIG: AgentPoolConfig = {
  maxPoolSize: 20,
  maxElectrons: 10,
  minQualityForReuse: 0.6,
  complexityThreshold: 3,
};

// ============================================================================
// Nucleus Agents (Always Available)
// ============================================================================

/**
 * Default nucleus agents that are always available.
 * These form the stable backbone of the agent pool.
 */
export const DEFAULT_NUCLEUS: CapabilityProfile[] = [
  {
    agentId: 'nucleus-coder',
    capabilities: ['typescript', 'javascript', 'python', 'node', 'react', 'testing', 'debugging'],
    tools: ['file_read', 'file_write', 'file_edit', 'shell_execute', 'code_search', 'apply_patch'],
    modelTier: 'standard',
    costPerToken: 0.001,
    qualityScore: 0.85,
    speedScore: 0.8,
    role: 'nucleus',
    specialization: 0.6,
    available: true,
    activeTasks: 0,
    maxConcurrent: 3,
  },
  {
    agentId: 'nucleus-reviewer',
    capabilities: ['code_review', 'security', 'performance', 'best_practices', 'testing'],
    tools: ['file_read', 'code_search', 'verify'],
    modelTier: 'standard',
    costPerToken: 0.001,
    qualityScore: 0.9,
    speedScore: 0.7,
    role: 'nucleus',
    specialization: 0.7,
    available: true,
    activeTasks: 0,
    maxConcurrent: 2,
  },
  {
    agentId: 'nucleus-researcher',
    capabilities: ['web_search', 'web_fetch', 'analysis', 'summarization', 'research'],
    tools: ['web_search', 'web_fetch', 'file_read', 'file_write'],
    modelTier: 'eco',
    costPerToken: 0.0005,
    qualityScore: 0.8,
    speedScore: 0.9,
    role: 'nucleus',
    specialization: 0.5,
    available: true,
    activeTasks: 0,
    maxConcurrent: 5,
  },
  {
    agentId: 'nucleus-orchestrator',
    capabilities: ['planning', 'decomposition', 'coordination', 'synthesis'],
    tools: ['file_read', 'file_write', 'shell_execute', 'agent'],
    modelTier: 'power',
    costPerToken: 0.002,
    qualityScore: 0.95,
    speedScore: 0.6,
    role: 'nucleus',
    specialization: 0.3,
    available: true,
    activeTasks: 0,
    maxConcurrent: 1,
  },
];

// ============================================================================
// Capability Matcher
// ============================================================================

export class CapabilityMatcher {
  private pool: Map<string, CapabilityProfile> = new Map();
  private config: AgentPoolConfig;
  private createAgent: ((profile: Partial<CapabilityProfile>) => Promise<CapabilityProfile>) | null = null;

  constructor(
    config?: Partial<AgentPoolConfig>,
    createAgentFn?: (profile: Partial<CapabilityProfile>) => Promise<CapabilityProfile>,
  ) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.createAgent = createAgentFn ?? null;

    // Initialize with nucleus agents
    for (const nucleus of DEFAULT_NUCLEUS) {
      this.pool.set(nucleus.agentId, { ...nucleus });
    }
  }

  /**
   * Match task requirements to available agents.
   * Implements the Nucleus-Electron hybrid pattern:
   * 1. Try to match with existing nucleus agents
   * 2. Try to match with existing electron agents
   * 3. Create new electron agents only if needed
   */
  async match(requirements: TaskRequirements): Promise<MatchResult> {
    const { requiredCapabilities, complexity, maxAgents } = requirements;
    const effectiveMaxAgents = maxAgents ?? this.getMaxAgentsForComplexity(complexity);

    // Phase 1: Score all available agents
    const scored = this.scoreAgents(requirements);

    // Phase 2: Select best agents up to maxAgents
    const selected: CapabilityProfile[] = [];
    const coveredCapabilities = new Set<string>();

    for (const { agent } of scored) {
      if (selected.length >= effectiveMaxAgents) break;
      if (!agent.available || agent.activeTasks >= agent.maxConcurrent) continue;

      // Check if this agent adds new capabilities
      const newCaps = agent.capabilities.filter(c =>
        requiredCapabilities.includes(c) && !coveredCapabilities.has(c)
      );

      // Always include if it covers required capabilities, or if we need more agents
      if (newCaps.length > 0 || selected.length < 2) {
        selected.push(agent);
        agent.capabilities.forEach(c => coveredCapabilities.add(c));
      }
    }

    // Phase 3: Check for missing capabilities
    const missingCapabilities = requiredCapabilities.filter(c => !coveredCapabilities.has(c));

    // Phase 4: Create electron agents for missing capabilities (if budget allows)
    let strategy: MatchResult['strategy'] = 'reuse';
    if (missingCapabilities.length > 0 && this.createAgent) {
      const canCreate = Math.min(
        missingCapabilities.length,
        this.config.maxElectrons - this.getElectronCount(),
        effectiveMaxAgents - selected.length,
      );

      if (canCreate > 0 && complexity >= this.config.complexityThreshold) {
        const newAgents = await this.createElectronAgents(missingCapabilities.slice(0, canCreate));
        selected.push(...newAgents);
        newAgents.forEach(a => a.capabilities.forEach(c => coveredCapabilities.add(c)));
        strategy = selected.some(a => a.role === 'nucleus') ? 'hybrid' : 'create';
      }
    }

    const fullyCovered = requiredCapabilities.every(c => coveredCapabilities.has(c));
    const confidence = this.calculateConfidence(selected, requirements);

    return {
      agents: selected,
      fullyCovered,
      missingCapabilities: requiredCapabilities.filter(c => !coveredCapabilities.has(c)),
      estimatedTokenCost: this.estimateTokenCost(selected, requirements),
      strategy,
      confidence,
    };
  }

  /**
   * Update an agent's quality score based on task outcome.
   */
  updateAgentScore(agentId: string, outcome: { success: boolean; quality?: number; speed?: number }): void {
    const agent = this.pool.get(agentId);
    if (!agent) return;

    // Running average with bounded influence
    const alpha = 0.1; // Learning rate
    if (outcome.quality !== undefined) {
      agent.qualityScore = agent.qualityScore * (1 - alpha) + outcome.quality * alpha;
    }
    if (outcome.speed !== undefined) {
      agent.speedScore = agent.speedScore * (1 - alpha) + outcome.speed * alpha;
    }
    if (!outcome.success) {
      agent.qualityScore = Math.max(0.1, agent.qualityScore - 0.05);
    }
  }

  /**
   * Register a new agent in the pool.
   */
  registerAgent(profile: CapabilityProfile): void {
    this.pool.set(profile.agentId, profile);
  }

  /**
   * Remove an agent from the pool.
   */
  removeAgent(agentId: string): void {
    this.pool.delete(agentId);
  }

  /**
   * Get all agents in the pool.
   */
  getPool(): CapabilityProfile[] {
    return Array.from(this.pool.values());
  }

  /**
   * Get available agents.
   */
  getAvailableAgents(): CapabilityProfile[] {
    return Array.from(this.pool.values()).filter(a => a.available && a.activeTasks < a.maxConcurrent);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private scoreAgents(requirements: TaskRequirements): Array<{ agent: CapabilityProfile; score: number }> {
    const results: Array<{ agent: CapabilityProfile; score: number }> = [];
    const agents = Array.from(this.pool.values());

    for (let idx = 0; idx < agents.length; idx++) {
      const agent = agents[idx];
      if (!agent.available) continue;

      let score = 0;

      // Capability match score
      const matchedCaps = agent.capabilities.filter((c: string) =>
        requirements.requiredCapabilities.includes(c)
      ).length;
      const capScore = requirements.requiredCapabilities.length > 0
        ? matchedCaps / requirements.requiredCapabilities.length
        : 0.5;
      score += capScore * 40;

      // Preferred capability bonus
      if (requirements.preferredCapabilities) {
        const preferredMatch = agent.capabilities.filter((c: string) =>
          requirements.preferredCapabilities!.includes(c)
        ).length;
        score += preferredMatch * 5;
      }

      // Tool availability score
      if (requirements.requiredTools) {
        const toolMatch = requirements.requiredTools.filter(t =>
          agent.tools.includes(t)
        ).length;
        score += (toolMatch / requirements.requiredTools.length) * 20;
      }

      // Quality score
      score += agent.qualityScore * 15;

      // Speed score (less weight)
      score += agent.speedScore * 5;

      // Nucleus bonus (more reliable)
      if (agent.role === 'nucleus') score += 10;

      // Availability penalty (busy agents are less desirable)
      const availabilityRatio = 1 - (agent.activeTasks / agent.maxConcurrent);
      score *= availabilityRatio;

      // Complexity matching: specialized agents for complex tasks
      if (requirements.complexity > 7 && agent.specialization > 0.7) score += 10;
      if (requirements.complexity < 3 && agent.specialization < 0.5) score += 5;

      results.push({ agent, score });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private getMaxAgentsForComplexity(complexity: number): number {
    if (complexity <= 2) return 1;
    if (complexity <= 5) return 2;
    if (complexity <= 7) return 4;
    return 8;
  }

  private getElectronCount(): number {
    let count = 0;
    const agents = Array.from(this.pool.values());
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].role === 'electron') count++;
    }
    return count;
  }

  private async createElectronAgents(missingCapabilities: string[]): Promise<CapabilityProfile[]> {
    if (!this.createAgent) return [];

    const created: CapabilityProfile[] = [];
    for (const cap of missingCapabilities) {
      if (this.getElectronCount() >= this.config.maxElectrons) break;

      const profile: Partial<CapabilityProfile> = {
        agentId: `electron-${cap}-${Date.now()}`,
        capabilities: [cap],
        tools: this.inferToolsForCapability(cap),
        modelTier: 'standard',
        costPerToken: 0.001,
        qualityScore: 0.7, // Default for new agents
        speedScore: 0.7,
        role: 'electron',
        specialization: 0.8,
        available: true,
        activeTasks: 0,
        maxConcurrent: 1,
      };

      try {
        const agent = await this.createAgent(profile);
        this.pool.set(agent.agentId, agent);
        created.push(agent);
        getGlobalLogger().info('CapabilityMatcher', `Created electron agent: ${agent.agentId}`, { capability: cap });
      } catch (err) {
        getGlobalLogger().warn('CapabilityMatcher', `Failed to create electron for ${cap}`, { error: String(err) });
      }
    }

    return created;
  }

  private inferToolsForCapability(capability: string): string[] {
    const toolMap: Record<string, string[]> = {
      typescript: ['file_read', 'file_write', 'file_edit', 'shell_execute', 'code_search'],
      python: ['file_read', 'file_write', 'file_edit', 'shell_execute', 'python_execute'],
      testing: ['file_read', 'shell_execute', 'code_search'],
      security: ['file_read', 'code_search', 'web_search'],
      performance: ['file_read', 'shell_execute', 'code_search'],
      research: ['web_search', 'web_fetch', 'file_read'],
      design: ['file_read', 'file_write', 'screenshot_capture'],
      devops: ['file_read', 'file_write', 'shell_execute'],
      database: ['file_read', 'shell_execute'],
      api: ['file_read', 'file_write', 'web_fetch', 'shell_execute'],
    };

    return toolMap[capability] ?? ['file_read', 'shell_execute'];
  }

  private calculateConfidence(agents: CapabilityProfile[], requirements: TaskRequirements): number {
    if (agents.length === 0) return 0;

    // Coverage score
    const covered = new Set<string>();
    for (let i = 0; i < agents.length; i++) {
      for (let j = 0; j < agents[i].capabilities.length; j++) {
        covered.add(agents[i].capabilities[j]);
      }
    }
    const coverage = requirements.requiredCapabilities.length > 0
      ? requirements.requiredCapabilities.filter((c: string) => covered.has(c)).length / requirements.requiredCapabilities.length
      : 1;

    // Quality score (average of matched agents)
    const avgQuality = agents.reduce((s, a) => s + a.qualityScore, 0) / agents.length;

    // Complexity appropriateness
    const complexityFit = requirements.complexity <= 3
      ? (agents.length <= 2 ? 1 : 0.7) // Simple task, fewer agents = better
      : Math.min(1, agents.length / Math.ceil(requirements.complexity / 3));

    return coverage * 0.5 + avgQuality * 0.3 + complexityFit * 0.2;
  }

  private estimateTokenCost(agents: CapabilityProfile[], requirements: TaskRequirements): number {
    // Base cost per agent (system prompt + tool schemas)
    const baseCostPerAgent = 2000;

    // Estimated task tokens based on complexity
    const taskTokens = requirements.complexity * 500;

    // Total: base cost per agent + task tokens distributed across agents
    const totalPerAgent = baseCostPerAgent + (taskTokens / Math.max(agents.length, 1));

    return Math.round(agents.length * totalPerAgent);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalMatcher: CapabilityMatcher | null = null;

export function getCapabilityMatcher(
  config?: Partial<AgentPoolConfig>,
  createAgentFn?: (profile: Partial<CapabilityProfile>) => Promise<CapabilityProfile>,
): CapabilityMatcher {
  if (!globalMatcher) {
    globalMatcher = new CapabilityMatcher(config, createAgentFn);
  }
  return globalMatcher;
}
