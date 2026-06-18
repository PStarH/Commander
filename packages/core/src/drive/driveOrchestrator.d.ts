import type { LLMProvider } from '../runtime/types';
import type { AgentRuntimeInterface } from '../runtime';
import type { DriveConfig, DriveResult } from './types';
export declare class DriveOrchestrator {
    private provider;
    private runtime;
    private config;
    private model;
    private state;
    constructor(provider: LLMProvider, runtime?: AgentRuntimeInterface | null, config?: Partial<DriveConfig>);
    execute(goal: string): Promise<DriveResult>;
    private planGoal;
    private replan;
    private executeWithRuntime;
    private executeDirect;
    private resetState;
    private checkpointPath;
    private saveCheckpoint;
    private loadCheckpoint;
    private buildResult;
}
//# sourceMappingURL=driveOrchestrator.d.ts.map