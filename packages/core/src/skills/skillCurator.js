"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillCurator = void 0;
exports.jaccardSimilarity = jaccardSimilarity;
exports.nameSimilarity = nameSimilarity;
exports.descriptionSimilarity = descriptionSimilarity;
exports.tagSimilarity = tagSimilarity;
exports.computeSimilarity = computeSimilarity;
exports.findSimilarPairs = findSimilarPairs;
exports.buildMergePrompt = buildMergePrompt;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const logging_1 = require("../logging");
const DEFAULT_SIMILARITY_WEIGHTS = {
    nameWeight: 0.35,
    descWeight: 0.25,
    tagWeight: 0.4,
    threshold: 0.3,
};
// ============================================================================
// Similarity computation (pure functions, easy to test)
// ============================================================================
/**
 * Jaccard similarity of two string arrays.
 * Returns 0 if both are empty, otherwise |intersection| / |union|.
 */
function jaccardSimilarity(a, b) {
    if (a.length === 0 && b.length === 0)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const item of setA) {
        if (setB.has(item))
            intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
/**
 * Tokenize a string into lowercase word tokens.
 */
function tokenize(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1);
}
/**
 * Bigram set from a string.
 */
function bigrams(s) {
    const tokens = tokenize(s);
    const result = new Set();
    for (let i = 0; i < tokens.length - 1; i++) {
        result.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    // Also add individual tokens for short names
    for (const t of tokens) {
        result.add(t);
    }
    return result;
}
/**
 * Name similarity: Jaccard of bigrams.
 */
function nameSimilarity(a, b) {
    const bigramsA = bigrams(a);
    const bigramsB = bigrams(b);
    if (bigramsA.size === 0 && bigramsB.size === 0)
        return 0;
    let intersection = 0;
    for (const bg of bigramsA) {
        if (bigramsB.has(bg))
            intersection++;
    }
    const union = new Set([...bigramsA, ...bigramsB]).size;
    return union === 0 ? 0 : intersection / union;
}
/**
 * Description similarity: fraction of shared words (Jaccard on words).
 */
function descriptionSimilarity(a, b) {
    return jaccardSimilarity(tokenize(a), tokenize(b));
}
/**
 * Tag similarity: Jaccard on tag arrays.
 */
function tagSimilarity(a, b) {
    return jaccardSimilarity(a, b);
}
/**
 * Combined weighted similarity score between two catalog entries.
 */
function computeSimilarity(a, b, weights = DEFAULT_SIMILARITY_WEIGHTS) {
    const nameSim = nameSimilarity(a.name, b.name);
    const descSim = descriptionSimilarity(a.description, b.description);
    const tagSim = tagSimilarity(a.tags, b.tags);
    return nameSim * weights.nameWeight + descSim * weights.descWeight + tagSim * weights.tagWeight;
}
/**
 * Build similarity matrix for a list of entries (upper triangle).
 * Returns pairs with score >= threshold.
 */
function findSimilarPairs(entries, weights = DEFAULT_SIMILARITY_WEIGHTS) {
    const pairs = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const score = computeSimilarity(entries[i], entries[j], weights);
            if (score >= weights.threshold) {
                pairs.push([entries[i], entries[j], score]);
            }
        }
    }
    return pairs.sort((a, b) => b[2] - a[2]); // highest similarity first
}
/**
 * Build an LLM merge prompt for combining two similar skills.
 */
function buildMergePrompt(survivor, duplicate) {
    return [
        'You are merging two similar skills into one comprehensive skill.',
        'Keep the best parts of both, remove redundancy, and produce a single cohesive skill.',
        'Return ONLY the merged skill content as markdown. Do NOT include YAML frontmatter.',
        '',
        '--- Primary skill (keep its identity) ---',
        `Name: ${survivor.name}`,
        `Description: ${survivor.description}`,
        '',
        survivor.content,
        '',
        '--- Duplicate skill (merge useful parts from this) ---',
        `Name: ${duplicate.name}`,
        `Description: ${duplicate.description}`,
        '',
        duplicate.content,
    ].join('\n');
}
class SkillCurator {
    constructor(manager, archiveDir, backupDir) {
        this.QUALITY_THRESHOLD = 0.3;
        this.MIN_USAGE_THRESHOLD = 2;
        this.MAX_SKILLS = 200;
        this.STALE_AFTER_DAYS = 30;
        this.ARCHIVE_AFTER_DAYS = 90;
        this.mergeStrategy = 'keep_highest_quality';
        this.manager = manager;
        this.archiveDir = archiveDir !== null && archiveDir !== void 0 ? archiveDir : path.join(process.cwd(), '.commander', 'skills', '.archive');
        this.backupDir = backupDir !== null && backupDir !== void 0 ? backupDir : path.join(process.cwd(), '.commander', 'skills', '.backups');
    }
    /** Enable LLM-based merge for skill consolidation. */
    setLLMMerger(merger, strategy = 'llm_merge') {
        this.llmMerger = merger;
        this.mergeStrategy = strategy;
    }
    async curate() {
        const now = new Date().toISOString();
        const report = {
            archived: [],
            pruned: [],
            consolidated: [],
            qualityDropped: [],
            totalBefore: 0,
            totalAfter: 0,
            snapshotPath: undefined,
            runTimestamp: now,
            totalArchived: 0,
        };
        // Create pre-run snapshot
        try {
            report.snapshotPath = await this.createSnapshot();
        }
        catch {
            (0, logging_1.getGlobalLogger)().warn('SkillCurator', 'Snapshot creation failed (best-effort)');
        }
        const catalog = await this.manager.list();
        report.totalBefore = catalog.length;
        // Phase 1: Archive low-quality + low-usage skills instead of deleting
        for (const entry of catalog) {
            if (entry.pinned)
                continue;
            if (entry.qualityScore < this.QUALITY_THRESHOLD &&
                entry.usageCount < this.MIN_USAGE_THRESHOLD) {
                await this.archive(entry.name);
                report.archived.push(entry.name);
            }
        }
        // Phase 2: Consolidate similar skills using weighted similarity scoring
        const grouped = this.groupSimilar(catalog.filter((e) => !e.pinned));
        for (const group of grouped) {
            const result = await this.mergeSimilar(group, this.mergeStrategy, this.llmMerger);
            report.consolidated.push(...result.archived);
        }
        // Phase 3: Enforce max skills limit — archive lowest-usage
        const finalCatalog = await this.manager.list();
        report.totalAfter = finalCatalog.length;
        const unpinned = finalCatalog.filter((e) => !e.pinned);
        if (unpinned.length > this.MAX_SKILLS) {
            const toArchive = unpinned
                .sort((a, b) => a.usageCount - b.usageCount)
                .slice(0, unpinned.length - this.MAX_SKILLS);
            for (const entry of toArchive) {
                await this.archive(entry.name);
                report.archived.push(entry.name);
            }
            report.totalAfter = finalCatalog.length - toArchive.length;
        }
        report.totalArchived = report.archived.length;
        return report;
    }
    async archive(name) {
        try {
            const sourceDir = this.manager.getSkillPath(name);
            if (!fs.existsSync(sourceDir))
                return false;
            const destDir = path.join(this.archiveDir, name);
            if (!fs.existsSync(this.archiveDir)) {
                fs.mkdirSync(this.archiveDir, { recursive: true });
            }
            if (fs.existsSync(destDir)) {
                const ts = Date.now();
                fs.renameSync(sourceDir, `${destDir}.${ts}`);
            }
            else {
                fs.renameSync(sourceDir, destDir);
            }
            return true;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SkillCurator', `Failed to archive skill "${name}"`, {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
            return false;
        }
    }
    async restore(name) {
        try {
            const archivedPath = path.join(this.archiveDir, name);
            if (!fs.existsSync(archivedPath))
                return false;
            const destDir = this.manager.getSkillPath(name);
            if (fs.existsSync(destDir))
                return false;
            if (!fs.existsSync(path.dirname(destDir))) {
                fs.mkdirSync(path.dirname(destDir), { recursive: true });
            }
            fs.renameSync(archivedPath, destDir);
            return true;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SkillCurator', `Failed to restore skill "${name}"`, {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
            return false;
        }
    }
    async listArchived() {
        try {
            if (!fs.existsSync(this.archiveDir))
                return [];
            return fs.readdirSync(this.archiveDir).filter((f) => {
                const stat = fs.statSync(path.join(this.archiveDir, f));
                return stat.isDirectory();
            });
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SkillCurator', 'listArchived failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
            return [];
        }
    }
    async createSnapshot() {
        const skillsDir = path.resolve(path.join(process.cwd(), '.commander', 'skills'));
        if (!fs.existsSync(skillsDir))
            return '';
        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotPath = path.join(this.backupDir, `skills-${ts}.tar.gz`);
        const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
        const parentDir = path.dirname(skillsDir);
        const baseName = path.basename(skillsDir);
        try {
            await execFileAsync('tar', ['-czf', snapshotPath, '-C', parentDir, baseName], {
                timeout: 30000,
            });
        }
        catch {
            try {
                await execFileAsync('zip', ['-rq', snapshotPath, baseName], {
                    cwd: parentDir,
                    timeout: 30000,
                });
            }
            catch {
                (0, logging_1.getGlobalLogger)().warn('SkillCurator', 'Snapshot creation failed with both tar and zip');
                return '';
            }
        }
        this.rotateBackups();
        return snapshotPath;
    }
    rotateBackups() {
        try {
            if (!fs.existsSync(this.backupDir))
                return;
            const backups = fs
                .readdirSync(this.backupDir)
                .filter((f) => f.startsWith('skills-'))
                .sort()
                .reverse();
            if (backups.length > 5) {
                for (const old of backups.slice(5)) {
                    fs.rmSync(path.join(this.backupDir, old), { force: true });
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SkillCurator', 'rotateBackups failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    /**
     * Group similar entries using weighted similarity scoring.
     * Uses a greedy clustering approach: highest-similarity pairs are grouped first,
     * then the cluster expands to include any entry similar to any member.
     */
    groupSimilar(entries, weights = DEFAULT_SIMILARITY_WEIGHTS) {
        var _a;
        const pairs = findSimilarPairs(entries, weights);
        if (pairs.length === 0)
            return [];
        // Build adjacency from pairs
        const adjacency = new Map();
        const entryMap = new Map();
        for (const e of entries) {
            entryMap.set(e.name, e);
            adjacency.set(e.name, []);
        }
        for (const [a, b] of pairs) {
            adjacency.get(a.name).push(b);
            adjacency.get(b.name).push(a);
        }
        // Greedy clustering via BFS
        const visited = new Set();
        const groups = [];
        for (const entry of entries) {
            if (visited.has(entry.name))
                continue;
            const cluster = [];
            const queue = [entry];
            visited.add(entry.name);
            while (queue.length > 0) {
                const current = queue.shift();
                cluster.push(current);
                for (const neighbor of (_a = adjacency.get(current.name)) !== null && _a !== void 0 ? _a : []) {
                    if (!visited.has(neighbor.name)) {
                        visited.add(neighbor.name);
                        queue.push(neighbor);
                    }
                }
            }
            if (cluster.length > 1) {
                groups.push(cluster);
            }
        }
        return groups;
    }
    /**
     * Merge a group of similar skills using the configured strategy.
     * Default strategy: keep the highest-quality skill, archive the rest.
     * LLM merge strategy: use an LLM to merge content, keeping the best name.
     */
    async mergeSimilar(group, strategy = 'keep_highest_quality', llmMerger) {
        var _a, _b;
        if (group.length <= 1) {
            return { survivor: (_b = (_a = group[0]) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : '', archived: [] };
        }
        const sorted = [...group].sort((a, b) => b.qualityScore - a.qualityScore);
        const survivor = sorted[0];
        if (strategy === 'keep_highest_quality' || !llmMerger) {
            const toArchive = sorted.slice(1);
            for (const dup of toArchive) {
                await this.archive(dup.name);
            }
            return {
                survivor: survivor.name,
                archived: toArchive.map((e) => e.name),
            };
        }
        // LLM merge: try to merge content of the top-2 quality skills
        const primary = await this.manager.get(sorted[0].name);
        const secondary = await this.manager.get(sorted[1].name);
        if (!primary || !secondary) {
            // Fallback to keep-highest-quality
            const toArchive = sorted.slice(1);
            for (const dup of toArchive) {
                await this.archive(dup.name);
            }
            return {
                survivor: survivor.name,
                archived: toArchive.map((e) => e.name),
            };
        }
        const prompt = buildMergePrompt(primary, secondary);
        try {
            const mergedContent = await llmMerger(prompt);
            if (mergedContent) {
                await this.manager.update(survivor.name, { content: mergedContent });
            }
        }
        catch {
            // LLM merge failed — archive the secondary, keep primary
        }
        const toArchive = sorted.slice(1);
        for (const dup of toArchive) {
            await this.archive(dup.name);
        }
        return {
            survivor: survivor.name,
            archived: toArchive.map((e) => e.name),
        };
    }
}
exports.SkillCurator = SkillCurator;
