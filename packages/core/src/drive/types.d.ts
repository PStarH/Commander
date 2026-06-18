import type { AgentExecutionResult } from '../runtime/types';
export interface DriveConfig {
    maxIterations: number;
    checkpointDir: string;
    mode: 'auto' | 'supervised';
    model?: string;
    verbose: boolean;
}
export declare const DEFAULT_DRIVE_CONFIG: DriveConfig;
export interface DriveStep {
    id: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    result?: string;
    error?: string;
    retryCount: number;
    maxRetries: number;
    agentResult?: AgentExecutionResult;
}
export interface DriveState {
    goal: string;
    steps: DriveStep[];
    currentStepIndex: number;
    iteration: number;
    startTime: number;
    lastCheckpoint: string;
    totalTokensUsed: number;
}
export interface DriveResult {
    goal: string;
    status: 'completed' | 'partial' | 'failed';
    steps: DriveStep[];
    totalIterations: number;
    totalDurationMs: number;
    totalTokensUsed: number;
    summary: string;
}
export type DriveStatus = 'completed' | 'partial' | 'failed';
//# sourceMappingURL=types.d.ts.map