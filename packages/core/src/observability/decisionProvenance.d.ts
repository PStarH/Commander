import type { ExecutionTrace } from '../runtime/types';
import type { DecisionNode } from './types';
export declare function buildDecisions(trace: ExecutionTrace): DecisionNode[];
export declare function decisionsSummary(decisions: DecisionNode[]): {
    total: number;
    avgThinkMs: number;
    p95ThinkMs: number;
    byTool: Array<{
        tool: string;
        count: number;
        avgThinkMs: number;
    }>;
};
//# sourceMappingURL=decisionProvenance.d.ts.map