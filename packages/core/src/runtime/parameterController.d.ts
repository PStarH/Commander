/**
 * Parameter Controller — Adaptive LLM sampling parameter selection.
 *
 * Dynamically selects temperature, topP, and other sampling parameters based
 * on task type classification. Uses keyword/pattern matching to classify
 * user messages into 8 task types (code_generation, code_review, tool_calling,
 * reasoning, creative, conversation, planning, default).
 *
 * Features:
 * - Task-type parameter profiles with per-type temperature/topP defaults
 * - Self-correction retry loop (increase temp on first retry, decrease thereafter)
 * - Lockable eval profile for deterministic evaluation runs
 * - Plugin integration via beforeLLMCall hook
 * - Parameter decision audit trail (last 1000 decisions)
 */
import type { LLMMessage, LLMRequest, ReasoningConfig } from './types';
import type { CommanderPlugin } from '../pluginManager';
export type TaskType = 'code_generation' | 'code_review' | 'tool_calling' | 'reasoning' | 'creative' | 'conversation' | 'planning' | 'default';
/**
 * Locked parameter profile for evaluation runs.
 * When active, these override all dynamic adjustments.
 */
export interface EvaluationProfile {
    temperature: number;
    topP: number;
    maxTokens: number;
    reasoningConfig?: ReasoningConfig;
}
/** Lock sampling parameters to a fixed profile (e.g. for eval runs). */
export declare function setEvalProfile(profile: EvaluationProfile | null): void;
/** Check whether an eval profile is currently active. */
export declare function isEvalProfileActive(): boolean;
/** Get the active eval profile. */
export declare function getEvalProfile(): EvaluationProfile | null;
/** Decision log entry for parameter controller audit trail. */
export interface ParamDecision {
    timestamp: string;
    taskType: TaskType;
    confidence: number;
    chosenTemperature: number;
    chosenTopP: number;
    chosenMaxTokens: number;
    reasoningConfig?: ReasoningConfig;
    evalProfileApplied: boolean;
}
export declare function getParamDecisions(): readonly ParamDecision[];
export interface TaskProfile {
    taskType: TaskType;
    confidence: number;
    reasoning: string;
}
export interface SamplingParams {
    temperature: number;
    topP: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
}
export declare function classifyTask(userMessage: string, history?: LLMMessage[]): TaskProfile;
export declare function getSamplingParams(profile: TaskProfile, userOverride?: Partial<SamplingParams>): SamplingParams;
export declare function getAdaptiveParams(userMessage: string, history: LLMMessage[], attemptNumber: number, userOverride?: Partial<SamplingParams>): SamplingParams;
/** Build a full LLMRequest with all controller-managed parameters applied. */
export declare function applyControllerParams(base: LLMRequest, userMessage: string, history: LLMMessage[], attemptNumber: number): LLMRequest;
export declare function createParameterControllerPlugin(overrides?: Partial<Record<TaskType, Partial<SamplingParams>>>): CommanderPlugin;
//# sourceMappingURL=parameterController.d.ts.map