"use strict";
/**
 * Task Complexity Analyzer
 * Based on ULTIMATE-FRAMEWORK.md design
 *
 * Core insight: Task complexity determines optimal orchestration mode
 * - Low complexity → Sequential (single agent)
 * - Medium complexity → Parallel (independent subtasks)
 * - High complexity → Handoff (expert delegation)
 * - Open exploration → Magentic (adaptive planning)
 * - High risk → Consensus (multi-model voting)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchComplexityAnalyzer = exports.TaskComplexityAnalyzer = void 0;
// ========================================
// Complexity Analysis Engine
// ========================================
class TaskComplexityAnalyzer {
    constructor() {
        // Weights for each factor (based on research)
        this.WEIGHTS = {
            treewidth: 0.2,
            dependencyDepth: 0.15,
            inputSize: 0.1,
            outputComplexity: 0.15,
            domainKnowledge: 0.15,
            riskLevel: 0.1,
            uncertaintyLevel: 0.1,
            timeConstraints: 0.05,
        };
    }
    /**
     * Analyze task complexity
     */
    analyze(task) {
        const factors = this.extractFactors(task);
        const rawScore = this.calculateRawScore(factors);
        const level = this.scoreToLevel(rawScore);
        const recommendedMode = this.selectOrchestrationMode(level, factors);
        const tokenBudget = this.allocateTokenBudget(level, recommendedMode);
        const confidence = this.calculateConfidence(factors);
        return {
            level,
            score: rawScore,
            factors,
            recommendedMode,
            tokenBudget,
            confidence,
        };
    }
    /**
     * Extract complexity factors from task
     */
    extractFactors(task) {
        const desc = task.description.toLowerCase();
        const input = (task.input || '').toLowerCase();
        const combined = `${desc} ${input}`;
        return {
            // Dependency complexity
            treewidth: this.estimateTreewidth(combined),
            // Dependency depth
            dependencyDepth: this.estimateDependencyDepth(combined),
            // Input size (estimated tokens)
            inputSize: this.estimateTokenCount(task.input || task.description),
            // Output complexity
            outputComplexity: this.estimateOutputComplexity(combined),
            // Domain knowledge needed
            domainKnowledge: this.estimateDomainKnowledge(combined),
            // Risk level
            riskLevel: this.riskLevelToNumber(task.riskLevel || 'low'),
            // Uncertainty level
            uncertaintyLevel: this.estimateUncertainty(combined),
            // Time constraints
            timeConstraints: task.deadline ? this.estimateTimePressure(task.deadline) : 0,
        };
    }
    /**
     * Estimate treewidth (dependency complexity)
     * Higher = more interdependent subtasks
     */
    estimateTreewidth(text) {
        const dependencyIndicators = [
            'depends on',
            'requires',
            'after',
            'before',
            'then',
            'and then',
            'must',
            'sequence',
            'order',
            'step by step',
            'dependency',
            'prerequisite',
            'based on',
        ];
        let count = 0;
        dependencyIndicators.forEach((indicator) => {
            if (text.includes(indicator))
                count++;
        });
        // Also check for multiple clauses
        const clauses = (text.match(/[,;]/g) || []).length;
        return Math.min(100, count * 15 + clauses * 5);
    }
    /**
     * Estimate dependency depth
     * Higher = deeper chains of dependencies
     */
    estimateDependencyDepth(text) {
        const depthIndicators = [
            'then',
            'after that',
            'next',
            'subsequently',
            'once',
            'when',
            'finally',
            'last step',
        ];
        let depth = 0;
        depthIndicators.forEach((indicator) => {
            if (text.includes(indicator))
                depth++;
        });
        // Check for nested structure indicators
        const nestedPatterns = ['first', 'second', 'third', 'phase 1', 'phase 2', 'stage'];
        nestedPatterns.forEach((pattern) => {
            if (text.includes(pattern))
                depth += 2;
        });
        return Math.min(100, depth * 20);
    }
    /**
     * Estimate token count (approximate)
     */
    estimateTokenCount(text) {
        // Rough approximation: 1 token ≈ 4 characters
        return Math.ceil(text.length / 4);
    }
    /**
     * Estimate output complexity
     */
    estimateOutputComplexity(text) {
        const complexOutputIndicators = [
            'report',
            'analysis',
            'comparison',
            'review',
            'comprehensive',
            'detailed',
            'multi',
            'several',
            'all aspects',
            'thorough',
            'complete',
            'exhaustive',
        ];
        let score = 20; // Base complexity
        complexOutputIndicators.forEach((indicator) => {
            if (text.includes(indicator))
                score += 10;
        });
        return Math.min(100, score);
    }
    /**
     * Estimate domain knowledge needed
     */
    estimateDomainKnowledge(text) {
        const domainIndicators = [
            'technical',
            'specialized',
            'expert',
            'professional',
            'domain',
            'specific',
            'industry',
            'academic',
            'scientific',
            'legal',
            'medical',
            'financial',
            'engineering',
        ];
        let score = 10; // Base knowledge
        domainIndicators.forEach((indicator) => {
            if (text.includes(indicator))
                score += 15;
        });
        return Math.min(100, score);
    }
    /**
     * Estimate uncertainty level
     */
    estimateUncertainty(text) {
        const uncertaintyIndicators = [
            'might',
            'could',
            'possibly',
            'maybe',
            'explore',
            'investigate',
            'research',
            'find',
            'discover',
            'unknown',
            'unclear',
            'ambiguous',
            'open-ended',
        ];
        let score = 0;
        uncertaintyIndicators.forEach((indicator) => {
            if (text.includes(indicator))
                score += 12;
        });
        return Math.min(100, score);
    }
    /**
     * Estimate time pressure
     */
    estimateTimePressure(deadline) {
        const now = new Date();
        const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
        if (hoursUntilDeadline < 1)
            return 100;
        if (hoursUntilDeadline < 4)
            return 80;
        if (hoursUntilDeadline < 24)
            return 50;
        if (hoursUntilDeadline < 72)
            return 30;
        return 10;
    }
    /**
     * Risk level to number
     */
    riskLevelToNumber(level) {
        switch (level) {
            case 'critical':
                return 100;
            case 'high':
                return 75;
            case 'medium':
                return 50;
            case 'low':
                return 25;
        }
    }
    /**
     * Calculate raw complexity score (0-100)
     */
    calculateRawScore(factors) {
        let weightedSum = 0;
        weightedSum += factors.treewidth * this.WEIGHTS.treewidth;
        weightedSum += factors.dependencyDepth * this.WEIGHTS.dependencyDepth;
        weightedSum += Math.min(100, factors.inputSize / 10) * this.WEIGHTS.inputSize;
        weightedSum += factors.outputComplexity * this.WEIGHTS.outputComplexity;
        weightedSum += factors.domainKnowledge * this.WEIGHTS.domainKnowledge;
        weightedSum += factors.riskLevel * this.WEIGHTS.riskLevel;
        weightedSum += factors.uncertaintyLevel * this.WEIGHTS.uncertaintyLevel;
        weightedSum += factors.timeConstraints * this.WEIGHTS.timeConstraints;
        return Math.min(100, Math.max(0, weightedSum));
    }
    /**
     * Map score to complexity level
     */
    scoreToLevel(score) {
        if (score < 15)
            return 'trivial';
        if (score < 30)
            return 'simple';
        if (score < 50)
            return 'moderate';
        if (score < 75)
            return 'complex';
        return 'extreme';
    }
    /**
     * Select optimal orchestration mode
     */
    selectOrchestrationMode(level, factors) {
        // High risk → Consensus
        if (factors.riskLevel >= 75) {
            return 'CONSENSUS';
        }
        // High uncertainty → Magentic
        if (factors.uncertaintyLevel >= 60) {
            return 'MAGENTIC';
        }
        // High domain knowledge → Handoff
        if (factors.domainKnowledge >= 70) {
            return 'HANDOFF';
        }
        // Based on complexity level
        switch (level) {
            case 'trivial':
            case 'simple':
                return 'SEQUENTIAL';
            case 'moderate':
                return factors.treewidth < 30 ? 'PARALLEL' : 'SEQUENTIAL';
            case 'complex':
                return factors.dependencyDepth > 50 ? 'HANDOFF' : 'PARALLEL';
            case 'extreme':
                return 'MAGENTIC';
        }
    }
    /**
     * Allocate token budget based on complexity and mode
     */
    allocateTokenBudget(level, mode) {
        // Base budget allocation
        const baseBudget = {
            leadAgent: 40,
            specialistAgents: 40,
            evaluation: 15,
            overhead: 5,
            total: this.getBaseTotalBudget(level),
        };
        // Adjust based on mode
        switch (mode) {
            case 'SEQUENTIAL':
                // Single agent does most work
                return {
                    leadAgent: 70,
                    specialistAgents: 10,
                    evaluation: 15,
                    overhead: 5,
                    total: baseBudget.total,
                };
            case 'PARALLEL':
                // Specialists do most work
                return {
                    leadAgent: 30,
                    specialistAgents: 50,
                    evaluation: 15,
                    overhead: 5,
                    total: baseBudget.total * 1.5, // More tokens for coordination
                };
            case 'HANDOFF':
                // Expert agents
                return {
                    leadAgent: 35,
                    specialistAgents: 45,
                    evaluation: 15,
                    overhead: 5,
                    total: baseBudget.total * 1.3,
                };
            case 'MAGENTIC':
                // Adaptive, needs more overhead
                return {
                    leadAgent: 40,
                    specialistAgents: 35,
                    evaluation: 15,
                    overhead: 10,
                    total: baseBudget.total * 2,
                };
            case 'CONSENSUS':
                // Multiple models voting
                return {
                    leadAgent: 30,
                    specialistAgents: 30,
                    evaluation: 35, // More for voting
                    overhead: 5,
                    total: baseBudget.total * 1.5,
                };
        }
    }
    /**
     * Get base total budget based on complexity
     */
    getBaseTotalBudget(level) {
        switch (level) {
            case 'trivial':
                return 1000;
            case 'simple':
                return 3000;
            case 'moderate':
                return 10000;
            case 'complex':
                return 30000;
            case 'extreme':
                return 100000;
        }
    }
    /**
     * Calculate confidence in the analysis
     */
    calculateConfidence(factors) {
        // Higher confidence when factors are clear (not mid-range)
        const factorValues = Object.values(factors);
        let confidence = 1.0;
        // Reduce confidence for mid-range values (ambiguous)
        factorValues.forEach((value) => {
            if (value > 30 && value < 70) {
                confidence -= 0.05; // Mid-range reduces confidence
            }
        });
        return Math.max(0.5, Math.min(1.0, confidence));
    }
}
exports.TaskComplexityAnalyzer = TaskComplexityAnalyzer;
// ========================================
// Batch Analysis
// ========================================
class BatchComplexityAnalyzer {
    constructor() {
        this.analyzer = new TaskComplexityAnalyzer();
    }
    /**
     * Analyze multiple tasks
     */
    analyzeBatch(tasks) {
        return tasks.map((task) => this.analyzer.analyze(task));
    }
    /**
     * Get recommended orchestration for a batch
     */
    getBatchOrchestration(scores) {
        // Find highest complexity
        const maxScore = Math.max(...scores.map((s) => s.score));
        const maxLevel = scores.reduce((max, s) => (s.score > max.score ? s : max)).level;
        // If any task needs consensus, use consensus for all
        if (scores.some((s) => s.recommendedMode === 'CONSENSUS')) {
            return {
                mode: 'CONSENSUS',
                totalBudget: scores.reduce((sum, s) => sum + s.tokenBudget.total, 0),
                parallelGroups: 1,
            };
        }
        // If all are simple, can run in parallel
        if (scores.every((s) => s.level === 'trivial' || s.level === 'simple')) {
            return {
                mode: 'PARALLEL',
                totalBudget: scores.reduce((sum, s) => sum + s.tokenBudget.total, 0) * 0.8, // Parallel efficiency
                parallelGroups: scores.length,
            };
        }
        // Default: use highest complexity mode
        const maxMode = scores.reduce((max, s) => (s.score > max.score ? s : max)).recommendedMode;
        return {
            mode: maxMode,
            totalBudget: scores.reduce((sum, s) => sum + s.tokenBudget.total, 0),
            parallelGroups: maxMode === 'PARALLEL' ? scores.length : 1,
        };
    }
}
exports.BatchComplexityAnalyzer = BatchComplexityAnalyzer;
