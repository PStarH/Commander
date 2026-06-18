import type { SagaGraph, SagaNode, SagaStepNode, SagaParallelNode, SagaNestedNode, SagaApprovalNode } from './types';
export declare class ExecutionGraph {
    private readonly graph;
    private readonly _nodes;
    private readonly _parent;
    private readonly _rootId;
    constructor(graph: SagaGraph);
    get name(): string;
    get size(): number;
    get rootId(): string;
    get nodes(): readonly SagaNode[];
    hasNode(id: string): boolean;
    getNode(id: string): SagaNode | undefined;
    requireNode(id: string): SagaNode;
    root(): SagaNode;
    isStep(id: string): boolean;
    isParallel(id: string): boolean;
    isNested(id: string): boolean;
    isApproval(id: string): boolean;
    parentOf(id: string): string | undefined;
    childrenOf(id: string): readonly SagaNode[];
    nextSiblingOf(id: string): SagaNode | undefined;
    previousSiblingOf(id: string): SagaNode | undefined;
    branchOf(id: string): {
        parallelId: string;
        index: number;
    } | undefined;
    private containsId;
    ancestorsOf(id: string): readonly SagaNode[];
    walk(visitor: (node: SagaNode, depth: number) => void): void;
    stepNodes(): readonly SagaStepNode[];
    approvalNodes(): readonly SagaApprovalNode[];
    nestedNodes(): readonly SagaNestedNode[];
    parallelNodes(): readonly SagaParallelNode[];
    private childrenOfNode;
    private buildIndex;
    private validate;
}
export declare class ExecutionGraphError extends Error {
    constructor(message: string);
}
export declare function isStepNode(node: SagaNode): node is SagaStepNode;
export declare function isParallelNode(node: SagaNode): node is SagaParallelNode;
export declare function isNestedNode(node: SagaNode): node is SagaNestedNode;
export declare function isApprovalNode(node: SagaNode): node is SagaApprovalNode;
//# sourceMappingURL=executionGraph.d.ts.map