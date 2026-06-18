import type { Skill, SkillMetadata, SkillCatalogEntry, SkillSearchQuery, SkillCategory } from './types';
import { SkillStore } from './skillStore';
export declare class SkillManager {
    private store;
    private cache;
    private catalogCache;
    constructor(store: SkillStore);
    create(name: string, content: string, metadata: Partial<SkillMetadata>): Promise<Skill>;
    get(name: string): Promise<Skill | null>;
    update(name: string, updates: Partial<Skill>): Promise<Skill>;
    delete(name: string): Promise<boolean>;
    search(query: SkillSearchQuery): Promise<SkillCatalogEntry[]>;
    list(category?: SkillCategory): Promise<SkillCatalogEntry[]>;
    suggestForTask(goal: string, limit?: number): Promise<SkillCatalogEntry[]>;
    recordUsage(name: string, success: boolean): Promise<void>;
    setPinned(name: string, pinned: boolean): Promise<void>;
    isPinned(name: string): Promise<boolean>;
    /** Get the on-disk directory path for a skill (delegates to SkillStore). */
    getSkillPath(name: string): string;
    getCatalog(): Promise<SkillCatalogEntry[]>;
    exportSkill(name: string): Promise<string | null>;
    warmCache(): Promise<void>;
    invalidateCache(): void;
    private toCatalogEntry;
    private extractKeywords;
}
//# sourceMappingURL=skillManager.d.ts.map