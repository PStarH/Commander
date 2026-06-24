/**
 * Commander Episodic Memory System
 *
 * Based on research findings from:
 * - "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers" (arXiv 2603.07670v1)
 * - Claude Code three-layer memory architecture
 *
 * Implementation:
 * - Layer 1: In-Context Memory (session-scoped, ephemeral)
 * - Layer 2: Episodic Memory Store (SQLite + vector index for semantic search)
 * - Layer 3: Semantic Memory (abstracted knowledge, future work)
 */
// ============================================================================
// In-Memory Implementation (for testing/development)
// ============================================================================
/**
 * In-Memory Memory Store
 *
 * Simple implementation for testing and development.
 * Does NOT persist to disk - use JsonMemoryStore for production.
 */
export class InMemoryMemoryStore {
    items = new Map();
    nextId = 1;
    maxEntries;
    accessOrder = 0;
    accessOrderMap = new Map();
    constructor(maxEntries = 10000) {
        this.maxEntries = maxEntries;
    }
    async write(options) {
        const now = new Date().toISOString();
        const id = `memory-${this.nextId++}`;
        // LRU eviction when at capacity
        if (this.items.size >= this.maxEntries) {
            this.evictLRU();
        }
        const item = {
            id,
            projectId: options.projectId,
            missionId: options.missionId,
            agentId: options.agentId,
            kind: options.kind,
            duration: options.duration ?? 'EPISODIC',
            title: options.title,
            content: options.content,
            tags: options.tags ?? [],
            priority: options.priority ?? this.calculateDefaultPriority(options),
            createdAt: now,
            lastAccessedAt: now,
            expiresAt: (options.duration ?? 'EPISODIC') === 'EPISODIC'
                ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days for episodic
                : undefined,
            evidenceRefs: options.evidenceRefs,
            confidence: options.confidence ?? 0.8,
        };
        this.items.set(id, item);
        this.accessOrderMap.set(id, ++this.accessOrder);
        return item;
    }
    async batchWrite(items) {
        const results = [];
        for (const item of items) {
            results.push(await this.write(item));
        }
        return results;
    }
    async update(options) {
        const item = this.items.get(options.id);
        if (!item || item.projectId !== options.projectId) {
            return null;
        }
        if (options.delete) {
            this.items.delete(options.id);
            this.accessOrderMap.delete(options.id);
            return null;
        }
        if (options.updates) {
            Object.assign(item, options.updates);
            item.lastAccessedAt = new Date().toISOString();
            this.accessOrderMap.set(options.id, ++this.accessOrder);
        }
        return item;
    }
    async delete(id, projectId) {
        const item = this.items.get(id);
        if (!item || item.projectId !== projectId) {
            return false;
        }
        this.items.delete(id);
        this.accessOrderMap.delete(id);
        return true;
    }
    async deleteByMission(missionId, projectId) {
        const toDelete = [];
        for (const [id, item] of this.items) {
            if (item.projectId === projectId && item.missionId === missionId) {
                toDelete.push(id);
            }
        }
        for (const id of toDelete) {
            this.items.delete(id);
            this.accessOrderMap.delete(id);
        }
        return toDelete.length;
    }
    async deleteExpired(projectId) {
        const now = new Date();
        const toDelete = [];
        for (const [id, item] of this.items) {
            if (item.projectId === projectId && item.expiresAt) {
                if (new Date(item.expiresAt) < now) {
                    toDelete.push(id);
                }
            }
        }
        for (const id of toDelete) {
            this.items.delete(id);
            this.accessOrderMap.delete(id);
        }
        return toDelete.length;
    }
    async read(id, projectId) {
        const item = this.items.get(id);
        if (!item || item.projectId !== projectId) {
            return null;
        }
        // Update last accessed time
        item.lastAccessedAt = new Date().toISOString();
        this.accessOrderMap.set(id, ++this.accessOrder);
        return item;
    }
    async search(query) {
        // Single-pass filter: combine all conditions to avoid intermediate array allocations
        const lowerQuery = query.query?.toLowerCase();
        const hasTags = query.tags && query.tags.length > 0;
        const results = [];
        for (const item of this.items.values()) {
            if (item.projectId !== query.projectId)
                continue;
            if (query.kind && item.kind !== query.kind)
                continue;
            if (query.missionId && item.missionId !== query.missionId)
                continue;
            if (query.agentId && item.agentId !== query.agentId)
                continue;
            if (hasTags && !query.tags.some((tag) => item.tags.includes(tag)))
                continue;
            if (query.minPriority !== undefined && item.priority < query.minPriority)
                continue;
            if (query.minConfidence !== undefined && item.confidence < query.minConfidence)
                continue;
            if (lowerQuery &&
                !item.title.toLowerCase().includes(lowerQuery) &&
                !item.content.toLowerCase().includes(lowerQuery))
                continue;
            results.push(item);
        }
        // Sort by priority (descending) then by createdAt (descending, ISO string comparison)
        results.sort((a, b) => {
            if (b.priority !== a.priority)
                return b.priority - a.priority;
            // ISO date strings are lexicographically comparable — no Date parsing needed
            return b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0;
        });
        const total = results.length;
        const limit = query.limit ?? 50;
        const items = results.slice(0, limit);
        return { items, total, query };
    }
    async searchSemantic(query, projectId, limit = 10) {
        // TF-IDF based semantic search
        // Scores items by term frequency × inverse document frequency
        const projectItems = Array.from(this.items.values()).filter((item) => item.projectId === projectId);
        if (projectItems.length === 0)
            return [];
        const queryTerms = tokenize(query);
        if (queryTerms.length === 0)
            return [];
        // Build IDF: log(N / df) where df = number of docs containing term
        const N = projectItems.length;
        const idf = new Map();
        for (const term of queryTerms) {
            const df = projectItems.filter((item) => tokenize(item.title + ' ' + item.content).includes(term)).length;
            idf.set(term, Math.log(N / (df + 1)) + 1);
        }
        // Score each item: sum of (term_freq × idf) normalized by doc length
        const scored = projectItems.map((item) => {
            const docTerms = tokenize(item.title + ' ' + item.content);
            const docLen = docTerms.length || 1;
            let score = 0;
            for (const term of queryTerms) {
                const tf = docTerms.filter((t) => t === term).length / docLen;
                const termIdf = idf.get(term) ?? 1;
                score += tf * termIdf;
            }
            // Boost by priority and confidence
            score *= (1 + item.priority / 100) * (0.5 + item.confidence);
            return { item, score };
        });
        // Sort by score descending, then recency (ISO string comparison — no Date parsing needed)
        scored.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            return b.item.createdAt < a.item.createdAt ? -1 : b.item.createdAt > a.item.createdAt ? 1 : 0;
        });
        return scored.slice(0, limit).map((s) => {
            s.item.lastAccessedAt = new Date().toISOString();
            return s.item;
        });
    }
    async getStats(projectId) {
        const projectItems = Array.from(this.items.values()).filter((item) => item.projectId === projectId);
        const byKind = {
            DECISION: 0,
            ISSUE: 0,
            LESSON: 0,
            SUMMARY: 0,
        };
        const byDuration = {
            EPISODIC: 0,
            LONG_TERM: 0,
        };
        const tagCounts = new Map();
        let totalPriority = 0;
        let totalConfidence = 0;
        let oldestItem;
        let newestItem;
        for (const item of projectItems) {
            byKind[item.kind]++;
            byDuration[item.duration]++;
            totalPriority += item.priority;
            totalConfidence += item.confidence;
            for (const tag of item.tags) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
            if (!oldestItem || item.createdAt < oldestItem) {
                oldestItem = item.createdAt;
            }
            if (!newestItem || item.createdAt > newestItem) {
                newestItem = item.createdAt;
            }
        }
        const topTags = Array.from(tagCounts.entries())
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        return {
            totalItems: projectItems.length,
            byKind,
            byDuration,
            avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
            avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
            topTags,
            oldestItem,
            newestItem,
        };
    }
    async close() {
        // No-op for in-memory store
    }
    evictLRU() {
        let oldestId;
        let oldestOrder = Infinity;
        for (const [id, order] of this.accessOrderMap) {
            if (order < oldestOrder) {
                oldestOrder = order;
                oldestId = id;
            }
        }
        if (oldestId) {
            this.items.delete(oldestId);
            this.accessOrderMap.delete(oldestId);
        }
    }
    calculateDefaultPriority(options) {
        // Base priority based on kind
        const kindPriority = {
            DECISION: 80,
            ISSUE: 70,
            LESSON: 90,
            SUMMARY: 50,
        };
        let priority = kindPriority[options.kind] ?? 50;
        // Boost if has mission/agent context
        if (options.missionId)
            priority += 5;
        if (options.agentId)
            priority += 5;
        // Boost if has evidence
        if (options.evidenceRefs && options.evidenceRefs.length > 0) {
            priority += Math.min(options.evidenceRefs.length * 5, 15);
        }
        return Math.min(priority, 100);
    }
}
import { tokenize } from './memory/tokenizer';
export { JsonMemoryStore } from './memory/jsonStore';
export { createMemoryStore, fromProjectMemoryItem, toProjectMemoryItem } from './memory/utils';
