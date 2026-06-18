"use strict";
/**
 * Skill Extractor — Automatically extracts reusable skills from successful executions.
 *
 * Used internally by the agent to learn from successful patterns.
 * Users see: "已记住这个解决方案" — they don't call this directly.
 *
 * Analyzes execution traces and extracts patterns that can be reused.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillExtractor = void 0;
exports.getSkillExtractor = getSkillExtractor;
const logging_1 = require("../logging");
// ============================================================================
// Skill Decay Configuration
// ============================================================================
/** Days of inactivity before a skill starts decaying */
const DECAY_DAYS = 30;
/** Confidence below which a skill is auto-pruned */
const MIN_CONFIDENCE = 0.2;
/** Per-day confidence reduction after decay threshold */
const DECAY_RATE = 0.05;
// ============================================================================
// Skill Extractor
// ============================================================================
class SkillExtractor {
    constructor(baseDir) {
        this.skills = new Map();
        /** Timestamp of last purge to throttle decay checks */
        this.lastPurgeMs = 0;
        this.skillsPath = baseDir
            ? `${baseDir}/extracted-skills.json`
            : '.commander/intelligence/extracted-skills.json';
        this.loadSkills();
    }
    loadSkills() {
        try {
            const fs = require('fs');
            if (fs.existsSync(this.skillsPath)) {
                const data = JSON.parse(fs.readFileSync(this.skillsPath, 'utf-8'));
                for (const skill of data) {
                    // Default decayed to false for skills loaded from disk
                    if (skill.decayed === undefined)
                        skill.decayed = false;
                    this.skills.set(skill.id, skill);
                }
                // Run decay check on load
                this.purgeStaleSkills();
            }
        }
        catch {
            /* ignore */
        }
    }
    saveSkills() {
        try {
            const fs = require('fs');
            const path = require('path');
            fs.mkdirSync(path.dirname(this.skillsPath), { recursive: true });
            fs.writeFileSync(this.skillsPath, JSON.stringify(Array.from(this.skills.values()), null, 2));
        }
        catch {
            /* ignore */
        }
    }
    /**
     * Extract skills from a successful execution.
     */
    extract(params) {
        if (!params.success)
            return { skills: [], summary: 'Task failed, no skills extracted' };
        const extracted = [];
        // Extract pattern from task
        const pattern = this.extractPattern(params.task);
        const category = this.inferCategory(params.taskType, params.steps);
        // Check if similar skill already exists
        const existing = this.findSimilarSkill(pattern, category);
        if (existing) {
            // Update existing skill
            existing.usageCount++;
            existing.lastUsed = new Date().toISOString();
            existing.examples.push({
                task: params.task,
                result: 'success',
                tokens: params.tokens,
            });
            // Keep only last 10 examples
            if (existing.examples.length > 10) {
                existing.examples = existing.examples.slice(-10);
            }
            this.saveSkills();
            return { skills: [existing], summary: `Updated existing skill: ${existing.name}` };
        }
        // Extract steps
        const steps = params.steps.map((s) => `${s.action}: ${s.tool}`);
        const tools = [...new Set(params.steps.map((s) => s.tool))];
        // Create new skill
        const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const skill = {
            id,
            name: this.generateSkillName(params.task, category),
            description: `Auto-extracted from: ${params.task}`,
            category,
            pattern,
            steps,
            tools,
            confidence: 0.5, // Initial confidence
            usageCount: 1,
            successRate: 1.0,
            lastUsed: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            sourceRunId: params.runId,
            decayed: false,
            examples: [
                {
                    task: params.task,
                    result: 'success',
                    tokens: params.tokens,
                },
            ],
        };
        this.skills.set(id, skill);
        this.saveSkills();
        return {
            skills: [skill],
            summary: `Extracted new skill: ${skill.name}`,
        };
    }
    /**
     * Find matching skill for a task.
     */
    findMatchingSkill(task) {
        // Run decay check before recall
        this.purgeStaleSkills();
        const taskLower = task.toLowerCase();
        let bestMatch;
        let bestScore = 0;
        for (const skill of this.skills.values()) {
            const score = this.calculateSimilarity(taskLower, skill.pattern.toLowerCase());
            if (score > bestScore && score > 0.3) {
                bestScore = score;
                bestMatch = skill;
            }
        }
        return bestMatch;
    }
    /**
     * Get all extracted skills.
     */
    getSkills() {
        // Run decay check before listing
        this.purgeStaleSkills();
        return Array.from(this.skills.values()).sort((a, b) => b.usageCount - a.usageCount);
    }
    /**
     * Get skills by category.
     */
    getSkillsByCategory(category) {
        return Array.from(this.skills.values())
            .filter((s) => s.category === category)
            .sort((a, b) => b.usageCount - a.usageCount);
    }
    /**
     * Get all decayed/stale skills.
     */
    getDecayedSkills() {
        return Array.from(this.skills.values())
            .filter((s) => s.decayed)
            .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
    }
    /**
     * Purge stale skills that haven't been used in DECAY_DAYS days.
     * Decays confidence gradually; skills below MIN_CONFIDENCE are removed.
     * Called on load and before each recall.
     */
    purgeStaleSkills() {
        const now = Date.now();
        // Throttle: only run decay check once per PURGE_COOLDOWN_MS
        if (now - this.lastPurgeMs < SkillExtractor.PURGE_COOLDOWN_MS) {
            return { decayed: 0, pruned: 0 };
        }
        this.lastPurgeMs = now;
        const decayThreshold = DECAY_DAYS * 24 * 60 * 60 * 1000;
        let decayed = 0;
        let pruned = 0;
        for (const [id, skill] of this.skills) {
            const daysSinceLastUse = (now - new Date(skill.lastUsed).getTime()) / (24 * 60 * 60 * 1000);
            if (daysSinceLastUse > DECAY_DAYS) {
                // Decay confidence: each day past threshold reduces confidence by DECAY_RATE
                const extraDays = daysSinceLastUse - DECAY_DAYS;
                const decayAmount = extraDays * DECAY_RATE;
                skill.confidence = Math.max(MIN_CONFIDENCE, skill.confidence - decayAmount);
                skill.decayed = true;
                skill.decayedAt = new Date().toISOString();
                decayed++;
                // Auto-prune skills that dropped below minimum confidence
                if (skill.confidence <= MIN_CONFIDENCE) {
                    this.skills.delete(id);
                    pruned++;
                    (0, logging_1.getGlobalLogger)().info('SkillExtractor', `Pruned stale skill: ${skill.name}`, {
                        skillId: id,
                        daysSinceLastUse: Math.round(daysSinceLastUse),
                        confidence: skill.confidence,
                    });
                }
            }
        }
        if (decayed > 0 || pruned > 0) {
            this.saveSkills();
        }
        return { decayed, pruned };
    }
    /**
     * Record skill usage (success or failure).
     */
    recordUsage(skillId, success) {
        const skill = this.skills.get(skillId);
        if (!skill)
            return;
        skill.usageCount++;
        skill.lastUsed = new Date().toISOString();
        // Update success rate with exponential moving average
        const alpha = 0.1;
        skill.successRate = skill.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;
        // Update confidence based on usage and success rate
        skill.confidence = Math.min(1, 0.5 + skill.usageCount * 0.02 + skill.successRate * 0.3);
        this.saveSkills();
    }
    // --------------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------------
    extractPattern(task) {
        // Extract key action words
        const actionWords = [
            'create',
            'build',
            'fix',
            'deploy',
            'test',
            'refactor',
            'add',
            'update',
            'delete',
            'configure',
            'setup',
            'install',
        ];
        const words = task.toLowerCase().split(/\s+/);
        const actions = words.filter((w) => actionWords.includes(w));
        const nouns = words.filter((w) => w.length > 3 && !actionWords.includes(w));
        return [...actions, ...nouns].slice(0, 5).join(' ');
    }
    inferCategory(taskType, steps) {
        const tools = steps
            .map((s) => s.tool)
            .join(' ')
            .toLowerCase();
        const type = taskType.toLowerCase();
        if (type.includes('coding') || tools.includes('file_write') || tools.includes('apply_patch'))
            return 'code';
        if (type.includes('test') || tools.includes('test'))
            return 'test';
        if (type.includes('deploy') || tools.includes('deploy'))
            return 'deploy';
        if (type.includes('debug') || tools.includes('shell_execute'))
            return 'debug';
        if (type.includes('config'))
            return 'config';
        return 'other';
    }
    findSimilarSkill(pattern, category) {
        for (const skill of this.skills.values()) {
            if (skill.category !== category)
                continue;
            if (this.calculateSimilarity(pattern, skill.pattern) > 0.5) {
                return skill;
            }
        }
        return undefined;
    }
    calculateSimilarity(a, b) {
        const wordsA = new Set(a.split(/\s+/));
        const wordsB = new Set(b.split(/\s+/));
        const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        return union.size > 0 ? intersection.size / union.size : 0;
    }
    generateSkillName(task, category) {
        const words = task.split(/\s+/).slice(0, 4).join(' ');
        return `${category}: ${words}`;
    }
}
exports.SkillExtractor = SkillExtractor;
/** Minimum interval between decay checks (ms) */
SkillExtractor.PURGE_COOLDOWN_MS = 60000;
// ============================================================================
// Singleton
// ============================================================================
let defaultExtractor = null;
function getSkillExtractor() {
    if (!defaultExtractor) {
        defaultExtractor = new SkillExtractor();
    }
    return defaultExtractor;
}
