import type { CuratorReport, SkillCatalogEntry, Skill } from './types';
import type { SkillManager } from './skillManager';
export interface SimilarityWeights {
    nameWeight: number;
    descWeight: number;
    tagWeight: number;
    threshold: number;
}
export type MergeStrategy = 'keep_highest_quality' | 'llm_merge';
export interface MergeResult {
    survivor: string;
    archived: string[];
}
/**
 * Jaccard similarity of two string arrays.
 * Returns 0 if both are empty, otherwise |intersection| / |union|.
 */
export declare function jaccardSimilarity(a: string[], b: string[]): number;
/**
 * Name similarity: Jaccard of bigrams.
 */
export declare function nameSimilarity(a: string, b: string): number;
/**
 * Description similarity: fraction of shared words (Jaccard on words).
 */
export declare function descriptionSimilarity(a: string, b: string): number;
/**
 * Tag similarity: Jaccard on tag arrays.
 */
export declare function tagSimilarity(a: string[], b: string[]): number;
/**
 * Combined weighted similarity score between two catalog entries.
 */
export declare function computeSimilarity(a: SkillCatalogEntry, b: SkillCatalogEntry, weights?: SimilarityWeights): number;
/**
 * Build similarity matrix for a list of entries (upper triangle).
 * Returns pairs with score >= threshold.
 */
export declare function findSimilarPairs(entries: SkillCatalogEntry[], weights?: SimilarityWeights): Array<[SkillCatalogEntry, SkillCatalogEntry, number]>;
/**
 * Build an LLM merge prompt for combining two similar skills.
 */
export declare function buildMergePrompt(survivor: Skill, duplicate: Skill): string;
export declare class SkillCurator {
    private manager;
    private readonly QUALITY_THRESHOLD;
    private readonly MIN_USAGE_THRESHOLD;
    private readonly MAX_SKILLS;
    private readonly STALE_AFTER_DAYS;
    private readonly ARCHIVE_AFTER_DAYS;
    private readonly archiveDir;
    private readonly backupDir;
    private mergeStrategy;
    private llmMerger?;
    constructor(manager: SkillManager, archiveDir?: string, backupDir?: string);
    /** Enable LLM-based merge for skill consolidation. */
    setLLMMerger(merger: (prompt: string) => Promise<string | null>, strategy?: MergeStrategy): void;
    curate(): Promise<CuratorReport>;
    archive(name: string): Promise<boolean>;
    restore(name: string): Promise<boolean>;
    listArchived(): Promise<string[]>;
    private createSnapshot;
    private rotateBackups;
    /**
     * Group similar entries using weighted similarity scoring.
     * Uses a greedy clustering approach: highest-similarity pairs are grouped first,
     * then the cluster expands to include any entry similar to any member.
     */
    private groupSimilar;
    /**
     * Merge a group of similar skills using the configured strategy.
     * Default strategy: keep the highest-quality skill, archive the rest.
     * LLM merge strategy: use an LLM to merge content, keeping the best name.
     */
    mergeSimilar(group: SkillCatalogEntry[], strategy?: MergeStrategy, llmMerger?: (prompt: string) => Promise<string | null>): Promise<MergeResult>;
}
//# sourceMappingURL=skillCurator.d.ts.map