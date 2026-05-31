/**
 * Artifact System - Anthropic-inspired artifact pattern for agent communication.
 *
 * Instead of sub-agents reporting findings through chat-style returns (long, lossy,
 * expensive on lead-agent tokens), they write to shared storage and return lightweight
 * references. This prevents the "telephone game" where information loses fidelity
 * each time it passes from subagent to lead.
 */
import type { ArtifactReference } from './types';

/** Maximum artifacts in the store before oldest are evicted */
const MAX_ARTIFACTS = 500;

/** Characters per token estimate for token counting */
const CHARS_PER_TOKEN = 3.7;

const ARTIFACT_STORE = new Map<string, { artifact: ArtifactReference; content: string }>();
let artifactCounter = 0;

export class ArtifactSystem {
  async write(
    agentId: string,
    type: ArtifactReference['type'],
    title: string,
    summary: string,
    content: string,
    tags: string[] = [],
    externalUri?: string,
  ): Promise<ArtifactReference> {
    const id = `artifact_${Date.now()}_${++artifactCounter}`;
    const tokenCount = this.estimateTokens(content);

    const artifact: ArtifactReference = {
      id,
      type,
      title,
      summary: summary.slice(0, 200),
      createdBy: agentId,
      createdAt: new Date().toISOString(),
      tokenCount,
      tags,
      content: externalUri ? undefined : content,
      externalUri,
    };

    ARTIFACT_STORE.set(id, { artifact, content });

    // Evict oldest entries when over capacity
    if (ARTIFACT_STORE.size > MAX_ARTIFACTS) {
      const evictCount = ARTIFACT_STORE.size - MAX_ARTIFACTS;
      let evicted = 0;
      for (const key of ARTIFACT_STORE.keys()) {
        if (evicted >= evictCount) break;
        ARTIFACT_STORE.delete(key);
        evicted++;
      }
    }

    return artifact;
  }

  async read(id: string): Promise<{ artifact: ArtifactReference; content: string } | null> {
    const stored = ARTIFACT_STORE.get(id);
    if (!stored) return null;
    return {
      artifact: { ...stored.artifact },
      content: stored.content,
    };
  }

  async readContent(id: string): Promise<string | null> {
    const stored = ARTIFACT_STORE.get(id);
    if (!stored) return null;
    return stored.content;
  }

  async find(
    query: { tags?: string[]; type?: ArtifactReference['type']; createdBy?: string; since?: string; textSearch?: string },
    limit = 20,
  ): Promise<ArtifactReference[]> {
    const results: ArtifactReference[] = [];

    for (const { artifact, content } of ARTIFACT_STORE.values()) {
      if (limit > 0 && results.length >= limit) break;

      if (query.tags && !query.tags.some(t => artifact.tags.includes(t))) continue;
      if (query.type && artifact.type !== query.type) continue;
      if (query.createdBy && artifact.createdBy !== query.createdBy) continue;
      if (query.since && artifact.createdAt < query.since) continue;

      // Text search: match against title, summary, and content
      if (query.textSearch) {
        const searchLower = query.textSearch.toLowerCase();
        const matchesTitle = artifact.title.toLowerCase().includes(searchLower);
        const matchesSummary = artifact.summary.toLowerCase().includes(searchLower);
        const matchesContent = content.toLowerCase().includes(searchLower);
        if (!matchesTitle && !matchesSummary && !matchesContent) continue;
      }

      results.push({ ...artifact });
    }

    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Search artifacts by text content with relevance scoring.
   * Returns results sorted by relevance (how many times the search term appears).
   */
  async search(
    query: string,
    options?: { type?: ArtifactReference['type']; limit?: number },
  ): Promise<Array<{ artifact: ArtifactReference; relevance: number }>> {
    const limit = options?.limit ?? 20;
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

    const scored: Array<{ artifact: ArtifactReference; relevance: number }> = [];

    for (const { artifact, content } of ARTIFACT_STORE.values()) {
      if (options?.type && artifact.type !== options.type) continue;

      const contentLower = content.toLowerCase();
      let relevance = 0;

      // Count term occurrences
      for (const term of queryTerms) {
        const titleMatches = (artifact.title.toLowerCase().match(new RegExp(term, 'g')) || []).length;
        const summaryMatches = (artifact.summary.toLowerCase().match(new RegExp(term, 'g')) || []).length;
        const contentMatches = (contentLower.match(new RegExp(term, 'g')) || []).length;

        // Weight: title > summary > content
        relevance += titleMatches * 3 + summaryMatches * 2 + contentMatches;
      }

      if (relevance > 0) {
        scored.push({ artifact, relevance });
      }
    }

    return scored
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  async delete(id: string): Promise<boolean> {
    return ARTIFACT_STORE.delete(id);
  }

  async getStats(): Promise<{
    totalArtifacts: number;
    totalTokens: number;
    byType: Record<string, number>;
    topTags: Array<{ tag: string; count: number }>;
  }> {
    let totalTokens = 0;
    const byType: Record<string, number> = {};
    const tagCounts = new Map<string, number>();

    for (const { artifact } of ARTIFACT_STORE.values()) {
      totalTokens += artifact.tokenCount;
      byType[artifact.type] = (byType[artifact.type] ?? 0) + 1;
      for (const tag of artifact.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    return {
      totalArtifacts: ARTIFACT_STORE.size,
      totalTokens,
      byType,
      topTags,
    };
  }

  clear(): void {
    ARTIFACT_STORE.clear();
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const artifactSystemSingleton = createTenantAwareSingleton(() => new ArtifactSystem());

export function getArtifactSystem(): ArtifactSystem {
  return artifactSystemSingleton.get();
}

export function resetArtifactSystem(): void {
  artifactSystemSingleton.reset();
  ARTIFACT_STORE.clear();
}
