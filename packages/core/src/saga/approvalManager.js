"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalStoreError = exports.ApprovalError = exports.ApprovalManager = exports.FileApprovalStore = exports.InMemoryApprovalStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
class InMemoryApprovalStore {
    constructor() {
        this.records = new Map();
    }
    key(runId, nodeId) {
        return `${runId}::${nodeId}`;
    }
    async create(request) {
        const k = this.key(request.runId, request.nodeId);
        if (this.records.has(k)) {
            throw new ApprovalStoreError(`Approval already exists for ${request.runId}/${request.nodeId}`);
        }
        this.records.set(k, { request });
    }
    async get(runId, nodeId) {
        var _a;
        return (_a = this.records.get(this.key(runId, nodeId))) === null || _a === void 0 ? void 0 : _a.request;
    }
    async record(request, result) {
        this.records.set(this.key(request.runId, request.nodeId), {
            request,
            result,
        });
    }
    async outcome(runId, nodeId) {
        var _a;
        return (_a = this.records.get(this.key(runId, nodeId))) === null || _a === void 0 ? void 0 : _a.result;
    }
    async listPending(approver) {
        const pending = [];
        for (const entry of this.records.values()) {
            if (entry.result === undefined && entry.request.approver === approver) {
                pending.push(entry.request);
            }
        }
        return pending;
    }
    async delete(runId, nodeId) {
        this.records.delete(this.key(runId, nodeId));
    }
}
exports.InMemoryApprovalStore = InMemoryApprovalStore;
class FileApprovalStore {
    constructor(options) {
        this.options = options;
    }
    pathFor(runId, nodeId) {
        const safeNodeId = nodeId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return (0, node_path_1.join)(this.options.baseDir, runId, `${safeNodeId}.json`);
    }
    async ensureDir(path) {
        await node_fs_1.promises.mkdir(path, { recursive: true });
    }
    async create(request) {
        const path = this.pathFor(request.runId, request.nodeId);
        if (await this.exists(path)) {
            throw new ApprovalStoreError(`Approval already exists for ${request.runId}/${request.nodeId}`);
        }
        await this.ensureDir((0, node_path_1.dirname)(path));
        const tmp = path + '.tmp';
        await node_fs_1.promises.writeFile(tmp, JSON.stringify({ request }), 'utf8');
        await node_fs_1.promises.rename(tmp, path);
    }
    async get(runId, nodeId) {
        const path = this.pathFor(runId, nodeId);
        const record = await this.readRecord(path);
        return record === null || record === void 0 ? void 0 : record.request;
    }
    async record(request, result) {
        const path = this.pathFor(request.runId, request.nodeId);
        await this.ensureDir((0, node_path_1.dirname)(path));
        const tmp = path + '.tmp';
        await node_fs_1.promises.writeFile(tmp, JSON.stringify({ request, result }), 'utf8');
        await node_fs_1.promises.rename(tmp, path);
    }
    async outcome(runId, nodeId) {
        const path = this.pathFor(runId, nodeId);
        const record = await this.readRecord(path);
        return record === null || record === void 0 ? void 0 : record.result;
    }
    async listPending(approver) {
        const out = [];
        const base = this.options.baseDir;
        let runDirs = [];
        try {
            const entries = await node_fs_1.promises.readdir(base, { withFileTypes: true });
            runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
        for (const runId of runDirs) {
            const runPath = (0, node_path_1.join)(base, runId);
            const files = await node_fs_1.promises.readdir(runPath, { withFileTypes: true });
            for (const f of files) {
                if (!f.isFile() || !f.name.endsWith('.json'))
                    continue;
                const filePath = (0, node_path_1.join)(runPath, f.name);
                const record = await this.readRecord(filePath);
                if (record &&
                    record.request !== undefined &&
                    record.request.approver === approver &&
                    record.result === undefined) {
                    out.push(record.request);
                }
            }
        }
        return out;
    }
    async delete(runId, nodeId) {
        const path = this.pathFor(runId, nodeId);
        try {
            await node_fs_1.promises.unlink(path);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return;
            throw err;
        }
    }
    async readRecord(path) {
        try {
            const content = await node_fs_1.promises.readFile(path, 'utf8');
            return JSON.parse(content);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return undefined;
            throw err;
        }
    }
    async exists(path) {
        try {
            await node_fs_1.promises.access(path);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.FileApprovalStore = FileApprovalStore;
class ApprovalManager {
    constructor(options) {
        this.options = options;
    }
    async request(req) {
        await this.options.store.create(req);
    }
    async decide(runId, nodeId, result) {
        const existing = await this.options.store.get(runId, nodeId);
        if (!existing) {
            throw new ApprovalError(`No approval request for ${runId}/${nodeId}`);
        }
        await this.options.store.record(existing, result);
    }
    async outcome(runId, nodeId) {
        return this.options.store.outcome(runId, nodeId);
    }
    async waitForDecision(runId, nodeId, options = {}) {
        var _a;
        const pollIntervalMs = (_a = options.pollIntervalMs) !== null && _a !== void 0 ? _a : 500;
        const signal = options.signal;
        while (true) {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
                throw new ApprovalError('Approval wait aborted');
            }
            const result = await this.options.store.outcome(runId, nodeId);
            if (result)
                return result;
            await this.sleep(pollIntervalMs, signal);
        }
    }
    async listPending(approver) {
        return this.options.store.listPending(approver);
    }
    async cancel(runId, nodeId) {
        await this.options.store.delete(runId, nodeId);
    }
    sleep(ms, signal) {
        return new Promise((resolve) => {
            if (signal === null || signal === void 0 ? void 0 : signal.aborted) {
                resolve();
                return;
            }
            const timer = setTimeout(resolve, ms);
            if (signal) {
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            }
        });
    }
}
exports.ApprovalManager = ApprovalManager;
class ApprovalError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApprovalError';
    }
}
exports.ApprovalError = ApprovalError;
class ApprovalStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApprovalStoreError';
    }
}
exports.ApprovalStoreError = ApprovalStoreError;
