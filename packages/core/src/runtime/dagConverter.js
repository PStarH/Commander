"use strict";
/**
 * DAG-to-TaskTree converter and topological sort utilities.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.dagToTaskTree = dagToTaskTree;
/**
 * Convert a WorkflowDAG to a TaskTreeNode hierarchy.
 */
function dagToTaskTree(dag) {
    if (dag.nodes.length === 0) {
        return {
            id: 'root',
            goal: 'empty',
            parentId: null,
            role: 'EXECUTOR',
            isAtomic: true,
            status: 'PENDING',
            subtasks: [],
            dependencies: [],
            context: {
                systemPrompt: '',
                availableTools: [],
                estimatedTokens: 0,
            },
        };
    }
    // Topological sort
    const topoOrder = topologicalSort(dag);
    const buildNode = (workflowNode, index) => ({
        id: workflowNode.id,
        parentId: null,
        goal: workflowNode.goal,
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'PENDING',
        subtasks: [],
        dependencies: dag.edges.filter((e) => e.to === workflowNode.id).map((e) => e.from),
        context: {
            systemPrompt: `You are a task executor for: ${workflowNode.goal}`,
            availableTools: workflowNode.tools,
            estimatedTokens: 1000,
        },
    });
    // Build tree structure
    const nodes = topoOrder.map((wn, i) => buildNode(wn, i));
    for (const node of nodes) {
        const children = dag.edges
            .filter((e) => e.from === node.id)
            .map((e) => nodes.find((n) => n.id === e.to))
            .filter(Boolean);
        node.subtasks = children;
    }
    // Return root
    const roots = nodes.filter((n) => !dag.edges.some((e) => e.to === n.id));
    if (roots.length === 1)
        return roots[0];
    // Multiple roots — create virtual root
    return {
        id: 'root',
        goal: dag.name,
        parentId: null,
        role: 'EXECUTOR',
        isAtomic: false,
        status: 'PENDING',
        subtasks: roots,
        dependencies: [],
        context: {
            systemPrompt: `Root orchestrator for: ${dag.name}`,
            availableTools: [],
            estimatedTokens: 1000,
        },
    };
}
/**
 * Topological sort of a DAG's nodes.
 */
function topologicalSort(dag) {
    const visited = new Set();
    const result = [];
    const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
    function visit(nodeId, stack) {
        if (visited.has(nodeId))
            return;
        if (stack.has(nodeId)) {
            const cyclePath = Array.from(stack).concat(nodeId);
            const named = cyclePath.map((id) => { var _a, _b; return (_b = (_a = nodeMap.get(id)) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : id; }).join(' → ');
            throw new Error(`dagConverter.topologicalSort: cyclic DAG detected (${named}). Workflow DAGs must be acyclic.`);
        }
        stack.add(nodeId);
        const outgoing = dag.edges.filter((e) => e.from === nodeId);
        for (const edge of outgoing) {
            visit(edge.to, stack);
        }
        stack.delete(nodeId);
        visited.add(nodeId);
        const node = nodeMap.get(nodeId);
        if (node)
            result.push(node);
    }
    for (const node of dag.nodes) {
        visit(node.id, new Set());
    }
    return result.reverse();
}
