import type {
  SagaGraph,
  SagaNode,
  SagaStepNode,
  SagaParallelNode,
  SagaNestedNode,
  SagaApprovalNode,
} from './types';

const MAX_NODES = 10_000;

export class ExecutionGraph {
  private readonly _nodes: Map<string, SagaNode> = new Map();
  private readonly _parent: Map<string, string> = new Map();
  private readonly _rootId: string;

  constructor(private readonly graph: SagaGraph) {
    if (graph.nodes.length === 0) {
      throw new ExecutionGraphError('Saga has no nodes');
    }
    this._rootId = graph.rootId;
    this.buildIndex();
    this.validate();
  }

  get name(): string {
    return this.graph.name;
  }

  get size(): number {
    return this._nodes.size;
  }

  get rootId(): string {
    return this._rootId;
  }

  get nodes(): readonly SagaNode[] {
    return this.graph.nodes;
  }

  get timeoutMs(): number | undefined {
    return this.graph.timeoutMs;
  }

  hasNode(id: string): boolean {
    return this._nodes.has(id);
  }

  getNode(id: string): SagaNode | undefined {
    return this._nodes.get(id);
  }

  requireNode(id: string): SagaNode {
    const node = this._nodes.get(id);
    if (!node) {
      throw new ExecutionGraphError(`Node not found: ${id}`);
    }
    return node;
  }

  root(): SagaNode {
    return this.requireNode(this._rootId);
  }

  isStep(id: string): boolean {
    return this.requireNode(id).kind === 'step';
  }

  isParallel(id: string): boolean {
    return this.requireNode(id).kind === 'parallel';
  }

  isNested(id: string): boolean {
    return this.requireNode(id).kind === 'nested';
  }

  isApproval(id: string): boolean {
    return this.requireNode(id).kind === 'approval';
  }

  parentOf(id: string): string | undefined {
    return this._parent.get(id);
  }

  childrenOf(id: string): readonly SagaNode[] {
    return this.childrenOfNode(this.requireNode(id));
  }

  nextSiblingOf(id: string): SagaNode | undefined {
    const node = this._nodes.get(id);
    if (!node) return undefined;

    const parentId = this._parent.get(id);
    const siblings =
      parentId === undefined ? this.graph.nodes : this.childrenOfNode(this.requireNode(parentId));

    const selfIndex = siblings.findIndex((n) => n.id === id);
    if (selfIndex === -1 || selfIndex === siblings.length - 1) {
      return undefined;
    }
    return siblings[selfIndex + 1];
  }

  previousSiblingOf(id: string): SagaNode | undefined {
    const node = this._nodes.get(id);
    if (!node) return undefined;

    const parentId = this._parent.get(id);
    const siblings =
      parentId === undefined ? this.graph.nodes : this.childrenOfNode(this.requireNode(parentId));

    const selfIndex = siblings.findIndex((n) => n.id === id);
    if (selfIndex <= 0) return undefined;
    return siblings[selfIndex - 1];
  }

  branchOf(id: string): { parallelId: string; index: number } | undefined {
    let current = this._parent.get(id);
    while (current !== undefined) {
      const node = this._nodes.get(current);
      if (!node) return undefined;
      if (node.kind === 'parallel') {
        const index = (node as SagaParallelNode).branches.findIndex((b) => this.containsId(b, id));
        if (index === -1) return undefined;
        return { parallelId: current, index };
      }
      current = this._parent.get(current);
    }
    return undefined;
  }

  private containsId(node: SagaNode, id: string): boolean {
    if (node.id === id) return true;
    if (node.kind === 'parallel') {
      return node.branches.some((b) => this.containsId(b, id));
    }
    if (node.kind === 'nested') {
      return node.child.nodes.some((n) => this.containsId(n, id));
    }
    return false;
  }

  ancestorsOf(id: string): readonly SagaNode[] {
    const ancestors: SagaNode[] = [];
    let current = this._parent.get(id);
    while (current !== undefined) {
      const node = this._nodes.get(current);
      if (!node) break;
      ancestors.push(node);
      current = this._parent.get(current);
    }
    return ancestors;
  }

  walk(visitor: (node: SagaNode, depth: number) => void): void {
    const visit = (node: SagaNode, depth: number): void => {
      visitor(node, depth);
      for (const child of this.childrenOfNode(node)) {
        visit(child, depth + 1);
      }
    };
    for (const top of this.graph.nodes) {
      visit(top, 0);
    }
  }

  stepNodes(): readonly SagaStepNode[] {
    return Array.from(this._nodes.values()).filter((n): n is SagaStepNode => n.kind === 'step');
  }

  approvalNodes(): readonly SagaApprovalNode[] {
    return Array.from(this._nodes.values()).filter(
      (n): n is SagaApprovalNode => n.kind === 'approval',
    );
  }

  nestedNodes(): readonly SagaNestedNode[] {
    return Array.from(this._nodes.values()).filter((n): n is SagaNestedNode => n.kind === 'nested');
  }

  parallelNodes(): readonly SagaParallelNode[] {
    return Array.from(this._nodes.values()).filter(
      (n): n is SagaParallelNode => n.kind === 'parallel',
    );
  }

  private childrenOfNode(node: SagaNode): readonly SagaNode[] {
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

  private buildIndex(): void {
    const visit = (node: SagaNode, parentId: string | undefined): void => {
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

  private validate(): void {
    if (!this._nodes.has(this._rootId)) {
      throw new ExecutionGraphError(`Root node ${this._rootId} not found in nodes`);
    }

    const stack = new Set<string>();
    const checkCycle = (id: string): void => {
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

export class ExecutionGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionGraphError';
  }
}

export function isStepNode(node: SagaNode): node is SagaStepNode {
  return node.kind === 'step';
}

export function isParallelNode(node: SagaNode): node is SagaParallelNode {
  return node.kind === 'parallel';
}

export function isNestedNode(node: SagaNode): node is SagaNestedNode {
  return node.kind === 'nested';
}

export function isApprovalNode(node: SagaNode): node is SagaApprovalNode {
  return node.kind === 'approval';
}
