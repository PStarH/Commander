"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionGraphError = exports.ExecutionGraph = void 0;
exports.isStepNode = isStepNode;
exports.isParallelNode = isParallelNode;
exports.isNestedNode = isNestedNode;
exports.isApprovalNode = isApprovalNode;
const MAX_NODES = 10000;
class ExecutionGraph {
    constructor(graph) {
        this.graph = graph;
        this._nodes = new Map();
        this._parent = new Map();
        if (graph.nodes.length === 0) {
            throw new ExecutionGraphError('Saga has no nodes');
        }
        this._rootId = graph.rootId;
        this.buildIndex();
        this.validate();
    }
    get name() {
        return this.graph.name;
    }
    get size() {
        return this._nodes.size;
    }
    get rootId() {
        return this._rootId;
    }
    get nodes() {
        return this.graph.nodes;
    }
    hasNode(id) {
        return this._nodes.has(id);
    }
    getNode(id) {
        return this._nodes.get(id);
    }
    requireNode(id) {
        const node = this._nodes.get(id);
        if (!node) {
            throw new ExecutionGraphError(`Node not found: ${id}`);
        }
        return node;
    }
    root() {
        return this.requireNode(this._rootId);
    }
    isStep(id) {
        return this.requireNode(id).kind === 'step';
    }
    isParallel(id) {
        return this.requireNode(id).kind === 'parallel';
    }
    isNested(id) {
        return this.requireNode(id).kind === 'nested';
    }
    isApproval(id) {
        return this.requireNode(id).kind === 'approval';
    }
    parentOf(id) {
        return this._parent.get(id);
    }
    childrenOf(id) {
        return this.childrenOfNode(this.requireNode(id));
    }
    nextSiblingOf(id) {
        const node = this._nodes.get(id);
        if (!node)
            return undefined;
        const parentId = this._parent.get(id);
        const siblings = parentId === undefined ? this.graph.nodes : this.childrenOfNode(this.requireNode(parentId));
        const selfIndex = siblings.findIndex((n) => n.id === id);
        if (selfIndex === -1 || selfIndex === siblings.length - 1) {
            return undefined;
        }
        return siblings[selfIndex + 1];
    }
    previousSiblingOf(id) {
        const node = this._nodes.get(id);
        if (!node)
            return undefined;
        const parentId = this._parent.get(id);
        const siblings = parentId === undefined ? this.graph.nodes : this.childrenOfNode(this.requireNode(parentId));
        const selfIndex = siblings.findIndex((n) => n.id === id);
        if (selfIndex <= 0)
            return undefined;
        return siblings[selfIndex - 1];
    }
    branchOf(id) {
        let current = this._parent.get(id);
        while (current !== undefined) {
            const node = this._nodes.get(current);
            if (!node)
                return undefined;
            if (node.kind === 'parallel') {
                const index = node.branches.findIndex((b) => this.containsId(b, id));
                if (index === -1)
                    return undefined;
                return { parallelId: current, index };
            }
            current = this._parent.get(current);
        }
        return undefined;
    }
    containsId(node, id) {
        if (node.id === id)
            return true;
        if (node.kind === 'parallel') {
            return node.branches.some((b) => this.containsId(b, id));
        }
        if (node.kind === 'nested') {
            return node.child.nodes.some((n) => this.containsId(n, id));
        }
        return false;
    }
    ancestorsOf(id) {
        const ancestors = [];
        let current = this._parent.get(id);
        while (current !== undefined) {
            const node = this._nodes.get(current);
            if (!node)
                break;
            ancestors.push(node);
            current = this._parent.get(current);
        }
        return ancestors;
    }
    walk(visitor) {
        const visit = (node, depth) => {
            visitor(node, depth);
            for (const child of this.childrenOfNode(node)) {
                visit(child, depth + 1);
            }
        };
        for (const top of this.graph.nodes) {
            visit(top, 0);
        }
    }
    stepNodes() {
        return Array.from(this._nodes.values()).filter((n) => n.kind === 'step');
    }
    approvalNodes() {
        return Array.from(this._nodes.values()).filter((n) => n.kind === 'approval');
    }
    nestedNodes() {
        return Array.from(this._nodes.values()).filter((n) => n.kind === 'nested');
    }
    parallelNodes() {
        return Array.from(this._nodes.values()).filter((n) => n.kind === 'parallel');
    }
    childrenOfNode(node) {
        switch (node.kind) {
            case 'step':
            case 'approval':
                return [];
            case 'parallel':
                return node.branches;
            case 'nested':
                return node.child.nodes;
        }
    }
    buildIndex() {
        const visit = (node, parentId) => {
            if (this._nodes.size >= MAX_NODES) {
                throw new ExecutionGraphError(`Saga exceeds maximum node count: ${MAX_NODES}`);
            }
            if (this._nodes.has(node.id)) {
                throw new ExecutionGraphError(`Duplicate node id: ${node.id}`);
            }
            this._nodes.set(node.id, node);
            if (parentId !== undefined) {
                this._parent.set(node.id, parentId);
            }
            for (const child of this.childrenOfNode(node)) {
                visit(child, node.id);
            }
        };
        for (const top of this.graph.nodes) {
            visit(top, undefined);
        }
    }
    validate() {
        if (!this._nodes.has(this._rootId)) {
            throw new ExecutionGraphError(`Root node ${this._rootId} not found in nodes`);
        }
        const stack = new Set();
        const checkCycle = (id) => {
            if (stack.has(id)) {
                throw new ExecutionGraphError(`Cycle detected at node: ${id}`);
            }
            stack.add(id);
            for (const child of this.childrenOfNode(this.requireNode(id))) {
                checkCycle(child.id);
            }
            stack.delete(id);
        };
        checkCycle(this._rootId);
        for (const node of this._nodes.values()) {
            if (node.kind === 'nested' && node.child.nodes.length === 0) {
                throw new ExecutionGraphError(`Nested node ${node.id} has empty child graph`);
            }
        }
    }
}
exports.ExecutionGraph = ExecutionGraph;
class ExecutionGraphError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ExecutionGraphError';
    }
}
exports.ExecutionGraphError = ExecutionGraphError;
function isStepNode(node) {
    return node.kind === 'step';
}
function isParallelNode(node) {
    return node.kind === 'parallel';
}
function isNestedNode(node) {
    return node.kind === 'nested';
}
function isApprovalNode(node) {
    return node.kind === 'approval';
}
