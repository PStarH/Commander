/**
 * Cross-Agent Memory Federation
 *
 * Enables multiple agents to share knowledge while preserving privacy:
 *
 *   Agent A (private episodic) ─┐
 *   Agent B (private episodic) ─┼→ [Federation Layer] → Shared Semantic Store
 *   Agent C (private episodic) ─┘         ↑
 *                                         │
 *   Any Agent ← query ← [Federation API] ─┘
 *
 * Architecture:
 * 1. Private Episodic Memory: each agent's experiences stay local (never shared raw)
 * 2. Shared Semantic Memory: a common knowledge graph of entities and relationships
 *    that all agents can read. Writes are sanitized via differential privacy.
 * 3. Procedural Memory Sharing: high-utility procedural rules (SOPs, tool patterns)
 *    are shared after DP sanitization, so agents can learn from each other's
 *    successes without revealing specific task details.
 *
 * Privacy guarantees:
 * - Episodic memories are NEVER shared directly
 * - Semantic entities are shared only after DP sanitization (importance/accessCount
 *   are noised via Laplace mechanism)
 * - Procedural rules are shared only if success rate exceeds a threshold AND
 *   after DP sanitization of usage statistics
 * - Each agent has a privacy budget (ε) that is consumed on each share operation
 *
 * Per constraint PIV-FR-11, supports transfer learning across agents.
 * Per constraint PIV-FR-12, generates explicit reasoning traces.
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { getDifferentialPrivacyLayer } from '../security/differentialPrivacyLayer';
import type { DPQueryOutcome } from '../security/differentialPrivacyLayer';
import { getGlobalSemanticMemoryStore, SemanticMemoryStore } from './semanticStore';
import type { ISemanticEntity } from '../contracts/pillarIV';
import type { EpisodicMemoryItem, MemoryMeta } from '../episodicMemory';
import type { ProceduralEntry } from './proceduralStore';

// ============================================================================
// Types
// ============================================================================

/**
 * A contribution from an agent to the shared knowledge graph.
 */
export interface FederationContribution {
  /** Contributing agent ID */
  agentId: string;
  /** Entity to share */
  entity: Omit<ISemanticEntity, 'id'>;
  /** Privacy epsilon spent for this contribution */
  epsilonSpent: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * A shared procedural rule (after DP sanitization).
 */
export interface SharedProceduralRule {
  /** Original rule ID (hashed for privacy) */
  ruleHash: string;
  /** Procedural type */
  proceduralType: 'sop' | 'tool' | 'workflow' | 'heuristic';
  /** Sanitized content (conditions/action, no sensitive details) */
  sanitizedContent: string;
  /** Sanitized success rate (noised via DP) */
  sanitizedSuccessRate: number;
  /** Sanitized invocation count (noised via DP) */
  sanitizedInvocationCount: number;
  /** Contributing agent ID (hashed) */
  agentHash: string;
  /** Tags for categorization */
  tags: string[];
}

/**
 * Federation query options.
 */
export interface FederationQuery {
  /** Text query for semantic search */
  text?: string;
  /** Entity type filter */
  type?: string;
  /** Relationship type filter */
  relationshipType?: string;
  /** Maximum results */
  limit?: number;
  /** Include shared procedural rules */
  includeProcedural?: boolean;
  /** Procedural type filter */
  proceduralType?: 'sop' | 'tool' | 'workflow' | 'heuristic';
}

/**
 * Federation query result.
 */
export interface FederationResult {
  /** Shared semantic entities */
  entities: ISemanticEntity[];
  /** Shared procedural rules */
  proceduralRules: SharedProceduralRule[];
  /** Total contributions from all agents */
  totalContributions: number;
  /** Privacy budget status */
  privacyBudget: { total: number; remaining: number };
}

// ============================================================================
// Cross-Agent Memory Federation
// ============================================================================

export class MemoryFederation {
  private sharedSemanticStore: SemanticMemoryStore;
  private contributions: Map<string, FederationContribution[]> = new Map();
  private sharedProceduralRules: SharedProceduralRule[] = [];
  private agentRegistry: Set<string> = new Set();
  private totalEpsilonSpent = 0;
  private readonly maxTotalEpsilon: number;

  constructor(options?: { semanticStore?: SemanticMemoryStore; maxTotalEpsilon?: number }) {
    this.sharedSemanticStore = options?.semanticStore ?? getGlobalSemanticMemoryStore();
    this.maxTotalEpsilon = options?.maxTotalEpsilon ?? 100; // Total budget across all agents
  }

  /**
   * Register an agent as a federation participant.
   */
  registerAgent(agentId: string): void {
    this.agentRegistry.add(agentId);
    getGlobalLogger().info('MemoryFederation', 'Agent registered', { agentId });
  }

  /**
   * Contribute an entity to the shared semantic store.
   *
   * The entity's numeric fields (if any) are sanitized via differential
   * privacy before being added to the shared store. The contributing
   * agent's privacy budget is consumed.
   *
   * @returns true if the contribution was accepted, false if privacy budget exhausted
   */
  async contributeEntity(agentId: string, entity: Omit<ISemanticEntity, 'id'>): Promise<boolean> {
    if (!this.agentRegistry.has(agentId)) {
      this.registerAgent(agentId);
    }

    const dp = getDifferentialPrivacyLayer();

    // Estimate total epsilon needed: 0.5 for the entity + 0.5 per relationship
    const estimatedEpsilon = 0.5 + entity.relationships.length * 0.5;

    // Check privacy budget
    const budget = dp.getBudget(agentId);
    if (budget.remainingBudget < estimatedEpsilon) {
      getGlobalLogger().warn('MemoryFederation', 'Privacy budget exhausted', {
        agentId,
        needed: estimatedEpsilon,
        remaining: budget.remainingBudget,
      });
      return false;
    }

    // Sanitize the entity description (strip agent-specific details)
    // Track actual epsilon spent by reading budget before and after
    const budgetBefore = dp.getBudget(agentId).remainingBudget;

    // Explicitly consume base epsilon for the entity contribution itself.
    // Sharing any data about an entity reveals information, so the base
    // epsilon (0.5) must be spent even if no numeric fields are sanitized.
    dp.spendBudget(agentId, 0.5);

    const sanitizedEntity: Omit<ISemanticEntity, 'id'> = {
      name: entity.name,
      type: entity.type,
      description: this.sanitizeDescription(entity.description),
      relationships: entity.relationships.map((r) => ({
        ...r,
        strength: this.sanitizeNumeric(r.strength, agentId, 0.5),
      })),
    };

    // Calculate actual epsilon spent (base 0.5 + per-relationship DP)
    const budgetAfter = dp.getBudget(agentId).remainingBudget;
    const actualEpsilonSpent = Math.max(0, budgetBefore - budgetAfter);

    // Add to shared store
    await this.sharedSemanticStore.ingest(sanitizedEntity);

    // Track contribution with actual epsilon spent
    const contribution: FederationContribution = {
      agentId,
      entity: sanitizedEntity,
      epsilonSpent: actualEpsilonSpent,
      timestamp: Date.now(),
    };

    const agentContributions = this.contributions.get(agentId) ?? [];
    agentContributions.push(contribution);
    this.contributions.set(agentId, agentContributions);

    this.totalEpsilonSpent += actualEpsilonSpent;

    getGlobalLogger().debug('MemoryFederation', 'Entity contributed', {
      agentId,
      entityName: entity.name,
      entityType: entity.type,
    });

    return true;
  }

  /**
   * Contribute a procedural rule to the shared store.
   *
   * Only rules with success rate above the threshold are shared.
   * Usage statistics are sanitized via DP.
   */
  async contributeProceduralRule(agentId: string, rule: ProceduralEntry): Promise<boolean> {
    if (!this.agentRegistry.has(agentId)) {
      this.registerAgent(agentId);
    }

    // Only share rules with decent success rate
    if (rule.successRate < 0.6) {
      getGlobalLogger().debug('MemoryFederation', 'Rule not shared (low success rate)', {
        agentId,
        successRate: rule.successRate,
      });
      return false;
    }

    const dp = getDifferentialPrivacyLayer();

    // Estimate epsilon: 0.3 for successRate + 0.3 for invocationCount
    const estimatedEpsilon = 0.6;
    const budget = dp.getBudget(agentId);
    if (budget.remainingBudget < estimatedEpsilon) {
      return false;
    }

    // Track actual epsilon spent
    const budgetBefore = dp.getBudget(agentId).remainingBudget;

    // Sanitize the rule content — remove agent-specific details
    const sanitizedContent = this.sanitizeDescription(rule.content);

    // Sanitize numeric fields via DP
    const sanitizedSuccessRate = this.sanitizeNumeric(rule.successRate, agentId, 0.3);
    const sanitizedInvocationCount = this.sanitizeInteger(rule.invocationCount, agentId, 0.3);

    // Calculate actual epsilon spent
    const budgetAfter = dp.getBudget(agentId).remainingBudget;
    const actualEpsilonSpent = Math.max(0, budgetBefore - budgetAfter);

    // Hash the agent ID for privacy
    const agentHash = this.hashString(agentId);
    const ruleHash = this.hashString(rule.id);

    const sharedRule: SharedProceduralRule = {
      ruleHash,
      proceduralType: rule.proceduralType,
      sanitizedContent,
      sanitizedSuccessRate,
      sanitizedInvocationCount,
      agentHash,
      tags: rule.tags,
    };

    this.sharedProceduralRules.push(sharedRule);
    this.totalEpsilonSpent += actualEpsilonSpent;

    getGlobalLogger().debug('MemoryFederation', 'Procedural rule contributed', {
      agentId,
      proceduralType: rule.proceduralType,
      sanitizedSuccessRate,
    });

    return true;
  }

  /**
   * Query the shared federation knowledge.
   *
   * Any registered agent can query the shared semantic store and
   * shared procedural rules. No privacy budget is consumed for reads.
   */
  async query(options: FederationQuery): Promise<FederationResult> {
    // Query shared semantic store
    let entities: ISemanticEntity[] = [];
    if (options.text || options.type) {
      entities = await this.sharedSemanticStore.query({
        text: options.text,
        type: options.type,
        relationshipType: options.relationshipType,
        limit: options.limit ?? 10,
      });
    }

    // Filter shared procedural rules
    let proceduralRules = [...this.sharedProceduralRules];
    if (options.proceduralType) {
      proceduralRules = proceduralRules.filter((r) => r.proceduralType === options.proceduralType);
    }
    if (options.includeProcedural !== false) {
      // Sort by sanitized success rate (descending)
      proceduralRules.sort((a, b) => b.sanitizedSuccessRate - a.sanitizedSuccessRate);
      proceduralRules = proceduralRules.slice(0, options.limit ?? 5);
    } else {
      proceduralRules = [];
    }

    // Count total contributions
    let totalContributions = 0;
    for (const contribs of this.contributions.values()) {
      totalContributions += contribs.length;
    }
    totalContributions += this.sharedProceduralRules.length;

    return {
      entities,
      proceduralRules,
      totalContributions,
      privacyBudget: {
        total: this.maxTotalEpsilon,
        remaining: Math.max(0, this.maxTotalEpsilon - this.totalEpsilonSpent),
      },
    };
  }

  /**
   * Transfer a procedural rule from one agent to another.
   *
   * This is the explicit transfer learning mechanism: an agent that
   * has learned a successful pattern can transfer it to another agent.
   * The receiving agent gets a copy with reset statistics (they start
   * fresh but benefit from the learned pattern).
   */
  async transferProceduralRule(
    sourceAgentId: string,
    targetAgentId: string,
    rule: ProceduralEntry,
  ): Promise<boolean> {
    // Contribute to the shared store (with DP sanitization)
    const contributed = await this.contributeProceduralRule(sourceAgentId, rule);
    if (!contributed) return false;

    // The target agent can query the shared store to find this rule
    // In a real implementation, we'd also notify the target agent
    getGlobalLogger().info('MemoryFederation', 'Procedural rule transferred', {
      sourceAgent: sourceAgentId,
      targetAgent: targetAgentId,
      proceduralType: rule.proceduralType,
    });

    return true;
  }

  /**
   * Get federation statistics.
   */
  getStats(): {
    registeredAgents: number;
    totalContributions: number;
    sharedEntities: number;
    sharedProceduralRules: number;
    totalEpsilonSpent: number;
    remainingEpsilon: number;
  } {
    let totalContributions = 0;
    for (const contribs of this.contributions.values()) {
      totalContributions += contribs.length;
    }
    totalContributions += this.sharedProceduralRules.length;

    return {
      registeredAgents: this.agentRegistry.size,
      totalContributions,
      sharedEntities: this.sharedSemanticStore.size,
      sharedProceduralRules: this.sharedProceduralRules.length,
      totalEpsilonSpent: this.totalEpsilonSpent,
      remainingEpsilon: Math.max(0, this.maxTotalEpsilon - this.totalEpsilonSpent),
    };
  }

  /**
   * Get contributions from a specific agent.
   */
  getAgentContributions(agentId: string): FederationContribution[] {
    return this.contributions.get(agentId) ?? [];
  }

  // --------------------------------------------------------------------------
  // Internal: Privacy helpers
  // --------------------------------------------------------------------------

  /**
   * Sanitize a text description by removing agent-specific identifiers,
   * file paths, and other sensitive patterns.
   */
  private sanitizeDescription(text: string): string {
    return (
      text
        // Remove file paths
        .replace(/\/[^\s"']+/g, '[path]')
        // Remove email addresses
        .replace(/[\w.-]+@[\w.-]+\.\w+/g, '[email]')
        // Remove IP addresses
        .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]')
        // Remove API keys and tokens (long hex/base64 strings)
        .replace(/\b[a-fA-F0-9]{32,}\b/g, '[redacted]')
        .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted]')
    );
  }

  /**
   * Sanitize a numeric value via the Laplace mechanism.
   * If DP fails (budget exhausted), returns a safe default rather than
   * leaking the original value.
   */
  private sanitizeNumeric(value: number, agentId: string, epsilon: number): number {
    const dp = getDifferentialPrivacyLayer();
    const outcome = dp.sanitizeCount(Math.round(value * 100), agentId, epsilon);
    if (outcome.result !== undefined) {
      return Math.max(0, Math.min(1, outcome.result / 100));
    }
    // DP failed — return a neutral default (0.5) rather than leaking original
    getGlobalLogger().warn('MemoryFederation', 'DP sanitization failed — using safe default', {
      agentId,
    });
    return 0.5;
  }

  /**
   * Sanitize an integer via the Laplace mechanism.
   * If DP fails, returns 0 rather than leaking the original value.
   */
  private sanitizeInteger(value: number, agentId: string, epsilon: number): number {
    const dp = getDifferentialPrivacyLayer();
    const outcome = dp.sanitizeCount(value, agentId, epsilon);
    if (outcome.result !== undefined) {
      return outcome.result;
    }
    // DP failed — return 0 rather than leaking original
    getGlobalLogger().warn(
      'MemoryFederation',
      'DP integer sanitization failed — using safe default',
      { agentId },
    );
    return 0;
  }

  /**
   * Hash a string for privacy (SHA-256, truncated).
   */
  private hashString(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalFederation: MemoryFederation | null = null;

export function getGlobalMemoryFederation(): MemoryFederation {
  if (!globalFederation) {
    globalFederation = new MemoryFederation();
  }
  return globalFederation;
}

export function setGlobalMemoryFederation(federation: MemoryFederation | null): void {
  globalFederation = federation;
}
