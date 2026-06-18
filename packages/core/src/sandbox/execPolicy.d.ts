type PolicyDecision = 'allow' | 'prompt' | 'forbidden';
interface PolicyRule {
    id: string;
    pattern: string[];
    decision: PolicyDecision;
    justification?: string;
    priority?: number;
}
export declare class ExecPolicyEngine {
    private rules;
    private loadedFiles;
    constructor();
    private loadDefaultRules;
    private loadUserRules;
    private loadFile;
    private static readonly WRAPPER_PREFIXES;
    evaluate(command: string): {
        decision: PolicyDecision;
        rule?: PolicyRule;
        matchedPattern?: string;
    };
    private matchesPattern;
    private rawCommandMatches;
    private segmentMatches;
    private isShellPayloadPattern;
    private startsWithTokenBoundary;
    private extractCommandCandidates;
    private splitCommandSegments;
    private firstCommandToken;
    private tokenizeSegment;
    private commandNameAliases;
    /** Resolve symlinks for any command path (by path or by PATH lookup). */
    private resolveRealPath;
    private extractCommandSubstitutions;
    private hasCommandSubstitution;
    addRule(rule: Omit<PolicyRule, 'id'>): PolicyRule;
    removeRule(id: string): boolean;
    getRules(): PolicyRule[];
    persist(filepath?: string): void;
}
export {};
//# sourceMappingURL=execPolicy.d.ts.map