import type { TaskTreeNode } from './types';

export function countNodes(node: TaskTreeNode): number {
  let count = 1;
  for (const sub of node.subtasks) {
    count += countNodes(sub);
  }
  return count;
}

export function measureDepth(node: TaskTreeNode): number {
  if (node.subtasks.length === 0) return 0;
  let maxDepth = 0;
  for (const sub of node.subtasks) {
    maxDepth = Math.max(maxDepth, measureDepth(sub) + 1);
  }
  return maxDepth;
}

export function countCompleted(node: TaskTreeNode): number {
  let count = node.status === 'COMPLETED' ? 1 : 0;
  for (const sub of node.subtasks) {
    count += countCompleted(sub);
  }
  return count;
}

export function countFailed(node: TaskTreeNode): number {
  let count = node.status === 'FAILED' ? 1 : 0;
  for (const sub of node.subtasks) {
    count += countFailed(sub);
  }
  return count;
}

export function flattenTree(node: TaskTreeNode): TaskTreeNode[] {
  const nodes: TaskTreeNode[] = [node];
  for (const sub of node.subtasks) {
    nodes.push(...flattenTree(sub));
  }
  return nodes;
}

export function collectCompletedNodes(node: TaskTreeNode): TaskTreeNode[] {
  const completed: TaskTreeNode[] = [];
  if (node.status === 'COMPLETED' && node.result) {
    completed.push(node);
  }
  for (const sub of node.subtasks) {
    completed.push(...collectCompletedNodes(sub));
  }
  return completed;
}
