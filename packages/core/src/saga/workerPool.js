"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InProcessWorkerPool = exports.WorkerPoolError = exports.WorkerPool = void 0;
class WorkerPool {
    constructor(options) {
        this.options = options;
        this.active = 0;
        this.queue = [];
        this.closed = false;
        if (options.maxConcurrency < 1) {
            throw new WorkerPoolError('maxConcurrency must be >= 1');
        }
    }
    get maxConcurrency() {
        return this.options.maxConcurrency;
    }
    get activeCount() {
        return this.active;
    }
    get queueDepth() {
        return this.queue.length;
    }
    get isClosed() {
        return this.closed;
    }
    async run(id, fn) {
        if (this.closed) {
            throw new WorkerPoolError('Pool is closed');
        }
        return new Promise((resolve, reject) => {
            const task = { id, fn, resolve, reject };
            this.queue.push(task);
            this.drain();
        });
    }
    async close() {
        this.closed = true;
        const err = new WorkerPoolError('Pool closed');
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            task.reject(err);
        }
    }
    async drain() {
        while (this.queue.length > 0) {
            const task = this.queue[0];
            if (this.active >= this.options.maxConcurrency)
                return;
            this.queue.shift();
            this.executeTask(task);
        }
    }
    async executeTask(task) {
        this.active++;
        try {
            const result = await task.fn();
            task.resolve(result);
        }
        catch (err) {
            task.reject(err instanceof Error ? err : new Error(String(err)));
        }
        finally {
            this.active--;
            this.drain();
        }
    }
}
exports.WorkerPool = WorkerPool;
class WorkerPoolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkerPoolError';
    }
}
exports.WorkerPoolError = WorkerPoolError;
class InProcessWorkerPool extends WorkerPool {
    constructor(maxConcurrency) {
        super({ maxConcurrency });
    }
}
exports.InProcessWorkerPool = InProcessWorkerPool;
