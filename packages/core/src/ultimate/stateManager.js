"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialSharedState = createInitialSharedState;
exports.mergeSharedState = mergeSharedState;
const appendReducer = (prev, next) => [...prev, ...next];
const appendMsgReducer = (prev, next) => [...prev, ...next];
const sumReducer = (prev, next) => prev + next;
/**
 * Create initial shared state with default values.
 */
function createInitialSharedState() {
    return {
        findings: [],
        errors: [],
        messages: [],
        artifacts: [],
        costAccumulator: 0,
        currentStep: '',
    };
}
/**
 * Merge a partial update into shared state using per-key reducers.
 * Accumulating fields (findings, errors, messages, artifacts, costAccumulator)
 * use their reducers to merge. Overwrite fields (currentStep) replace directly.
 */
function mergeSharedState(current, update) {
    const next = { ...current };
    if (update.findings) {
        next.findings = appendReducer(current.findings, update.findings);
    }
    if (update.errors) {
        next.errors = appendReducer(current.errors, update.errors);
    }
    if (update.messages) {
        next.messages = appendMsgReducer(current.messages, update.messages);
    }
    if (update.artifacts) {
        next.artifacts = appendReducer(current.artifacts, update.artifacts);
    }
    if (update.costAccumulator !== undefined) {
        next.costAccumulator = sumReducer(current.costAccumulator, update.costAccumulator);
    }
    if (update.currentStep !== undefined) {
        next.currentStep = update.currentStep;
    }
    return next;
}
