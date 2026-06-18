"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPlanner = void 0;
const READ_ONLY_PATTERNS = ['read', 'search', 'list', 'fetch', 'browse', 'recall', 'get'];
const EXPENSIVE_TOOLS = new Set(['shell_execute', 'python_execute', 'agent']);
// ============================================================================
// Tool Planner
// ============================================================================
class ToolPlanner {
    /**
     * Analyze a set of tool calls and produce an optimal execution plan.
     */
    plan(toolCalls, tools) {
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
            return {
                stages: [
                    {
                        index: 0,
                        toolCalls,
                        estimatedDurationMs: this.estimateDuration(toolCalls[0], tools),
                    },
                ],
                dependencies: [],
                conflicts: [],
                estimatedDurationMs: this.estimateDuration(toolCalls[0], tools),
                hasParallelism: false,
                speculativeCandidates: this.isReadOnly(toolCalls[0], tools) ? [toolCalls[0].id] : [],
            };
        }
        // Step 1: Detect dependencies
        const dependencies = this.detectDependencies(toolCalls, tools);
        // Step 2: Detect resource conflicts
        const conflicts = this.detectConflicts(toolCalls, tools);
        // Step 3: Build dependency graph and topological sort into stages
        const stages = this.buildStages(toolCalls, tools, dependencies, conflicts);
        // Step 4: Calculate critical path
        const estimatedDurationMs = stages.reduce((sum, stage) => sum + stage.estimatedDurationMs, 0);
        // Step 5: Identify speculative candidates (read-only, no dependencies)
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
    detectDependencies(toolCalls, tools) {
        const edges = [];
        for (let i = 0; i < toolCalls.length; i++) {
            for (let j = i + 1; j < toolCalls.length; j++) {
                const a = toolCalls[i];
                const b = toolCalls[j];
                // Same tool on same resource → serialize
                const sharedResource = this.findSharedResource(a, b);
                if (sharedResource) {
                    const aReadOnly = this.isReadOnly(a, tools);
                    const bReadOnly = this.isReadOnly(b, tools);
                    if (!aReadOnly || !bReadOnly) {
                        // At least one is a write → must serialize
                        edges.push({
                            from: a.id,
                            to: b.id,
                            reason: `Resource conflict on "${sharedResource}"`,
                        });
                    }
                }
                // Data dependency: if b's args reference a's tool name
                if (this.hasDataDependency(a, b)) {
                    edges.push({
                        from: a.id,
                        to: b.id,
                        reason: `Data dependency: ${b.name} uses output of ${a.name}`,
                    });
                }
            }
        }
        return edges;
    }
    /**
     * Detect resource conflicts between tool calls.
     */
    detectConflicts(toolCalls, tools) {
        const resourceMap = new Map();
        for (const tc of toolCalls) {
            const resources = this.extractResources(tc);
            const isReadOnly = this.isReadOnly(tc, tools);
            for (const resource of resources) {
                let entry = resourceMap.get(resource);
                if (!entry) {
                    entry = { ids: [], hasWrite: false };
                    resourceMap.set(resource, entry);
                }
                entry.ids.push(tc.id);
                if (!isReadOnly)
                    entry.hasWrite = true;
            }
        }
        const conflicts = [];
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
    buildStages(toolCalls, tools, dependencies, _conflicts) {
        var _a, _b, _c, _d;
        // Build adjacency list
        const inDegree = new Map();
        const adjList = new Map();
        for (const tc of toolCalls) {
            inDegree.set(tc.id, 0);
            adjList.set(tc.id, []);
        }
        for (const edge of dependencies) {
            (_a = adjList.get(edge.from)) === null || _a === void 0 ? void 0 : _a.push(edge.to);
            inDegree.set(edge.to, ((_b = inDegree.get(edge.to)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        // Topological sort with level grouping
        const stages = [];
        const toolCallMap = new Map(toolCalls.map((tc) => [tc.id, tc]));
        const processed = new Set();
        // Start with all nodes that have no dependencies
        let currentLayer = toolCalls
            .filter((tc) => { var _a; return ((_a = inDegree.get(tc.id)) !== null && _a !== void 0 ? _a : 0) === 0; })
            .map((tc) => tc.id);
        while (currentLayer.length > 0) {
            const stageToolCalls = currentLayer.map((id) => toolCallMap.get(id)).filter(Boolean);
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
            const nextLayer = [];
            for (const id of currentLayer) {
                for (const neighbor of (_c = adjList.get(id)) !== null && _c !== void 0 ? _c : []) {
                    if (processed.has(neighbor))
                        continue;
                    const newInDegree = ((_d = inDegree.get(neighbor)) !== null && _d !== void 0 ? _d : 1) - 1;
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
            throw new Error(`ToolPlanner.buildStages: cyclic tool-call dependency (${named}). ` +
                `Tool-call graphs must be acyclic — a cycle means the same tool's ` +
                `output feeds back into its own input. Fix the dependency.`);
        }
        return stages;
    }
    /**
     * Find tool calls that are good candidates for speculative pre-execution.
     * These are read-only tools with no incoming dependencies.
     */
    findSpeculativeCandidates(toolCalls, tools, dependencies) {
        const hasIncoming = new Set(dependencies.map((e) => e.to));
        return toolCalls
            .filter((tc) => this.isReadOnly(tc, tools) && !hasIncoming.has(tc.id) && this.isSpeculativelySafe(tc))
            .map((tc) => tc.id);
    }
    /**
     * Check if a tool call is read-only (no side effects).
     */
    isReadOnly(tc, tools) {
        const tool = tools.get(tc.name);
        if (tool === null || tool === void 0 ? void 0 : tool.isReadOnly)
            return true;
        // Heuristic: common read-only tools
        const lower = tc.name.toLowerCase();
        return READ_ONLY_PATTERNS.some((p) => lower.includes(p));
    }
    /**
     * Check if a tool call is safe for speculative execution.
     * Must be read-only AND not expensive.
     */
    isSpeculativelySafe(tc) {
        return !EXPENSIVE_TOOLS.has(tc.name);
    }
    /**
     * Find a shared resource between two tool calls.
     */
    findSharedResource(a, b) {
        const aResources = this.extractResources(a);
        const bResources = new Set(this.extractResources(b));
        for (const r of aResources) {
            if (bResources.has(r))
                return r;
        }
        return undefined;
    }
    /**
     * Extract resource identifiers from a tool call's arguments.
     */
    extractResources(tc) {
        var _a;
        const resources = [];
        const args = typeof tc.arguments === 'string'
            ? (() => {
                try {
                    return JSON.parse(tc.arguments);
                }
                catch {
                    return {};
                }
            })()
            : ((_a = tc.arguments) !== null && _a !== void 0 ? _a : {});
        // Common resource fields
        if (typeof args.path === 'string')
            resources.push(args.path);
        if (typeof args.file === 'string')
            resources.push(args.file);
        if (typeof args.filename === 'string')
            resources.push(args.filename);
        if (typeof args.url === 'string')
            resources.push(args.url);
        if (typeof args.uri === 'string')
            resources.push(args.uri);
        if (typeof args.key === 'string')
            resources.push(args.key);
        return resources;
    }
    /**
     * Check if tool call b has a data dependency on tool call a.
     * Heuristic: if b's arguments reference a's name or output format.
     */
    hasDataDependency(a, b) {
        var _a, _b;
        const aStr = JSON.stringify((_a = a.arguments) !== null && _a !== void 0 ? _a : {});
        const bStr = JSON.stringify((_b = b.arguments) !== null && _b !== void 0 ? _b : {});
        // Check if b's args reference a's tool name
        if (bStr.includes(a.name))
            return true;
        // Check if they share a common output→input pattern
        // e.g., search→fetch, read→write
        const outputInputPairs = [
            ['search', 'fetch'],
            ['read', 'write'],
            ['read', 'edit'],
            ['list', 'read'],
            ['fetch', 'write'],
        ];
        for (const [out, inp] of outputInputPairs) {
            if (a.name.includes(out) && b.name.includes(inp)) {
                // Check if they share a resource
                if (this.findSharedResource(a, b))
                    return true;
            }
        }
        return false;
    }
    /**
     * Estimate execution duration for a tool call.
     */
    estimateDuration(tc, tools) {
        var _a;
        const tool = tools.get(tc.name);
        if ((tool === null || tool === void 0 ? void 0 : tool.timeout) && tool.timeout > 0)
            return tool.timeout;
        // Heuristic estimates by tool type
        const estimates = {
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
        return (_a = estimates[tc.name]) !== null && _a !== void 0 ? _a : 5000;
    }
}
exports.ToolPlanner = ToolPlanner;
