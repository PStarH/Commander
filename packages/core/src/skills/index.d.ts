/**
 * Skill System — agentskills.io compatible, MetaLearner-bridged.
 *
 * Each skill is a directory in .commander/skills/<name>/ containing SKILL.md
 * with YAML frontmatter (agentskills.io spec) and optional scripts/, references/.
 * Skills teach the agent how to use tools effectively.
 *
 * Three loading levels (progressive disclosure):
 *   Level 0: Skill names only (~3K tokens for full library)
 *   Level 1: Full SKILL.md content for relevant skills
 *   Level 2: Reference files on demand
 */
export type { SkillSource, SkillCategory, SkillMetadata, Skill, SkillFrontmatter, DisclosureLevel, SkillCatalogEntry, SkillSearchQuery, CuratorReport, SkillDef, } from './types';
export { SkillViewTool } from './skillViewTool';
export { SkillStore } from './skillStore';
export { SkillManager } from './skillManager';
export { MetaLearnerBridge } from './metaLearnerBridge';
export { SkillInjector } from './skillInjector';
export { SkillCurator, jaccardSimilarity, nameSimilarity, descriptionSimilarity, tagSimilarity, computeSimilarity, findSimilarPairs, buildMergePrompt, } from './skillCurator';
export type { SimilarityWeights, MergeStrategy, MergeResult } from './skillCurator';
export { computeQualityScore, computeDeterministicScore, evaluateWithRubric, buildRubricPrompt, } from './skillQualityScorer';
export type { QualityFactor, QualityScoreResult, LLMRubricConfig, RubricCriterion, } from './skillQualityScorer';
export { scanSkillContent, rejectReason } from './skillSecurityScanner';
export type { SecurityScanResult, SecurityWarning } from './skillSecurityScanner';
import { SkillManager } from './skillManager';
import { SkillInjector } from './skillInjector';
import { SkillCurator } from './skillCurator';
import type { SkillDef as LegacySkillDef } from './types';
import { MetaLearnerBridge } from './metaLearnerBridge';
/** Legacy: create a skill from explicit fields. */
export declare function createSkill(name: string, description: string, tools: string[], prompt: string): LegacySkillDef;
/** Legacy: load a single skill by name (JSON format fallback). */
export declare function loadSkill(name: string): LegacySkillDef | null;
/** Legacy: list all skills as SkillDef array. */
export declare function listSkills(): LegacySkillDef[];
/** Legacy: build system prompt from skills (Level 0 only). */
export declare function buildSkillsPrompt(maxLevel?: 0 | 1 | 2): string;
/** Legacy: record usage of a skill. */
export declare function recordSkillUsage(name: string): void;
/** Legacy: delete a skill. */
export declare function deleteSkill(name: string): boolean;
export interface SkillSystem {
    manager: SkillManager;
    injector: SkillInjector;
    curator: SkillCurator;
    bridge: MetaLearnerBridge;
}
export declare function createSkillSystem(): SkillSystem;
export declare function getSkillSystem(): SkillSystem;
export declare function resetSkillSystem(): void;
//# sourceMappingURL=index.d.ts.map