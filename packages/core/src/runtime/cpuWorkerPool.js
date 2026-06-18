"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CPUWorkerPool = void 0;
exports.getCPUWorkerPool = getCPUWorkerPool;
exports.resetCPUWorkerPool = resetCPUWorkerPool;
/**
 * CPU Worker Pool — Offload CPU-intensive operations to worker_threads.
 *
 * Uses Node.js worker_threads to run heavy computations (compaction, scoring,
 * summarization) without blocking the main event loop.
 *
 * Design:
 * - Fixed pool size (default: 2 workers, configurable)
 * - Task queue with backpressure
 * - Automatic worker restart on crash
 * - Timeout support for long-running tasks
 */
const worker_threads_1 = require("worker_threads");
const path = __importStar(require("path"));
// ============================================================================
// CPU Worker Pool
// ============================================================================
class CPUWorkerPool {
    constructor(options) {
        var _a, _b, _c, _d, _e;
        this.workers = [];
        this.availableWorkers = new Set();
        this.taskQueue = [];
        this.taskIdCounter = 0;
        this.closed = false;
        this.totalTasksExecuted = 0;
        this.totalTasksQueued = 0;
        this.poolSize =
            (_a = options === null || options === void 0 ? void 0 : options.poolSize) !== null && _a !== void 0 ? _a : Math.min(2, ((_c = (_b = globalThis.navigator) === null || _b === void 0 ? void 0 : _b.hardwareConcurrency) !== null && _c !== void 0 ? _c : 4) - 1);
        this.taskTimeoutMs = (_d = options === null || options === void 0 ? void 0 : options.taskTimeoutMs) !== null && _d !== void 0 ? _d : 30000;
        this.workerScript = (_e = options === null || options === void 0 ? void 0 : options.workerScript) !== null && _e !== void 0 ? _e : path.join(__dirname, 'cpuWorker.js');
    }
    async start() {
        for (let i = 0; i < this.poolSize; i++) {
            const worker = await this.createWorker(i);
            this.workers.push(worker);
            this.availableWorkers.add(i);
        }
    }
    async createWorker(index) {
        const worker = new worker_threads_1.Worker(this.workerScript, {
            name: `cpu-worker-${index}`,
        });
        worker.on('message', (msg) => {
            const taskIdx = this.taskQueue.findIndex((t) => t.id === msg.id);
            if (taskIdx === -1)
                return;
            const task = this.taskQueue[taskIdx];
            this.taskQueue.splice(taskIdx, 1);
            this.availableWorkers.add(index);
            if (msg.error) {
                task.reject(new Error(msg.error));
            }
            else {
                task.resolve(msg.result);
            }
            this.totalTasksExecuted++;
            this.processQueue();
        });
        worker.on('error', (err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[CPUWorkerPool] Worker ${index} error:`, message);
            this.restartWorker(index);
        });
        worker.on('exit', (code) => {
            if (code !== 0 && !this.closed) {
                console.error(`[CPUWorkerPool] Worker ${index} exited with code ${code}`);
                this.restartWorker(index);
            }
        });
        return worker;
    }
    async restartWorker(index) {
        var _a;
        if (this.closed)
            return;
        this.availableWorkers.delete(index);
        try {
            (_a = this.workers[index]) === null || _a === void 0 ? void 0 : _a.terminate();
        }
        catch { }
        try {
            const worker = await this.createWorker(index);
            this.workers[index] = worker;
            this.availableWorkers.add(index);
            this.processQueue();
        }
        catch (err) {
            console.error(`[CPUWorkerPool] Failed to restart worker ${index}:`, err);
        }
    }
    async execute(type, input) {
        if (this.closed)
            throw new Error('Pool is closed');
        return new Promise((resolve, reject) => {
            const id = `task-${++this.taskIdCounter}`;
            const task = {
                id,
                type,
                input,
                resolve: resolve,
                reject,
                timestamp: Date.now(),
            };
            this.taskQueue.push(task);
            this.totalTasksQueued++;
            const timer = setTimeout(() => {
                const idx = this.taskQueue.findIndex((t) => t.id === id);
                if (idx !== -1) {
                    this.taskQueue.splice(idx, 1);
                    reject(new Error(`Task ${id} timed out after ${this.taskTimeoutMs}ms`));
                }
            }, this.taskTimeoutMs);
            const originalReject = task.reject;
            task.reject = (err) => {
                clearTimeout(timer);
                originalReject(err);
            };
            const originalResolve = task.resolve;
            task.resolve = (v) => {
                clearTimeout(timer);
                originalResolve(v);
            };
            this.processQueue();
        });
    }
    processQueue() {
        while (this.taskQueue.length > 0 && this.availableWorkers.size > 0) {
            const workerIdx = this.availableWorkers.values().next().value;
            this.availableWorkers.delete(workerIdx);
            const task = this.taskQueue.find((t) => t.timestamp === Math.min(...this.taskQueue.map((t) => t.timestamp)));
            if (!task)
                break;
            const worker = this.workers[workerIdx];
            if (!worker) {
                this.availableWorkers.add(workerIdx);
                break;
            }
            worker.postMessage({ id: task.id, type: task.type, input: task.input });
        }
    }
    getStats() {
        return {
            poolSize: this.poolSize,
            availableWorkers: this.availableWorkers.size,
            queueDepth: this.taskQueue.length,
            totalExecuted: this.totalTasksExecuted,
            totalQueued: this.totalTasksQueued,
        };
    }
    async shutdown() {
        this.closed = true;
        const err = new Error('Pool shutdown');
        while (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            task.reject(err);
        }
        const shutdownPromises = this.workers.map((w) => w.terminate());
        await Promise.allSettled(shutdownPromises);
        this.workers = [];
        this.availableWorkers.clear();
    }
}
exports.CPUWorkerPool = CPUWorkerPool;
// ============================================================================
// Singleton
// ============================================================================
let _pool = null;
async function getCPUWorkerPool() {
    if (!_pool) {
        _pool = new CPUWorkerPool();
        await _pool.start();
    }
    return _pool;
}
async function resetCPUWorkerPool() {
    if (_pool) {
        await _pool.shutdown();
        _pool = null;
    }
}
