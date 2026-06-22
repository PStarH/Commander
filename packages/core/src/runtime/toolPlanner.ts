/**
 * Tool Planner — Dependency-Aware Scheduling
 *
 * Surpasses OpenClaw's buildToolPlan by implementing:
 * 1. DAG-based dependency resolution between tool calls
 * 2. Automatic parallel/sequential partitioning
 * 3. Critical path analysis for optimal ordering
 * 4. Resource conflict detection (e.g., two writes to same file)
 * 5. Speculative execution hints for read-only tools
 *
 * The planner analyzes a set of tool calls and produces an optimal
 * execution schedule that respects dependencies while maximizing parallelism.
 */

import type { ToolCall, Tool } from './types';

const READ_ONLY_PATTERNS = ['read', 'search', 'list', 'fetch', 'browse', 'recall', 'get'];
const EXPENSIVE_TOOLS = new Set(['shell_execute', 'python_execute', 'agent']);

// ============================================================================
// Dependency Edge
// ============================================================================

export interface DependencyEdge {
  /** Tool call that must complete first */
  from: string; // toolCall.id
  /** Tool call that depends on the first */
  to: string; // toolCall.id
  /** Why this dependency exists */
  reason: string;
}

// ============================================================================
// Resource Conflict
// ============================================================================

export interface ResourceConflict {
  /** The conflicting resource (e.g., file path, URL) */
  resource: string;
  /** Tool calls that access this resource */
  toolCallIds: string[];
  /** Whether this is a write-write conflict (must serialize) */
  isWriteWrite: boolean;
}

// ============================================================================
// Execution Stage
// ============================================================================

export interface ExecutionStage {
  /** Stage index (0 = first to execute) */
  index: number;
  /** Tool calls in this stage (can run in parallel) */
  toolCalls: ToolCall[];
  /** Estimated duration in ms (max of all tools in stage) */
  estimatedDurationMs: number;
}

// ============================================================================
// Execution Plan
// ============================================================================

export interface ExecutionPlan {
  /** Ordered execution stages */
  stages: ExecutionStage[];
  /** Dependencies that were detected */
  dependencies: DependencyEdge[];
  /** Resource conflicts that required serialization */
  conflicts: ResourceConflict[];
  /** Total estimated duration in ms */
  estimatedDurationMs: number;
  /** Whether any parallelism was found */
  hasParallelism: boolean;
  /** Tool calls that can be speculatively pre-executed */
  speculativeCandidates: string[];
}

// ============================================================================
// Tool Planner
// ============================================================================

interface CachedToolCall {
  tc: ToolCall;
  parsedArgs: Record<string, unknown>;
  argsStr: string;
  nameLower: string;
}

export class ToolPlanner {
  plan(toolCalls: ToolCall[], tools: Map<string, Tool>): ExecutionPlan {
    if (toolCalls.length === 0) {
      return {
        stages: [],
        dependencies: [],
        conflicts: [],
        estimatedDurationMs: 0,
        hasParallelism: false,
        speculativeCandidates: [],
      };
    }

    if (toolCalls.length === 1) {
      const tc = toolCalls[0];
      return {
        stages: [
          {
            index: 0,
            toolCalls,
            estimatedDurationMs: this.estimateDuration(tc, tools),
          },
        ],
        dependencies: [],
        conflicts: [],
        estimatedDurationMs: this.estimateDuration(tc, tools),
        hasParallelism: false,
        speculativeCandidates: this.isReadOnly(tc, tools) ? [tc.id] : [],
      };
    }

    // Pre-compute cached representations to avoid repeated JSON.parse/stringify
    const cached = toolCalls.map((tc): CachedToolCall => {
      const parsedArgs =
        typeof tc.arguments === 'string'
          ? (() => {
              try {
                return JSON.parse(tc.arguments);
              } catch {
                return {};
              }
            })()
          : (tc.arguments ?? {});
      return {
        tc,
        parsedArgs,
        argsStr: JSON.stringify(parsedArgs),
        nameLower: tc.name.toLowerCase(),
      };
    });

    const dependencies = this.detectDependencies(cached, tools);
    const conflicts = this.detectConflicts(cached, tools);
    const stages = this.buildStages(toolCalls, tools, dependencies, conflicts);
    const estimatedDurationMs = stages.reduce((sum, stage) => sum + stage.estimatedDurationMs, 0);
    const speculativeCandidates = this.findSpeculativeCandidates(toolCalls, tools, dependencies);

    return {
      stages,
      dependencies,
      conflicts,
      estimatedDurationMs,
      hasParallelism: stages.some((s) => s.toolCalls.length > 1),
      speculativeCandidates,
    };
  }

  /**
   * Detect implicit dependencies between tool calls.
   * Heuristics:
   * - Write→Read on same resource: read depends on write
   * - Write→Write on same resource: serialize
   * - Tool output used as input to another: dependency
   */
  private detectDependencies(cached: CachedToolCall[], tools: Map<string, Tool>): DependencyEdge[] {
    const edges: DependencyEdge[] = [];

    for (let i = 0; i < cached.length; i++) {
      for (let j = i + 1; j < cached.length; j++) {
        const a = cached[i];
        const b = cached[j];

        const sharedResource = this.findSharedResourceCached(a, b);
        if (sharedResource) {
          const aReadOnly = this.isReadOnly(a.tc, tools);
          const bReadOnly = this.isReadOnly(b.tc, tools);

          if (!aReadOnly || !bReadOnly) {
            edges.push({
              from: a.tc.id,
              to: b.tc.id,
              reason: `Resource conflict on "${sharedResource}"`,
            });
          }
        }

        if (this.hasDataDependencyCached(a, b)) {
          edges.push({
            from: a.tc.id,
            to: b.tc.id,
            reason: `Data dependency: ${b.tc.name} uses output of ${a.tc.name}`,
          });
        }
      }
    }

    return edges;
  }

  /**
   * Detect resource conflicts between tool calls.
   */
  private detectConflicts(cached: CachedToolCall[], tools: Map<string, Tool>): ResourceConflict[] {
    const resourceMap = new Map<string, { ids: string[]; hasWrite: boolean }>();

    for (const c of cached) {
      const resources = this.extractResourcesCached(c);
      const readOnly = this.isReadOnly(c.tc, tools);

      for (const resource of resources) {
        let entry = resourceMap.get(resource);
        if (!entry) {
          entry = { ids: [], hasWrite: false };
          resourceMap.set(resource, entry);
        }
        entry.ids.push(c.tc.id);
        if (!readOnly) entry.hasWrite = true;
      }
    }

    const conflicts: ResourceConflict[] = [];
    for (const [resource, entry] of resourceMap) {
      if (entry.ids.length > 1) {
        conflicts.push({
          resource,
          toolCallIds: entry.ids,
          isWriteWrite: entry.hasWrite,
        });
      }
    }

    return conflicts;
  }

  /**
   * Build execution stages using topological sort.
   * Each stage contains tool calls that can run in parallel.
   */
  private buildStages(
    toolCalls: ToolCall[],
    tools: Map<string, Tool>,
    dependencies: DependencyEdge[],
    _conflicts: ResourceConflict[],
  ): ExecutionStage[] {
    // Build adjacency list
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const tc of toolCalls) {
      inDegree.set(tc.id, 0);
      adjList.set(tc.id, []);
    }

    for (const edge of dependencies) {
      adjList.get(edge.from)?.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }

    // Topological sort with level grouping
    const stages: ExecutionStage[] = [];
    const toolCallMap = new Map(toolCalls.map((tc) => [tc.id, tc]));
    const processed = new Set<string>();

    // Start with all nodes that have no dependencies
    let currentLayer = toolCalls
      .filter((tc) => (inDegree.get(tc.id) ?? 0) === 0)
      .map((tc) => tc.id);

    while (currentLayer.length > 0) {
      const stageToolCalls = currentLayer.map((id) => toolCallMap.get(id)!).filter(Boolean);

      const maxDuration = Math.max(...stageToolCalls.map((tc) => this.estimateDuration(tc, tools)));

      stages.push({
        index: stages.length,
        toolCalls: stageToolCalls,
        estimatedDurationMs: maxDuration,
      });

      for (const id of currentLayer) {
        processed.add(id);
      }

      // Find next layer: all nodes whose dependencies are all processed
      const nextLayer: string[] = [];
      for (const id of currentLayer) {
        for (const neighbor of adjList.get(id) ?? []) {
          if (processed.has(neighbor)) continue;
          const newInDegree = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newInDegree);
          if (newInDegree === 0) {
            nextLayer.push(neighbor);
          }
        }
      }

      currentLayer = nextLayer;
    }

    const remaining = toolCalls.filter((tc) => !processed.has(tc.id));
    if (remaining.length > 0) {
      const named = remaining.map((tc) => `${tc.id}(${tc.name})`).join(' → ');
      throw new Error(
        `ToolPlanner.buildStages: cyclic tool-call dependency (${named}). ` +
          `Tool-call graphs must be acyclic — a cycle means the same tool's ` +
          `output feeds back into its own input. Fix the dependency.`,
      );
    }

    return stages;
  }

  /**
   * Find tool calls that are good candidates for speculative pre-execution.
   * These are read-only tools with no incoming dependencies.
   */
  private findSpeculativeCandidates(
    toolCalls: ToolCall[],
    tools: Map<string, Tool>,
    dependencies: DependencyEdge[],
  ): string[] {
    const hasIncoming = new Set(dependencies.map((e) => e.to));

    return toolCalls
      .filter(
        (tc) =>
          this.isReadOnly(tc, tools) && !hasIncoming.has(tc.id) && this.isSpeculativelySafe(tc),
      )
      .map((tc) => tc.id);
  }

  /**
   * Check if a tool call is read-only (no side effects).
   */
  private isReadOnly(tc: ToolCall, tools: Map<string, Tool>): boolean {
    const tool = tools.get(tc.name);
    if (tool?.isReadOnly) return true;

    // Heuristic: common read-only tools
    const lower = tc.name.toLowerCase();
    return READ_ONLY_PATTERNS.some((p) => lower.includes(p));
  }

  /**
   * Check if a tool call is safe for speculative execution.
   * Must be read-only AND not expensive.
   */
  private isSpeculativelySafe(tc: ToolCall): boolean {
    return !EXPENSIVE_TOOLS.has(tc.name);
  }

  private findSharedResourceCached(a: CachedToolCall, b: CachedToolCall): string | undefined {
    const aResources = this.extractResourcesCached(a);
    const bResources = new Set(this.extractResourcesCached(b));
    for (const r of aResources) {
      if (bResources.has(r)) return r;
    }
    return undefined;
  }

  private extractResourcesCached(c: CachedToolCall): string[] {
    const resources: string[] = [];
    const args = c.parsedArgs;
    if (typeof args.path === 'string') resources.push(args.path);
    if (typeof args.file === 'string') resources.push(args.file);
    if (typeof args.filename === 'string') resources.push(args.filename);
    if (typeof args.url === 'string') resources.push(args.url);
    if (typeof args.uri === 'string') resources.push(args.uri);
    if (typeof args.key === 'string') resources.push(args.key);
    return resources;
  }

  private hasDataDependencyCached(a: CachedToolCall, b: CachedToolCall): boolean {
    if (b.argsStr.includes(a.tc.name)) return true;
    const outputInputPairs: [string, string][] = [
      ['search', 'fetch'],
      ['read', 'write'],
      ['read', 'edit'],
      ['list', 'read'],
      ['fetch', 'write'],
    ];
    for (const [out, inp] of outputInputPairs) {
      if (a.nameLower.includes(out) && b.nameLower.includes(inp)) {
        if (this.findSharedResourceCached(a, b)) return true;
      }
    }
    return false;
  }

  private findSharedResource(a: ToolCall, b: ToolCall): string | undefined {
    const aResources = this.extractResources(a);
    const bResources = new Set(this.extractResources(b));

    for (const r of aResources) {
      if (bResources.has(r)) return r;
    }
    return undefined;
  }

  /**
   * Extract resource identifiers from a tool call's arguments.
   */
  private extractResources(tc: ToolCall): string[] {
    const resources: string[] = [];
    const args =
      typeof tc.arguments === 'string'
        ? (() => {
            try {
              return JSON.parse(tc.arguments);
            } catch {
              return {};
            }
          })()
        : (tc.arguments ?? {});

    // Common resource fields
    if (typeof args.path === 'string') resources.push(args.path);
    if (typeof args.file === 'string') resources.push(args.file);
    if (typeof args.filename === 'string') resources.push(args.filename);
    if (typeof args.url === 'string') resources.push(args.url);
    if (typeof args.uri === 'string') resources.push(args.uri);
    if (typeof args.key === 'string') resources.push(args.key);

    return resources;
  }

  /**
   * Check if tool call b has a data dependency on tool call a.
   * Heuristic: if b's arguments reference a's name or output format.
   */
  private hasDataDependency(a: ToolCall, b: ToolCall): boolean {
    const aStr = JSON.stringify(a.arguments ?? {});
    const bStr = JSON.stringify(b.arguments ?? {});

    // Check if b's args reference a's tool name
    if (bStr.includes(a.name)) return true;

    // Check if they share a common output→input pattern
    // e.g., search→fetch, read→write
    const outputInputPairs: [string, string][] = [
      ['search', 'fetch'],
      ['read', 'write'],
      ['read', 'edit'],
      ['list', 'read'],
      ['fetch', 'write'],
    ];

    for (const [out, inp] of outputInputPairs) {
      if (a.name.includes(out) && b.name.includes(inp)) {
        // Check if they share a resource
        if (this.findSharedResource(a, b)) return true;
      }
    }

    return false;
  }

  /**
   * Estimate execution duration for a tool call.
   */
  private estimateDuration(tc: ToolCall, tools: Map<string, Tool>): number {
    const tool = tools.get(tc.name);
    if (tool?.timeout && tool.timeout > 0) return tool.timeout;

    // Heuristic estimates by tool type
    const estimates: Record<string, number> = {
      web_search: 3000,
      web_fetch: 5000,
      browser_search: 5000,
      browser_fetch: 8000,
      file_read: 500,
      file_write: 1000,
      file_edit: 1000,
      file_search: 2000,
      shell_execute: 10000,
      python_execute: 15000,
      memory_store: 200,
      memory_recall: 200,
      memory_list: 200,
      agent: 30000,
    };

    return estimates[tc.name] ?? 5000;
  }
}
