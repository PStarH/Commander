"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonMemoryStore = void 0;
/**
 * JSON-file backed MemoryStore implementation.
 * Persists EpisodicMemoryItems to a JSON file on disk.
 */
const promises_1 = require("fs/promises");
const logging_1 = require("../logging");
const ftsScorer_1 = require("./ftsScorer");
/**
 * JSON-file backed MemoryStore for simple persistence.
 * Falls back gracefully when SQLite is unavailable.
 *
 * Uses BM25 scoring (Okapi BM25) for high-quality full-text search,
 * matching the search quality of SQLite FTS5.
 */
class JsonMemoryStore {
    constructor(filePath) {
        this.items = new Map();
        this.nextId = 1;
        this.dirty = false;
        this.persistTimer = null;
        // BM25 scorer for full-text search (replaces basic inverted index)
        this.bm25 = new ftsScorer_1.BM25Scorer();
        // Per-item token cache to avoid re-tokenizing on every search
        this.tokenCache = new Map();
        this.indexDirty = true;
        this.filePath = filePath;
    }
    async init() {
        try {
            const data = await (0, promises_1.readFile)(this.filePath, 'utf-8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    this.items.set(item.id, item);
                    const num = parseInt(item.id.replace('memory-', ''), 10);
                    if (!isNaN(num) && num >= this.nextId)
                        this.nextId = num + 1;
                }
            }
        }
        catch {
            (0, logging_1.getGlobalLogger)().debug('JsonMemoryStore', 'Init load failed — starting empty');
        }
        // Rebuild inverted index after loading
        this.rebuildIndex();
    }
    async persist() {
        if (!this.dirty)
            return;
        const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
        if (dir)
            await (0, promises_1.mkdir)(dir, { recursive: true });
        await (0, promises_1.writeFile)(this.filePath, JSON.stringify(Array.from(this.items.values()), null, 2));
        this.dirty = false;
    }
    async write(options) {
        var _a, _b, _c, _d, _e, _f, _g;
        // Auto-cleanup expired items periodically to prevent unbounded growth
        if (this.items.size > 0 && this.items.size % 100 === 0) {
            await this.deleteExpired(options.projectId || 'default');
        }
        const now = new Date().toISOString();
        const id = `memory-${this.nextId++}`;
        const kindPriority = {
            DECISION: 80,
            ISSUE: 70,
            LESSON: 90,
            SUMMARY: 50,
        };
        let priority = (_b = (_a = options.priority) !== null && _a !== void 0 ? _a : kindPriority[options.kind]) !== null && _b !== void 0 ? _b : 50;
        if (options.missionId)
            priority += 5;
        if (options.agentId)
            priority += 5;
        if ((_c = options.evidenceRefs) === null || _c === void 0 ? void 0 : _c.length)
            priority += Math.min(options.evidenceRefs.length * 5, 15);
        priority = Math.min(priority, 100);
        const item = {
            id,
            projectId: options.projectId,
            missionId: options.missionId,
            agentId: options.agentId,
            kind: options.kind,
            duration: (_d = options.duration) !== null && _d !== void 0 ? _d : 'EPISODIC',
            title: options.title,
            content: options.content,
            tags: (_e = options.tags) !== null && _e !== void 0 ? _e : [],
            priority,
            createdAt: now,
            lastAccessedAt: now,
            expiresAt: ((_f = options.duration) !== null && _f !== void 0 ? _f : 'EPISODIC') === 'EPISODIC'
                ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
                : undefined,
            evidenceRefs: options.evidenceRefs,
            confidence: (_g = options.confidence) !== null && _g !== void 0 ? _g : 0.8,
        };
        this.items.set(id, item);
        this.indexItem(item);
        this.dirty = true;
        await this.persist();
        return item;
    }
    async batchWrite(items) {
        var _a, _b, _c, _d, _e, _f, _g;
        const results = [];
        for (const item of items) {
            const now = new Date().toISOString();
            const id = `memory-${this.nextId++}`;
            const kindPriority = {
                DECISION: 80,
                ISSUE: 70,
                LESSON: 90,
                SUMMARY: 50,
            };
            let priority = (_b = (_a = item.priority) !== null && _a !== void 0 ? _a : kindPriority[item.kind]) !== null && _b !== void 0 ? _b : 50;
            if (item.missionId)
                priority += 5;
            if (item.agentId)
                priority += 5;
            if ((_c = item.evidenceRefs) === null || _c === void 0 ? void 0 : _c.length)
                priority += Math.min(item.evidenceRefs.length * 5, 15);
            priority = Math.min(priority, 100);
            const entry = {
                id,
                projectId: item.projectId,
                missionId: item.missionId,
                agentId: item.agentId,
                kind: item.kind,
                duration: (_d = item.duration) !== null && _d !== void 0 ? _d : 'EPISODIC',
                title: item.title,
                content: item.content,
                tags: (_e = item.tags) !== null && _e !== void 0 ? _e : [],
                priority,
                createdAt: now,
                lastAccessedAt: now,
                expiresAt: ((_f = item.duration) !== null && _f !== void 0 ? _f : 'EPISODIC') === 'EPISODIC'
                    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
                    : undefined,
                evidenceRefs: item.evidenceRefs,
                confidence: (_g = item.confidence) !== null && _g !== void 0 ? _g : 0.8,
            };
            this.items.set(id, entry);
            this.indexItem(entry);
            results.push(entry);
        }
        this.dirty = true;
        await this.persist();
        return results;
    }
    async update(options) {
        const item = this.items.get(options.id);
        if (!item || item.projectId !== options.projectId)
            return null;
        if (options.delete) {
            this.deindexItem(options.id);
            this.items.delete(options.id);
            this.dirty = true;
            await this.persist();
            return null;
        }
        if (options.updates) {
            this.deindexItem(options.id);
            Object.assign(item, options.updates);
            item.lastAccessedAt = new Date().toISOString();
            this.indexItem(item);
            this.dirty = true;
            await this.persist();
        }
        return item;
    }
    async delete(id, projectId) {
        const item = this.items.get(id);
        if (!item || item.projectId !== projectId)
            return false;
        this.deindexItem(id);
        this.items.delete(id);
        this.dirty = true;
        await this.persist();
        return true;
    }
    async deleteByMission(missionId, projectId) {
        let count = 0;
        for (const [id, item] of this.items) {
            if (item.projectId === projectId && item.missionId === missionId) {
                this.deindexItem(id);
                this.items.delete(id);
                count++;
            }
        }
        if (count > 0) {
            this.dirty = true;
            await this.persist();
        }
        return count;
    }
    async deleteExpired(projectId) {
        const now = new Date();
        let count = 0;
        for (const [id, item] of this.items) {
            if (item.projectId === projectId && item.expiresAt && new Date(item.expiresAt) < now) {
                this.deindexItem(id);
                this.items.delete(id);
                count++;
            }
        }
        if (count > 0) {
            this.dirty = true;
            await this.persist();
        }
        return count;
    }
    async read(id, projectId) {
        const item = this.items.get(id);
        if (!item || item.projectId !== projectId)
            return null;
        item.lastAccessedAt = new Date().toISOString();
        this.dirty = true;
        this.schedulePersist();
        return item;
    }
    schedulePersist() {
        if (this.persistTimer)
            return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.persist().catch((err) => {
                (0, logging_1.getGlobalLogger)().warn('JsonMemoryStore', 'Deferred persist failed', {
                    error: err === null || err === void 0 ? void 0 : err.message,
                });
            });
        }, 2000);
        this.persistTimer.unref();
    }
    async search(query) {
        var _a, _b;
        // Use BM25 scorer to narrow candidates for text query
        let candidateIds = null;
        if (query.query) {
            if (this.indexDirty)
                this.rebuildIndex();
            const bm25Results = this.bm25.score(query.query, this.items.size);
            candidateIds = new Set(bm25Results.map((r) => r.id));
        }
        // Single-pass filter: combine all conditions to avoid intermediate array allocations
        const lowerQuery = (_a = query.query) === null || _a === void 0 ? void 0 : _a.toLowerCase();
        const hasTags = query.tags && query.tags.length > 0;
        const results = [];
        for (const item of this.items.values()) {
            if (item.projectId !== query.projectId)
                continue;
            if (candidateIds && !candidateIds.has(item.id))
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
        const limit = (_b = query.limit) !== null && _b !== void 0 ? _b : 50;
        return { items: results.slice(0, limit), total, query };
    }
    /** Rebuild BM25 index from all items. Called lazily on first search. */
    rebuildIndex() {
        this.bm25 = new ftsScorer_1.BM25Scorer();
        this.tokenCache.clear();
        for (const [id, item] of this.items) {
            const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
            const fieldTexts = new Map();
            fieldTexts.set('title', item.title);
            this.bm25.addDocument(id, fullText, fieldTexts);
            this.tokenCache.set(id, (0, tokenizer_1.tokenize)(item.title + ' ' + item.content));
        }
        this.indexDirty = false;
    }
    /** Add a single item to the BM25 index. */
    indexItem(item) {
        const fullText = `${item.title} ${item.content} ${item.tags.join(' ')}`;
        const fieldTexts = new Map();
        fieldTexts.set('title', item.title);
        this.bm25.addDocument(item.id, fullText, fieldTexts);
        this.tokenCache.set(item.id, (0, tokenizer_1.tokenize)(item.title + ' ' + item.content));
    }
    /** Remove a single item from the BM25 index. */
    deindexItem(id) {
        this.bm25.removeDocument(id);
        this.tokenCache.delete(id);
    }
    async searchSemantic(query, projectId, limit = 10) {
        var _a;
        // Lazy rebuild index if dirty
        if (this.indexDirty)
            this.rebuildIndex();
        const projectItems = Array.from(this.items.values()).filter((item) => item.projectId === projectId);
        if (projectItems.length === 0)
            return [];
        // Use BM25 for high-quality full-text search
        const bm25Results = this.bm25.score(query, projectItems.length);
        const bm25ScoreMap = new Map(bm25Results.map((r) => [r.id, r.score]));
        // Score project items with BM25 + priority + confidence boost
        const scored = [];
        for (const item of projectItems) {
            const bm25Score = (_a = bm25ScoreMap.get(item.id)) !== null && _a !== void 0 ? _a : 0;
            // Combine BM25 score with priority and confidence
            // Formula: bm25 * (1 + priority/100) * (0.5 + confidence)
            const score = bm25Score * (1 + item.priority / 100) * (0.5 + item.confidence);
            if (score > 0) {
                scored.push({ item, score });
            }
        }
        // ISO string comparison — no Date parsing needed
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
        var _a;
        const projectItems = Array.from(this.items.values()).filter((item) => item.projectId === projectId);
        const byKind = { DECISION: 0, ISSUE: 0, LESSON: 0, SUMMARY: 0 };
        const byDuration = { EPISODIC: 0, LONG_TERM: 0 };
        const tagCounts = new Map();
        let totalPriority = 0, totalConfidence = 0;
        let oldestItem, newestItem;
        for (const item of projectItems) {
            byKind[item.kind]++;
            byDuration[item.duration]++;
            totalPriority += item.priority;
            totalConfidence += item.confidence;
            for (const tag of item.tags)
                tagCounts.set(tag, ((_a = tagCounts.get(tag)) !== null && _a !== void 0 ? _a : 0) + 1);
            if (!oldestItem || item.createdAt < oldestItem)
                oldestItem = item.createdAt;
            if (!newestItem || item.createdAt > newestItem)
                newestItem = item.createdAt;
        }
        return {
            totalItems: projectItems.length,
            byKind,
            byDuration,
            avgPriority: projectItems.length > 0 ? totalPriority / projectItems.length : 0,
            avgConfidence: projectItems.length > 0 ? totalConfidence / projectItems.length : 0,
            topTags: Array.from(tagCounts.entries())
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
            oldestItem,
            newestItem,
        };
    }
    async close() {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        await this.persist();
    }
}
exports.JsonMemoryStore = JsonMemoryStore;
const tokenizer_1 = require("./tokenizer");
