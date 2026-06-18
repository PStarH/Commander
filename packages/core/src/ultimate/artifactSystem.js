"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactSystem = void 0;
exports.getArtifactSystem = getArtifactSystem;
exports.resetArtifactSystem = resetArtifactSystem;
/** Maximum artifacts in the store before oldest are evicted */
const MAX_ARTIFACTS = 500;
/** Characters per token estimate for token counting */
const CHARS_PER_TOKEN = 3.7;
const ARTIFACT_STORE = new Map();
let artifactCounter = 0;
class ArtifactSystem {
    async write(agentId, type, title, summary, content, tags = [], externalUri) {
        const id = `artifact_${Date.now()}_${++artifactCounter}`;
        const tokenCount = this.estimateTokens(content);
        const artifact = {
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
                if (evicted >= evictCount)
                    break;
                ARTIFACT_STORE.delete(key);
                evicted++;
            }
        }
        return artifact;
    }
    async read(id) {
        const stored = ARTIFACT_STORE.get(id);
        if (!stored)
            return null;
        return {
            artifact: { ...stored.artifact },
            content: stored.content,
        };
    }
    async readContent(id) {
        const stored = ARTIFACT_STORE.get(id);
        if (!stored)
            return null;
        return stored.content;
    }
    async find(query, limit = 20) {
        const results = [];
        for (const { artifact, content } of ARTIFACT_STORE.values()) {
            if (limit > 0 && results.length >= limit)
                break;
            if (query.tags && !query.tags.some((t) => artifact.tags.includes(t)))
                continue;
            if (query.type && artifact.type !== query.type)
                continue;
            if (query.createdBy && artifact.createdBy !== query.createdBy)
                continue;
            if (query.since && artifact.createdAt < query.since)
                continue;
            // Text search: match against title, summary, and content
            if (query.textSearch) {
                const searchLower = query.textSearch.toLowerCase();
                const matchesTitle = artifact.title.toLowerCase().includes(searchLower);
                const matchesSummary = artifact.summary.toLowerCase().includes(searchLower);
                const matchesContent = content.toLowerCase().includes(searchLower);
                if (!matchesTitle && !matchesSummary && !matchesContent)
                    continue;
            }
            results.push({ ...artifact });
        }
        return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    /**
     * Search artifacts by text content with relevance scoring.
     * Returns results sorted by relevance (how many times the search term appears).
     */
    async search(query, options) {
        var _a;
        const limit = (_a = options === null || options === void 0 ? void 0 : options.limit) !== null && _a !== void 0 ? _a : 20;
        const queryLower = query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
        const scored = [];
        for (const { artifact, content } of ARTIFACT_STORE.values()) {
            if ((options === null || options === void 0 ? void 0 : options.type) && artifact.type !== options.type)
                continue;
            const contentLower = content.toLowerCase();
            let relevance = 0;
            // Count term occurrences
            for (const term of queryTerms) {
                const titleMatches = (artifact.title.toLowerCase().match(new RegExp(term, 'g')) || [])
                    .length;
                const summaryMatches = (artifact.summary.toLowerCase().match(new RegExp(term, 'g')) || [])
                    .length;
                const contentMatches = (contentLower.match(new RegExp(term, 'g')) || []).length;
                // Weight: title > summary > content
                relevance += titleMatches * 3 + summaryMatches * 2 + contentMatches;
            }
            if (relevance > 0) {
                scored.push({ artifact, relevance });
            }
        }
        return scored.sort((a, b) => b.relevance - a.relevance).slice(0, limit);
    }
    async delete(id) {
        return ARTIFACT_STORE.delete(id);
    }
    async getStats() {
        var _a, _b;
        let totalTokens = 0;
        const byType = {};
        const tagCounts = new Map();
        for (const { artifact } of ARTIFACT_STORE.values()) {
            totalTokens += artifact.tokenCount;
            byType[artifact.type] = ((_a = byType[artifact.type]) !== null && _a !== void 0 ? _a : 0) + 1;
            for (const tag of artifact.tags) {
                tagCounts.set(tag, ((_b = tagCounts.get(tag)) !== null && _b !== void 0 ? _b : 0) + 1);
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
    clear() {
        ARTIFACT_STORE.clear();
    }
    estimateTokens(text) {
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }
}
exports.ArtifactSystem = ArtifactSystem;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const artifactSystemSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ArtifactSystem());
function getArtifactSystem() {
    return artifactSystemSingleton.get();
}
function resetArtifactSystem() {
    artifactSystemSingleton.reset();
    ARTIFACT_STORE.clear();
}
