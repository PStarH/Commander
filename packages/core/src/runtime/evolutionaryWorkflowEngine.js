"use strict";
/**
 * EvolutionaryWorkflowEngine — Workflow self-evolution engine.
 *
 * Core engine that manages workflow evolution using genetic algorithms.
 * Types and subcomponents are extracted to separate modules for maintainability.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvolutionaryWorkflowEngine = exports.dagToTaskTree = void 0;
exports.getEvolutionEngine = getEvolutionEngine;
exports.resetEvolutionEngine = resetEvolutionEngine;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const metaLearner_1 = require("../selfEvolution/metaLearner");
const reflectionEngine_1 = require("../reflectionEngine");
const logging_1 = require("../logging");
const evolutionaryWorkflowTypes_1 = require("./evolutionaryWorkflowTypes");
const workflowPopulation_1 = require("./workflowPopulation");
const dagConverter_1 = require("./dagConverter");
var dagConverter_2 = require("./dagConverter");
Object.defineProperty(exports, "dagToTaskTree", { enumerable: true, get: function () { return dagConverter_2.dagToTaskTree; } });
// ============================================================================
// Workflow evaluator (internal)
// ============================================================================
class WorkflowEvaluator {
    constructor(config = {}) {
        this.config = config;
    }
    evaluateFromHistory(dag, experiences) {
        var _a, _b, _c;
        const relevant = experiences.filter((e) => e.taskType === dag.taskType || dag.taskType === 'general');
        if (relevant.length === 0) {
            const nodeCount = dag.nodes.length;
            const avgModelCost = dag.nodes.reduce((sum, n) => {
                const tierCost = n.modelTier === 'eco' ? 1 : n.modelTier === 'standard' ? 3 : 10;
                return sum + tierCost;
            }, 0) / nodeCount;
            return {
                overall: Math.max(0, 1 - avgModelCost / 20 - (nodeCount - 2) * 0.05),
                quality: 0.5,
                cost: Math.max(0, 1 - avgModelCost / 15),
                speed: Math.max(0, 1 - nodeCount * 0.1),
                reliability: 0.5,
            };
        }
        const avgSuccessRate = relevant.reduce((sum, e) => sum + (e.success ? 1 : 0), 0) / relevant.length;
        const avgDuration = relevant.reduce((sum, e) => sum + e.durationMs, 0) / relevant.length;
        const avgTokenCost = relevant.reduce((sum, e) => sum + e.tokenCost, 0) / relevant.length;
        const qualityScore = avgSuccessRate;
        const costScore = Math.max(0, 1 - avgTokenCost / 100000);
        const speedScore = Math.max(0, 1 - avgDuration / 60000);
        const reliability = avgSuccessRate;
        const cw = (_a = this.config.costWeight) !== null && _a !== void 0 ? _a : 0.3;
        const qw = (_b = this.config.qualityWeight) !== null && _b !== void 0 ? _b : 0.4;
        const sw = (_c = this.config.speedWeight) !== null && _c !== void 0 ? _c : 0.15;
        const rw = 1 - cw - qw - sw;
        const overall = qw * qualityScore + cw * costScore + sw * speedScore + rw * reliability;
        return {
            overall: Math.min(1, Math.max(0, overall)),
            quality: qualityScore,
            cost: costScore,
            speed: speedScore,
            reliability,
        };
    }
}
// ============================================================================
// Main engine
// ============================================================================
class EvolutionaryWorkflowEngine {
    constructor(config) {
        this.config = { ...evolutionaryWorkflowTypes_1.DEFAULT_EVOLUTION_CONFIG, ...config };
        this.population = new workflowPopulation_1.WorkflowPopulation(this.config);
        this.evaluator = new WorkflowEvaluator();
    }
    saveToFile(filePath) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const data = {
            config: this.config,
            individuals: this.population['individualsAccessor'],
            generation: this.population['generationAccessor'],
            bestIndividual: this.population['bestIndividualAccessor'],
            fitnessHistory: this.population['fitnessHistory'],
        };
        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
    }
    loadFromFile(filePath) {
        try {
            if (!fs.existsSync(filePath))
                return false;
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.config)
                this.config = { ...this.config, ...data.config };
            if (data.individuals)
                this.population['individualsAccessor'] = data.individuals;
            if (data.generation !== undefined)
                this.population['generationAccessor'] = data.generation;
            if (data.bestIndividual)
                this.population['bestIndividualAccessor'] = data.bestIndividual;
            if (data.fitnessHistory)
                this.population['fitnessHistory'] = data.fitnessHistory;
            return true;
        }
        catch {
            (0, logging_1.getGlobalLogger)().warn('EvolutionaryWorkflowEngine', 'Failed to load population state', {
                filePath,
            });
            return false;
        }
    }
    async evolve(options) {
        var _a;
        const { taskType, availableTools, existingTree, maxDurationSeconds = 300 } = options;
        const startTime = Date.now();
        const workflowNodes = this.generateWorkflowNodes(taskType, availableTools);
        if (existingTree) {
            this.population.initializeFromTaskTree(taskType, existingTree, workflowNodes);
        }
        else {
            this.population.initialize(taskType, workflowNodes);
        }
        const maxGenerations = (_a = options.generations) !== null && _a !== void 0 ? _a : this.config.maxGenerations;
        const improvements = [];
        let previousBest = 0;
        for (let gen = 0; gen < maxGenerations; gen++) {
            if ((Date.now() - startTime) / 1000 > maxDurationSeconds) {
                improvements.push(`Timeout reached at generation ${gen}`);
                break;
            }
            let best;
            try {
                best = await this.population.evolve(async (dag) => {
                    return this.evaluateDAG(dag, availableTools, taskType);
                });
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().error('EvolutionaryWorkflowEngine', 'Population evolution iteration failed', err instanceof Error ? err : new Error(String(err)), { generation: gen });
                improvements.push(`Gen ${gen}: evolution error, using previous best`);
                const currentBest = this.population.getBest();
                if (!currentBest)
                    throw new Error('Evolution failed: no viable individuals');
                best = currentBest;
            }
            const stats = this.population.getStats();
            if (stats.bestFitness > previousBest + 0.01) {
                improvements.push(`Gen ${gen}: New best fitness ${stats.bestFitness.toFixed(3)} ` +
                    `(was ${previousBest.toFixed(3)})`);
                previousBest = stats.bestFitness;
            }
            if (stats.bestFitness >= this.config.minFitnessThreshold) {
                improvements.push(`Early termination at generation ${gen}: fitness target reached`);
                break;
            }
        }
        const finalBest = this.population.getBest();
        return {
            bestDag: finalBest,
            generations: this.population.getStats().generation,
            populationStats: this.collectPopulationHistory(),
            taskTree: (0, dagConverter_1.dagToTaskTree)(finalBest),
            improvements,
        };
    }
    async optimizeFromExperience(taskType, experiences) {
        const metaLearner = (0, metaLearner_1.getMetaLearner)();
        const reflections = (0, reflectionEngine_1.getGlobalReflectionEngine)();
        const taskExperiences = experiences.filter((e) => e.taskType === taskType);
        if (taskExperiences.length < 3)
            return null;
        const stats = metaLearner.getStrategyPerformance();
        const bestStrategy = Array.from(stats.values()).sort((a, b) => b.successRate - a.successRate)[0];
        if (!bestStrategy || bestStrategy.totalRuns < 5)
            return null;
        const engine = new EvolutionaryWorkflowEngine({
            ...this.config,
            populationSize: Math.min(8, this.config.populationSize),
            maxGenerations: Math.min(20, this.config.maxGenerations),
        });
        return engine.evolve({
            taskType,
            availableTools: this.extractToolsFromExperiences(taskExperiences),
            generations: 10,
        });
    }
    async evaluateDAG(dag, availableTools, taskType) {
        if (this.config.evaluationMethod === 'execution') {
            return this.evaluateByExecution(dag, availableTools);
        }
        return this.evaluateByHybrid(dag, availableTools, taskType);
    }
    async evaluateByHybrid(dag, availableTools, taskType) {
        var _a, _b;
        let score = 0.5;
        // O(n) edge counting: build adjacency counts, check for shared endpoints
        const endpointCounts = new Map();
        for (const e of dag.edges) {
            endpointCounts.set(e.from, ((_a = endpointCounts.get(e.from)) !== null && _a !== void 0 ? _a : 0) + 1);
            endpointCounts.set(e.to, ((_b = endpointCounts.get(e.to)) !== null && _b !== void 0 ? _b : 0) + 1);
        }
        const hasParallelism = dag.edges.some((e) => { var _a, _b; return ((_a = endpointCounts.get(e.from)) !== null && _a !== void 0 ? _a : 0) > 1 || ((_b = endpointCounts.get(e.to)) !== null && _b !== void 0 ? _b : 0) > 1; });
        if (hasParallelism)
            score += 0.1;
        const nodeCount = dag.nodes.length;
        if (nodeCount >= 2 && nodeCount <= 6)
            score += 0.15;
        const availableSet = new Set(availableTools);
        const usedTools = new Set(dag.nodes.flatMap((n) => n.tools));
        const validTools = usedTools.size > 0 && [...usedTools].every((t) => availableSet.has(t));
        if (validTools)
            score += 0.1;
        const tiers = new Set(dag.nodes.map((n) => n.modelTier));
        if (tiers.size > 1)
            score += 0.05;
        const metaLearner = (0, metaLearner_1.getMetaLearner)();
        const strategy = `${dag.taskType}_${dag.nodes.length}node`;
        const scores = metaLearner.getStrategyScores(strategy);
        if (scores.length > 0) {
            const bestScore = scores[0].score;
            score = score * 0.6 + bestScore * 0.4;
        }
        return Math.min(1, Math.max(0, score));
    }
    async evaluateByExecution(dag, availableTools) {
        let score = 0.5;
        const nodeCount = dag.nodes.length;
        if (nodeCount >= 2 && nodeCount <= 8)
            score += 0.2;
        const edgeRatio = dag.edges.length / Math.max(1, nodeCount);
        if (edgeRatio >= 0.5 && edgeRatio <= 2)
            score += 0.1;
        const availableSet = new Set(availableTools);
        const allToolsValid = dag.nodes.every((n) => n.tools.length === 0 || n.tools.every((t) => availableSet.has(t)));
        if (allToolsValid)
            score += 0.15;
        const tiers = new Set(dag.nodes.map((n) => n.modelTier));
        if (tiers.size >= 2)
            score += 0.05;
        let parallelNodes = 0;
        for (const n of dag.nodes) {
            if (n.parallelizable)
                parallelNodes++;
        }
        if (parallelNodes >= Math.ceil(nodeCount / 2))
            score += 0.1;
        return Math.min(1, Math.max(0, score));
    }
    generateWorkflowNodes(taskType, availableTools) {
        const nodes = [];
        nodes.push({
            id: `research-${taskType}`,
            type: 'agent',
            goal: `Research and gather information for the task`,
            tools: availableTools.filter((t) => t.includes('search') || t.includes('fetch')),
            modelTier: 'standard',
            parallelizable: true,
            timeoutMs: 30000,
            maxRetries: 2,
        });
        nodes.push({
            id: `analyze-${taskType}`,
            type: 'agent',
            goal: `Analyze gathered information and synthesize insights`,
            tools: availableTools.filter((t) => t.includes('memory') || t.includes('recall')),
            modelTier: 'power',
            parallelizable: false,
            timeoutMs: 60000,
            maxRetries: 2,
        });
        nodes.push({
            id: `execute-${taskType}`,
            type: 'agent',
            goal: `Execute the concrete actions based on analysis`,
            tools: availableTools.filter((t) => !t.includes('search') && !t.includes('fetch')),
            modelTier: 'standard',
            parallelizable: true,
            timeoutMs: 45000,
            maxRetries: 3,
        });
        nodes.push({
            id: `verify-${taskType}`,
            type: 'agent',
            goal: `Verify results and ensure quality`,
            tools: availableTools.slice(0, 3),
            modelTier: 'power',
            parallelizable: false,
            timeoutMs: 30000,
            maxRetries: 1,
        });
        return nodes;
    }
    extractToolsFromExperiences(experiences) {
        const tools = new Set();
        for (const exp of experiences) {
            if (exp.toolsUsed) {
                exp.toolsUsed.forEach((t) => tools.add(t));
            }
        }
        return [...tools];
    }
    collectPopulationHistory() {
        const stats = this.population.getStats();
        return stats.fitnessHistory.map((fitness, generation) => ({
            generation,
            bestFitness: fitness,
            avgFitness: 0,
        }));
    }
}
exports.EvolutionaryWorkflowEngine = EvolutionaryWorkflowEngine;
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let _evolutionConfig;
const evolutionEngineSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new EvolutionaryWorkflowEngine(_evolutionConfig));
function getEvolutionEngine(config) {
    if (config)
        _evolutionConfig = config;
    return evolutionEngineSingleton.get();
}
function resetEvolutionEngine() {
    evolutionEngineSingleton.reset();
}
