import type { Skill } from './types';
export declare class SkillStore {
    private readonly skillsDir;
    constructor(skillsDir?: string);
    private ensureDir;
    private skillDir;
    /** Public accessor for SkillCurator to get the skill directory path. */
    getSkillPath(name: string): string;
    private skillMdPath;
    save(skill: Skill): Promise<void>;
    load(name: string): Promise<Skill | null>;
    delete(name: string): Promise<boolean>;
    list(): Promise<string[]>;
    exists(name: string): Promise<boolean>;
    loadAll(): Promise<Skill[]>;
    /**
     * Migrate from old JSON skill format to new SKILL.md format.
     * Old format: .commander_skills/<name>.json or .commander/skills/<name>.json
     * Returns count of migrated skills.
     */
    migrateFromJson(): Promise<number>;
}
//# sourceMappingURL=skillStore.d.ts.map