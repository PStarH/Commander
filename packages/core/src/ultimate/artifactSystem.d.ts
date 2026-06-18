/**
 * Artifact System - Anthropic-inspired artifact pattern for agent communication.
 *
 * Instead of sub-agents reporting findings through chat-style returns (long, lossy,
 * expensive on lead-agent tokens), they write to shared storage and return lightweight
 * references. This prevents the "telephone game" where information loses fidelity
 * each time it passes from subagent to lead.
 */
import type { ArtifactReference } from './types';
export declare class ArtifactSystem {
    write(agentId: string, type: ArtifactReference['type'], title: string, summary: string, content: string, tags?: string[], externalUri?: string): Promise<ArtifactReference>;
    read(id: string): Promise<{
        artifact: ArtifactReference;
        content: string;
    } | null>;
    readContent(id: string): Promise<string | null>;
    find(query: {
        tags?: string[];
        type?: ArtifactReference['type'];
        createdBy?: string;
        since?: string;
        textSearch?: string;
    }, limit?: number): Promise<ArtifactReference[]>;
    /**
     * Search artifacts by text content with relevance scoring.
     * Returns results sorted by relevance (how many times the search term appears).
     */
    search(query: string, options?: {
        type?: ArtifactReference['type'];
        limit?: number;
    }): Promise<Array<{
        artifact: ArtifactReference;
        relevance: number;
    }>>;
    delete(id: string): Promise<boolean>;
    getStats(): Promise<{
        totalArtifacts: number;
        totalTokens: number;
        byType: Record<string, number>;
        topTags: Array<{
            tag: string;
            count: number;
        }>;
    }>;
    clear(): void;
    private estimateTokens;
}
export declare function getArtifactSystem(): ArtifactSystem;
export declare function resetArtifactSystem(): void;
//# sourceMappingURL=artifactSystem.d.ts.map