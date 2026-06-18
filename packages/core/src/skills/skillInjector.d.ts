import type { DisclosureLevel } from './types';
import type { SkillManager } from './skillManager';
export declare class SkillInjector {
    private manager;
    constructor(manager: SkillManager);
    buildSkillsBlock(goal: string, maxLevel?: DisclosureLevel): Promise<string>;
    buildSkillUsageInstructions(): string;
}
//# sourceMappingURL=skillInjector.d.ts.map