"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchLLMProvider = void 0;
exports.createBatchProvider = createBatchProvider;
const logging_1 = require("../logging");
const DEFAULT_BATCH_CONFIG = {
    maxBatchSize: 100,
    pollIntervalMs: 5000,
    maxPollAttempts: 120,
};
class BatchLLMProvider {
    constructor(wrapped, config = {}) {
        this.pendingJobs = new Map();
        this.completedJobs = new Map();
        this.wrapped = wrapped;
        this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
    }
    submitBatch(requests) {
        const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const entries = requests.map((req, i) => ({
            id: `${jobId}_req_${i}`,
            request: req,
        }));
        const job = {
            id: jobId,
            requests: entries,
            status: 'pending',
            createdAt: new Date().toISOString(),
            results: new Map(),
        };
        this.pendingJobs.set(jobId, job);
        (0, logging_1.getGlobalLogger)().info('BatchProvider', `Batch job ${jobId} created with ${requests.length} requests`);
        return jobId;
    }
    async processBatch(jobId) {
        const job = this.pendingJobs.get(jobId);
        if (!job)
            throw new Error(`Batch job ${jobId} not found`);
        job.status = 'processing';
        const chunks = this.chunk(job.requests, this.config.maxBatchSize);
        for (const chunk of chunks) {
            const results = await Promise.allSettled(chunk.map((entry) => this.wrapped.call(entry.request)));
            for (let i = 0; i < chunk.length; i++) {
                const result = results[i];
                if (result.status === 'fulfilled') {
                    job.results.set(chunk[i].id, result.value);
                }
                else {
                    job.results.set(chunk[i].id, result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }
        }
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        this.completedJobs.set(jobId, job);
        this.pendingJobs.delete(jobId);
        return job;
    }
    async processSequentially(jobId) {
        const job = this.pendingJobs.get(jobId);
        if (!job)
            throw new Error(`Batch job ${jobId} not found`);
        job.status = 'processing';
        for (const entry of job.requests) {
            try {
                const response = await this.wrapped.call(entry.request);
                job.results.set(entry.id, response);
            }
            catch (err) {
                job.results.set(entry.id, err instanceof Error ? err : new Error(String(err)));
            }
        }
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        this.completedJobs.set(jobId, job);
        this.pendingJobs.delete(jobId);
        return job;
    }
    getResult(jobId, requestId) {
        var _a;
        const job = (_a = this.completedJobs.get(jobId)) !== null && _a !== void 0 ? _a : this.pendingJobs.get(jobId);
        return job === null || job === void 0 ? void 0 : job.results.get(requestId);
    }
    getJob(jobId) {
        var _a;
        return (_a = this.pendingJobs.get(jobId)) !== null && _a !== void 0 ? _a : this.completedJobs.get(jobId);
    }
    listJobs() {
        const all = [...this.pendingJobs.values(), ...this.completedJobs.values()];
        return all.map((j) => ({
            id: j.id,
            status: j.status,
            total: j.requests.length,
            completed: j.results.size,
        }));
    }
    getStats() {
        let totalRequests = 0;
        for (const j of this.pendingJobs.values())
            totalRequests += j.requests.length;
        for (const j of this.completedJobs.values())
            totalRequests += j.requests.length;
        return {
            pendingJobs: this.pendingJobs.size,
            completedJobs: this.completedJobs.size,
            totalRequests,
        };
    }
    clearCompleted() {
        this.completedJobs.clear();
    }
    getWrappedProvider() {
        return this.wrapped;
    }
    chunk(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }
}
exports.BatchLLMProvider = BatchLLMProvider;
function createBatchProvider(wrapped, config) {
    return new BatchLLMProvider(wrapped, config);
}
