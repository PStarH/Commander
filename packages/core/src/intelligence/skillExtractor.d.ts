/**
 * Skill Extractor — Automatically extracts reusable skills from successful executions.
 *
 * Used internally by the agent to learn from successful patterns.
 * Users see: "已记住这个解决方案" — they don't call this directly.
 *
 * Analyzes execution traces and extracts patterns that can be reused.
 */
export interface ExtractedSkill {
    id: string;
    name: string;
    description: string;
    category: 'code' | 'config' | 'deploy' | 'debug' | 'test' | 'other';
    pattern: string;
    steps: string[];
    tools: string[];
    confidence: number;
    usageCount: number;
    successRate: number;
    lastUsed: string;
    createdAt: string;
    /** The runId of the execution that produced this skill */
    sourceRunId?: string;
    /** Whether this skill has decayed (stale/inactive) */
    decayed: boolean;
    /** When the skill was last decay-checked */
    decayedAt?: string;
    examples: Array<{
        task: string;
        result: string;
        tokens: number;
    }>;
}
export interface ExtractionResult {
    skills: ExtractedSkill[];
    summary: string;
}
export declare class SkillExtractor {
    private skills;
    private skillsPath;
    /** Timestamp of last purge to throttle decay checks */
    private lastPurgeMs;
    /** Minimum interval between decay checks (ms) */
    private static readonly PURGE_COOLDOWN_MS;
    constructor(baseDir?: string);
    private loadSkills;
    private saveSkills;
    /**
     * Extract skills from a successful execution.
     */
    extract(params: {
        task: string;
        taskType: string;
        steps: Array<{
            action: string;
            tool: string;
            result: string;
        }>;
        tokens: number;
        success: boolean;
        /** The runId that produced this skill */
        runId?: string;
    }): ExtractionResult;
    /**
     * Find matching skill for a task.
     */
    findMatchingSkill(task: string): ExtractedSkill | undefined;
    /**
     * Get all extracted skills.
     */
    getSkills(): ExtractedSkill[];
    /**
     * Get skills by category.
     */
    getSkillsByCategory(category: ExtractedSkill['category']): ExtractedSkill[];
    /**
     * Get all decayed/stale skills.
     */
    getDecayedSkills(): ExtractedSkill[];
    /**
     * Purge stale skills that haven't been used in DECAY_DAYS days.
     * Decays confidence gradually; skills below MIN_CONFIDENCE are removed.
     * Called on load and before each recall.
     */
    purgeStaleSkills(): {
        decayed: number;
        pruned: number;
    };
    /**
     * Record skill usage (success or failure).
     */
    recordUsage(skillId: string, success: boolean): void;
    private extractPattern;
    private inferCategory;
    private findSimilarSkill;
    private calculateSimilarity;
    private generateSkillName;
}
export declare function getSkillExtractor(): SkillExtractor;
//# sourceMappingURL=skillExtractor.d.ts.map