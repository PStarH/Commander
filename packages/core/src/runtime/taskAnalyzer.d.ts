import type { TaskType, ProvisionIntentScores } from './unifiedVerificationTypes';
export declare function detectTaskType(goal: string): TaskType;
export declare function classifyProvisionIntent(goal: string): {
    bestIntent: keyof ProvisionIntentScores | null;
    scores: ProvisionIntentScores;
};
//# sourceMappingURL=taskAnalyzer.d.ts.map