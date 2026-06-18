import type { FusionReport } from './types';
import type { SwarmNode } from './types';
/**
 * FusionEngine — detects conflicts between parallel workers in the swarm tree.
 *
 * Detection strategies:
 * - file_overlap: same file path mentioned by two+ workers
 * - dependency_cycle: circular dependencies in the goal graph
 * - logical_contradiction: keyword-based contradiction detection
 * - resource_contention: shared resource access
 */
export declare class FusionEngine {
    /**
     * Scan a set of nodes for conflicts in their current outputs.
     */
    analyze(nodes: SwarmNode[], round: number): FusionReport;
    /**
     * Detect if two or more workers reference the same file path.
     */
    private detectFileOverlaps;
    /**
     * Detect cycles in the dependency graph between nodes.
     */
    private detectDependencyCycles;
    /**
     * Detect resource contention — workers claiming the same port, URL path, or resource.
     */
    private detectResourceContention;
}
//# sourceMappingURL=fusionEngine.d.ts.map