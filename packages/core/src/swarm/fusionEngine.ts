import type { FusionConflict, FusionReport } from './types';
import type { SwarmNode } from './types';

const FILE_PATH_RE =
  /(?:\/|`)([\w./-]+\.(?:ts|js|tsx|jsx|py|go|rs|java|kt|css|scss|json|yaml|yml|toml|md|txt|html|css))(?::\d+)?(?:`)?/g;

/**
 * FusionEngine — detects conflicts between parallel workers in the swarm tree.
 *
 * Detection strategies:
 * - file_overlap: same file path mentioned by two+ workers
 * - dependency_cycle: circular dependencies in the goal graph
 * - logical_contradiction: keyword-based contradiction detection
 * - resource_contention: shared resource access
 */
export class FusionEngine {
  /**
   * Scan a set of nodes for conflicts in their current outputs.
   */
  analyze(nodes: SwarmNode[], round: number): FusionReport {
    const conflicts: FusionConflict[] = [];

    const fileConflicts = this.detectFileOverlaps(nodes);
    conflicts.push(...fileConflicts);

    const cycleConflicts = this.detectDependencyCycles(nodes);
    conflicts.push(...cycleConflicts);

    const resourceConflicts = this.detectResourceContention(nodes);
    conflicts.push(...resourceConflicts);

    return {
      round,
      conflicts,
      resolvedCount: 0,
      summary:
        conflicts.length > 0
          ? `Found ${conflicts.length} conflict(s): ${conflicts.map((c) => c.type).join(', ')}`
          : 'No conflicts detected',
    };
  }

  /**
   * Detect if two or more workers reference the same file path.
   */
  private detectFileOverlaps(nodes: SwarmNode[]): FusionConflict[] {
    const fileMap = new Map<string, string[]>();

    for (const node of nodes) {
      if (!node.workerOutput) continue;
      const matches = node.workerOutput.matchAll(FILE_PATH_RE);
      const seen = new Set<string>();
      for (const m of matches) {
        const path = m[1];
        if (!seen.has(path)) {
          seen.add(path);
          if (!fileMap.has(path)) fileMap.set(path, []);
          fileMap.get(path)!.push(node.id);
        }
      }
    }

    const conflicts: FusionConflict[] = [];
    for (const [filePath, nodeIds] of fileMap) {
      const uniqueIds = [...new Set(nodeIds)];
      if (uniqueIds.length >= 2) {
        conflicts.push({
          type: 'file_overlap',
          description: `Multiple workers touching the same file: ${filePath}`,
          severity: nodeIds.length >= 3 ? 'high' : 'medium',
          nodeIds: uniqueIds,
          suggestedResolution: `Consolidate changes to ${filePath} into a single worker or apply sequentially.`,
        });
      }
    }

    return conflicts;
  }

  /**
   * Detect cycles in the dependency graph between nodes.
   */
  private detectDependencyCycles(nodes: SwarmNode[]): FusionConflict[] {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cycles: string[][] = [];

    function dfs(nodeId: string, path: string[]): void {
      if (inStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart));
        }
        return;
      }
      if (visited.has(nodeId)) return;

      visited.add(nodeId);
      inStack.add(nodeId);
      path.push(nodeId);

      const node = nodeMap.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          dfs(depId, [...path]);
        }
      }

      inStack.delete(nodeId);
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, []);
      }
    }

    return cycles.map((cycle) => ({
      type: 'dependency_cycle' as const,
      description: `Circular dependency detected: ${cycle.join(' -> ')} -> ${cycle[0]}`,
      severity: 'critical' as const,
      nodeIds: cycle,
      suggestedResolution: 'Break the cycle by removing or reordering dependencies.',
    }));
  }

  /**
   * Detect resource contention — workers claiming the same port, URL path, or resource.
   */
  private detectResourceContention(nodes: SwarmNode[]): FusionConflict[] {
    const portMap = new Map<number, string[]>();
    const endpointMap = new Map<string, string[]>();

    for (const node of nodes) {
      if (!node.workerOutput) continue;

      const portMatches = node.workerOutput.matchAll(/port\s*(?::|=|number)\s*(\d{4,5})/gi);
      for (const m of portMatches) {
        const port = parseInt(m[1], 10);
        if (!portMap.has(port)) portMap.set(port, []);
        portMap.get(port)!.push(node.id);
      }

      const endpointMatches = node.workerOutput.matchAll(
        /["'](\/(?:api|v1|v2|graphql|webhook)\/[\w/-]+)["']/g,
      );
      for (const m of endpointMatches) {
        const ep = m[1];
        if (!endpointMap.has(ep)) endpointMap.set(ep, []);
        endpointMap.get(ep)!.push(node.id);
      }
    }

    const conflicts: FusionConflict[] = [];

    for (const [port, nodeIds] of portMap) {
      const uniqueIds = [...new Set(nodeIds)];
      if (uniqueIds.length >= 2) {
        conflicts.push({
          type: 'resource_contention',
          description: `Multiple workers claiming port ${port}`,
          severity: 'high',
          nodeIds: uniqueIds,
          suggestedResolution: `Assign unique ports to each worker or use a port allocation registry.`,
        });
      }
    }

    for (const [ep, nodeIds] of endpointMap) {
      const uniqueIds = [...new Set(nodeIds)];
      if (uniqueIds.length >= 2) {
        conflicts.push({
          type: 'resource_contention',
          description: `Multiple workers defining the same endpoint: ${ep}`,
          severity: 'medium',
          nodeIds: uniqueIds,
          suggestedResolution: `Merge endpoint definitions into a single worker.`,
        });
      }
    }

    return conflicts;
  }
}
