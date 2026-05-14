/**
 * Artifact System - Anthropic-inspired artifact pattern for agent communication.
 *
 * Instead of sub-agents reporting findings through chat-style returns (long, lossy,
 * expensive on lead-agent tokens), they write to shared storage and return lightweight
 * references. This prevents the "telephone game" where information loses fidelity
 * each time it passes from subagent to lead.
 */
import type { ArtifactReference } from './types';

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
    query: { tags?: string[]; type?: ArtifactReference['type']; createdBy?: string; since?: string },
    limit = 20,
  ): Promise<ArtifactReference[]> {
    const results: ArtifactReference[] = [];

    for (const { artifact } of ARTIFACT_STORE.values()) {
      if (limit > 0 && results.length >= limit) break;

      if (query.tags && !query.tags.some(t => artifact.tags.includes(t))) continue;
      if (query.type && artifact.type !== query.type) continue;
      if (query.createdBy && artifact.createdBy !== query.createdBy) continue;
      if (query.since && artifact.createdAt < query.since) continue;

      results.push({ ...artifact });
    }

    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
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
    return Math.ceil(text.length / 3.7);
  }
}

let globalArtifactSystem: ArtifactSystem | null = null;

export function getArtifactSystem(): ArtifactSystem {
  if (!globalArtifactSystem) {
    globalArtifactSystem = new ArtifactSystem();
  }
  return globalArtifactSystem;
}

export function resetArtifactSystem(): void {
  globalArtifactSystem = null;
  ARTIFACT_STORE.clear();
}
