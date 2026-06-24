import type { MemoryStore, EpisodicMemoryItem, MemoryKind, MemoryDuration } from '../memory';
export declare function createMemoryStore(type?: 'in-memory' | 'sqlite' | 'json'): Promise<MemoryStore>;
export declare function fromProjectMemoryItem(item: {
    id: string;
    projectId: string;
    missionId?: string;
    agentId?: string;
    kind: MemoryKind;
    title: string;
    content: string;
    tags: string[];
    createdAt: string;
    duration?: MemoryDuration;
}): EpisodicMemoryItem;
export declare function toProjectMemoryItem(item: EpisodicMemoryItem): {
    id: string;
    projectId: string;
    missionId?: string;
    agentId?: string;
    kind: MemoryKind;
    title: string;
    content: string;
    tags: string[];
    createdAt: string;
    duration?: MemoryDuration;
};
