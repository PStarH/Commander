export interface WorkerPoolOptions {
    maxConcurrency: number;
}
export interface PoolTask<T> {
    id: string;
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (err: Error) => void;
}
export declare class WorkerPool {
    private readonly options;
    private active;
    private readonly queue;
    private closed;
    constructor(options: WorkerPoolOptions);
    get maxConcurrency(): number;
    get activeCount(): number;
    get queueDepth(): number;
    get isClosed(): boolean;
    run<T>(id: string, fn: () => Promise<T>): Promise<T>;
    close(): Promise<void>;
    drain(): Promise<void>;
    private executeTask;
}
export declare class WorkerPoolError extends Error {
    constructor(message: string);
}
export declare class InProcessWorkerPool extends WorkerPool {
    constructor(maxConcurrency: number);
}
//# sourceMappingURL=workerPool.d.ts.map