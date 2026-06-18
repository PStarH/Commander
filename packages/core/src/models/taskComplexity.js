"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.measureTaskComplexity = measureTaskComplexity;
exports.shouldDecompose = shouldDecompose;
exports.getMissionDecompositionRecommendation = getMissionDecompositionRecommendation;
const DEFAULT_COMPLEXITY_OPTIONS = {
    maxDependencyDepth: 4,
    treewidthThreshold: 3,
    maxSubtasks: 5,
};
function buildDependencyGraph(task, allTasks) {
    const nodes = new Set([task.id]);
    const edges = [];
    for (const depId of task.dependencies) {
        nodes.add(depId);
        edges.push({ from: depId, to: task.id, weight: 1 });
    }
    for (const otherTask of allTasks) {
        if (task.dependencies.includes(otherTask.id) || otherTask.dependencies.includes(task.id)) {
            nodes.add(otherTask.id);
            for (const depId of otherTask.dependencies) {
                nodes.add(depId);
                edges.push({ from: depId, to: otherTask.id, weight: 1 });
            }
        }
    }
    return { nodes, edges };
}
function approximateTreewidth(graph) {
    var _a, _b;
    const degrees = new Map();
    for (const edge of graph.edges) {
        degrees.set(edge.from, ((_a = degrees.get(edge.from)) !== null && _a !== void 0 ? _a : 0) + 1);
        degrees.set(edge.to, ((_b = degrees.get(edge.to)) !== null && _b !== void 0 ? _b : 0) + 1);
    }
    let maxDegree = 0;
    for (const degree of degrees.values()) {
        maxDegree = Math.max(maxDegree, degree);
    }
    return Math.ceil(maxDegree / 2);
}
function calculateDependencyDepth(taskId, allTasks) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task || task.dependencies.length === 0) {
        return 0;
    }
    let maxDepth = 0;
    for (const depId of task.dependencies) {
        const depth = calculateDependencyDepth(depId, allTasks);
        maxDepth = Math.max(maxDepth, depth + 1);
    }
    return maxDepth;
}
function estimateSubtasks(task, graph) {
    const baseEstimate = Math.ceil(task.cognitiveLoad / 3);
    const dependencyFactor = Math.ceil(task.dependencies.length / 2);
    return Math.min(baseEstimate + dependencyFactor, graph.nodes.size);
}
function classifyComplexityLevel(treewidth, graphSize, dependencyDepth, opts) {
    const treewidthScore = treewidth * 2;
    const graphScore = graphSize > 10 ? 2 : graphSize > 5 ? 1 : 0;
    const depthScore = dependencyDepth > 3 ? 2 : dependencyDepth > 1 ? 1 : 0;
    const totalScore = treewidthScore + graphScore + depthScore;
    if (totalScore >= 6)
        return 'CRITICAL';
    if (totalScore >= 4)
        return 'HIGH';
    if (totalScore >= 2)
        return 'MEDIUM';
    return 'LOW';
}
/**
 * Measure task complexity based on dependency graph.
 */
function measureTaskComplexity(task, allTasks, options = {}) {
    const opts = { ...DEFAULT_COMPLEXITY_OPTIONS, ...options };
    const graph = buildDependencyGraph(task, allTasks);
    const treewidth = approximateTreewidth(graph);
    const dependencyDepth = calculateDependencyDepth(task.id, allTasks);
    const estimatedSubtasks = estimateSubtasks(task, graph);
    const graphSize = graph.nodes.size + graph.edges.length;
    const level = classifyComplexityLevel(treewidth, graphSize, dependencyDepth, opts);
    return {
        treewidth,
        graphSize,
        dependencyDepth,
        estimatedSubtasks,
        level,
    };
}
/**
 * Decision: Should this task be decomposed into subtasks?
 */
function shouldDecompose(complexity, options = {}) {
    const opts = { ...DEFAULT_COMPLEXITY_OPTIONS, ...options };
    if (complexity.level === 'CRITICAL') {
        return {
            decompose: true,
            reason: `Complexity level CRITICAL: treewidth=${complexity.treewidth}, depth=${complexity.dependencyDepth}`,
        };
    }
    if (complexity.treewidth > opts.treewidthThreshold) {
        return {
            decompose: true,
            reason: `Treewidth ${complexity.treewidth} exceeds threshold ${opts.treewidthThreshold}`,
        };
    }
    if (complexity.dependencyDepth > opts.maxDependencyDepth) {
        return {
            decompose: true,
            reason: `Dependency depth ${complexity.dependencyDepth} exceeds max ${opts.maxDependencyDepth}`,
        };
    }
    if (complexity.level === 'LOW') {
        return {
            decompose: false,
            reason: `Complexity level LOW: direct execution recommended`,
        };
    }
    if (complexity.level === 'MEDIUM') {
        const benefitRatio = complexity.estimatedSubtasks > 0 ? complexity.graphSize / complexity.estimatedSubtasks : 0;
        if (benefitRatio > 2) {
            return {
                decompose: true,
                reason: `Medium complexity with clear decomposition benefit (ratio: ${benefitRatio.toFixed(1)})`,
            };
        }
        return {
            decompose: false,
            reason: `Medium complexity but decomposition overhead exceeds benefit`,
        };
    }
    if (complexity.level === 'HIGH') {
        if (complexity.estimatedSubtasks > opts.maxSubtasks) {
            return {
                decompose: false,
                reason: `High complexity but ${complexity.estimatedSubtasks} subtasks risks overengineering (max: ${opts.maxSubtasks})`,
            };
        }
        return {
            decompose: true,
            reason: `High complexity: decomposition into ${complexity.estimatedSubtasks} subtasks recommended`,
        };
    }
    return {
        decompose: false,
        reason: 'Default: no decomposition',
    };
}
function estimateCognitiveLoad(mission) {
    let load = 3;
    if (mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL') {
        load += 3;
    }
    else if (mission.riskLevel === 'MEDIUM') {
        load += 1;
    }
    if (mission.governanceMode === 'MANUAL') {
        load += 2;
    }
    else if (mission.governanceMode === 'GUARDED') {
        load += 1;
    }
    if (mission.priority === 'CRITICAL') {
        load += 2;
    }
    else if (mission.priority === 'HIGH') {
        load += 1;
    }
    return Math.min(load, 10);
}
function extractDependencies(mission, context) {
    const dependencies = [];
    for (const blocked of context.slimSnapshot.missionBoard.blocked) {
        if (blocked.id !== mission.id) {
            dependencies.push(blocked.id);
        }
    }
    return dependencies;
}
function extractAllTasks(context) {
    const tasks = [];
    const allMissions = [
        ...context.slimSnapshot.missionBoard.running,
        ...context.slimSnapshot.missionBoard.blocked,
        ...context.slimSnapshot.missionBoard.planned,
    ];
    for (const mission of allMissions) {
        tasks.push({
            id: mission.id,
            inputCount: 1,
            outputCount: 1,
            cognitiveLoad: estimateCognitiveLoad(mission),
            requiresExternalResources: mission.governanceMode === 'MANUAL',
            dependencies: [],
        });
    }
    return tasks;
}
/**
 * Get decomposition recommendation for a mission based on current run context.
 */
function getMissionDecompositionRecommendation(mission, context) {
    const taskNode = {
        id: mission.id,
        inputCount: context.slimSnapshot.missionBoard.running.length +
            context.slimSnapshot.missionBoard.blocked.length,
        outputCount: 1,
        cognitiveLoad: estimateCognitiveLoad(mission),
        requiresExternalResources: mission.governanceMode === 'MANUAL',
        dependencies: extractDependencies(mission, context),
    };
    const allTasks = extractAllTasks(context);
    const complexity = measureTaskComplexity(taskNode, allTasks);
    const decision = shouldDecompose(complexity);
    return {
        decompose: decision.decompose,
        complexity,
        reason: decision.reason,
    };
}
