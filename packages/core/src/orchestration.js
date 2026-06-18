"use strict";
/**
 * Orchestration Types for Commander Multi-Agent System
 *
 * Based on Microsoft AI Agent Orchestration Patterns:
 * https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SequentialPipelineBuilder = void 0;
exports.calculateOrchestrationMetrics = calculateOrchestrationMetrics;
// ========================================
// Pipeline Builder Helper
// ========================================
/**
 * Builder for creating sequential pipelines.
 */
class SequentialPipelineBuilder {
    constructor(id, name, projectId) {
        this.pipeline = {
            id,
            name,
            projectId,
            steps: [],
            stopOnError: true,
        };
    }
    static create(id, name, projectId) {
        return new SequentialPipelineBuilder(id, name, projectId);
    }
    withDescription(description) {
        this.pipeline.description = description;
        return this;
    }
    withInitialInput(input) {
        this.pipeline.initialInput = input;
        return this;
    }
    withStopOnError(stop) {
        this.pipeline.stopOnError = stop;
        return this;
    }
    withGlobalTimeout(ms) {
        this.pipeline.globalTimeoutMs = ms;
        return this;
    }
    addStep(step) {
        this.pipeline.steps.push({
            ...step,
            id: `${this.pipeline.id}-step-${this.pipeline.steps.length + 1}`,
        });
        return this;
    }
    build() {
        const now = new Date().toISOString();
        return {
            ...this.pipeline,
            createdAt: now,
            updatedAt: now,
        };
    }
}
exports.SequentialPipelineBuilder = SequentialPipelineBuilder;
/**
 * Calculate metrics from a completed pipeline run.
 */
function calculateOrchestrationMetrics(run) {
    const completedSteps = run.results.filter((r) => r.status === 'SUCCESS').length;
    const failedSteps = run.results.filter((r) => r.status === 'FAILED').length;
    const skippedSteps = run.results.filter((r) => r.status === 'SKIPPED').length;
    const stepDurations = run.results
        .filter((r) => r.startedAt && r.completedAt)
        .map((r) => ({
        stepId: r.stepId,
        durationMs: new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime(),
    }));
    const totalDurationMs = run.completedAt
        ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
        : 0;
    const averageStepDurationMs = stepDurations.length > 0
        ? stepDurations.reduce((sum, d) => sum + d.durationMs, 0) / stepDurations.length
        : 0;
    const slowThreshold = averageStepDurationMs * 1.5;
    const slowSteps = stepDurations.filter((d) => d.durationMs > slowThreshold);
    const retriedSteps = run.results
        .filter((r) => r.retryCount && r.retryCount > 0)
        .map((r) => ({ stepId: r.stepId, retryCount: r.retryCount }));
    const totalTokenUsage = run.results.reduce((acc, r) => {
        if (!r.tokenUsage)
            return acc;
        return {
            promptTokens: acc.promptTokens + r.tokenUsage.promptTokens,
            completionTokens: acc.completionTokens + r.tokenUsage.completionTokens,
            totalTokens: acc.totalTokens + r.tokenUsage.totalTokens,
        };
    }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    return {
        pipelineId: run.pipelineId,
        runId: run.id,
        totalSteps: run.results.length,
        completedSteps,
        failedSteps,
        skippedSteps,
        totalDurationMs,
        averageStepDurationMs,
        totalTokenUsage,
        slowSteps,
        retriedSteps,
    };
}
