import type { Skill } from './types';
import type { SkillManager } from './skillManager';
import type { MetaLearner } from '../selfEvolution/metaLearner';
export declare class MetaLearnerBridge {
    private metaLearner;
    private skillManager;
    constructor(metaLearner: MetaLearner, skillManager: SkillManager);
    extractSkills(): Promise<Skill[]>;
    private generateSkillContent;
    private getThompsonPriors;
}
//# sourceMappingURL=metaLearnerBridge.d.ts.map