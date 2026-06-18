export interface CPUWorkerPoolOptions {
    poolSize?: number;
    taskTimeoutMs?: number;
    workerScript?: string;
}
export interface WorkerTask<TInput, TOutput> {
    type: string;
    input: TInput;
}
export interface PendingTask {
    id: string;
    type: string;
    input: unknown;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timestamp: number;
}
export declare class CPUWorkerPool {
    private workers;
    private availableWorkers;
    private taskQueue;
    private taskIdCounter;
    private readonly poolSize;
    private readonly taskTimeoutMs;
    private readonly workerScript;
    private closed;
    private totalTasksExecuted;
    private totalTasksQueued;
    constructor(options?: CPUWorkerPoolOptions);
    start(): Promise<void>;
    private createWorker;
    private restartWorker;
    execute<TInput, TOutput>(type: string, input: TInput): Promise<TOutput>;
    private processQueue;
    getStats(): {
        poolSize: number;
        availableWorkers: number;
        queueDepth: number;
        totalExecuted: number;
        totalQueued: number;
    };
    shutdown(): Promise<void>;
}
export declare function getCPUWorkerPool(): Promise<CPUWorkerPool>;
export declare function resetCPUWorkerPool(): Promise<void>;
//# sourceMappingURL=cpuWorkerPool.d.ts.map