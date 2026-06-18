"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepErrorBoundary = void 0;
const llmRetry_1 = require("./llmRetry");
const DEFAULT_CONFIG = {
    maxRetries: 2,
    retryDelayMs: 1000,
    onExhausted: 'skip',
    onPermanent: 'abort',
};
class StepErrorBoundary {
    constructor(runId, agentId, dlq, missionId, config, reflexionGenerator) {
        this.runId = runId;
        this.agentId = agentId;
        this.missionId = missionId;
        this.dlq = dlq;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.reflexionGenerator = reflexionGenerator;
    }
    async execute(operationName, category, fn, options) {
        var _a, _b, _c, _d;
        let lastError = '';
        let lastErrorClass = 'unknown';
        let attempts = 0;
        const reflexionHistory = [];
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            attempts++;
            try {
                const value = await fn();
                return { success: true, value, errorClass: 'transient', attempts, recovered: attempt > 0 };
            }
            catch (err) {
                const classified = (0, llmRetry_1.classifyLLMError)(err);
                lastError = classified.message;
                lastErrorClass = classified.errorClass;
                this.recordToDLQ(operationName, category, lastError, lastErrorClass, classified.retryable, attempt, options);
                if (!classified.retryable) {
                    const strategy = this.config.onPermanent;
                    if (strategy === 'abort') {
                        return {
                            success: false,
                            error: lastError,
                            errorClass: lastErrorClass,
                            attempts,
                            recovered: false,
                        };
                    }
                    if (strategy === 'skip') {
                        (_a = options === null || options === void 0 ? void 0 : options.onSkip) === null || _a === void 0 ? void 0 : _a.call(options, lastError);
                        return {
                            success: false,
                            error: lastError,
                            errorClass: lastErrorClass,
                            attempts,
                            recovered: false,
                        };
                    }
                    if (strategy === 'fallback') {
                        return {
                            success: false,
                            error: lastError,
                            errorClass: lastErrorClass,
                            attempts,
                            recovered: false,
                        };
                    }
                }
                if (attempt < this.config.maxRetries) {
                    (_b = options === null || options === void 0 ? void 0 : options.onRetry) === null || _b === void 0 ? void 0 : _b.call(options, attempt, lastError);
                    // Best-effort: generate a structured reflexion before the backoff
                    // so the next attempt can receive a graded failure cause. The
                    // generator may run an LLM call; any failure is swallowed because
                    // reflexion is advisory and must not break the retry path.
                    if (this.reflexionGenerator && (options === null || options === void 0 ? void 0 : options.onReflexion)) {
                        try {
                            const reflexionCtx = {
                                goal: '',
                                attemptedAction: operationName,
                                actionResult: '',
                                error: lastError,
                                errorClass: lastErrorClass,
                                attemptNumber: attempts + 1,
                                previousReflexions: [...reflexionHistory],
                            };
                            const reflexion = await this.reflexionGenerator.generate(reflexionCtx);
                            reflexionHistory.push(reflexion);
                            await options.onReflexion(reflexion, reflexionCtx);
                        }
                        catch {
                            // Reflexion is best-effort: never let a generator failure
                            // block the retry path.
                        }
                    }
                    const delayMs = (_c = classified.retryAfter) !== null && _c !== void 0 ? _c : (0, llmRetry_1.computeBackoff)(attempt, this.config.retryDelayMs);
                    await new Promise((r) => {
                        const t = setTimeout(r, delayMs);
                        t.unref();
                    });
                }
            }
        }
        const strategy = this.config.onExhausted;
        if (strategy === 'abort') {
            return {
                success: false,
                error: lastError,
                errorClass: lastErrorClass,
                attempts,
                recovered: false,
            };
        }
        (_d = options === null || options === void 0 ? void 0 : options.onSkip) === null || _d === void 0 ? void 0 : _d.call(options, lastError);
        return {
            success: false,
            error: lastError,
            errorClass: lastErrorClass,
            attempts,
            recovered: false,
        };
    }
    recordToDLQ(operationName, category, errorMessage, errorClass, retryable, attemptNumber, options) {
        var _a, _b;
        const entry = {
            id: `dlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            category,
            runId: this.runId,
            agentId: this.agentId,
            missionId: this.missionId,
            timestamp: new Date().toISOString(),
            errorClass,
            errorMessage: errorMessage.slice(0, 500),
            retryable,
            attemptNumber,
            operationName,
            inputSnapshot: (_a = options === null || options === void 0 ? void 0 : options.inputSnapshot) === null || _a === void 0 ? void 0 : _a.slice(0, 1000),
            tokenUsage: options === null || options === void 0 ? void 0 : options.tokenUsage,
            compensated: false,
            recovered: false,
            tags: (_b = options === null || options === void 0 ? void 0 : options.tags) !== null && _b !== void 0 ? _b : [],
        };
        this.dlq.record(entry);
    }
}
exports.StepErrorBoundary = StepErrorBoundary;
