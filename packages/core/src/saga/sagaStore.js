"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemorySagaStore = exports.FileSagaStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
class FileSagaStore {
    constructor(options) {
        this.options = options;
    }
    eventsPath(runId) {
        return (0, node_path_1.join)(this.options.baseDir, runId, 'events.ndjson');
    }
    snapshotPath(runId) {
        return (0, node_path_1.join)(this.options.baseDir, runId, 'snapshot.json');
    }
    async ensureDir(path) {
        await node_fs_1.promises.mkdir(path, { recursive: true });
    }
    async appendEvent(event) {
        const path = this.eventsPath(event.runId);
        await this.ensureDir((0, node_path_1.dirname)(path));
        await node_fs_1.promises.appendFile(path, JSON.stringify(event) + '\n', 'utf8');
    }
    async readEvents(runId) {
        const path = this.eventsPath(runId);
        try {
            const content = await node_fs_1.promises.readFile(path, 'utf8');
            return content
                .split('\n')
                .filter((line) => line.length > 0)
                .map((line) => JSON.parse(line));
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async writeSnapshot(snapshot) {
        const path = this.snapshotPath(snapshot.runId);
        const tmpPath = path + '.tmp';
        await this.ensureDir((0, node_path_1.dirname)(path));
        const body = this.options.prettyPrint
            ? JSON.stringify(snapshot, null, 2)
            : JSON.stringify(snapshot);
        await node_fs_1.promises.writeFile(tmpPath, body, 'utf8');
        await node_fs_1.promises.rename(tmpPath, path);
    }
    async readSnapshot(runId) {
        const path = this.snapshotPath(runId);
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
    async listRunIds() {
        try {
            const entries = await node_fs_1.promises.readdir(this.options.baseDir, {
                withFileTypes: true,
            });
            return entries.filter((e) => e.isDirectory()).map((e) => e.name);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async deleteRun(runId) {
        const path = (0, node_path_1.join)(this.options.baseDir, runId);
        try {
            await node_fs_1.promises.rm(path, { recursive: true, force: true });
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return;
            throw err;
        }
    }
}
exports.FileSagaStore = FileSagaStore;
class InMemorySagaStore {
    constructor() {
        this.events = new Map();
        this.snapshots = new Map();
    }
    async appendEvent(event) {
        var _a;
        const list = (_a = this.events.get(event.runId)) !== null && _a !== void 0 ? _a : [];
        list.push(event);
        this.events.set(event.runId, list);
    }
    async readEvents(runId) {
        var _a;
        return [...((_a = this.events.get(runId)) !== null && _a !== void 0 ? _a : [])];
    }
    async writeSnapshot(snapshot) {
        this.snapshots.set(snapshot.runId, snapshot);
    }
    async readSnapshot(runId) {
        return this.snapshots.get(runId);
    }
    async listRunIds() {
        const ids = new Set([...this.events.keys(), ...this.snapshots.keys()]);
        return Array.from(ids);
    }
    async deleteRun(runId) {
        this.events.delete(runId);
        this.snapshots.delete(runId);
    }
}
exports.InMemorySagaStore = InMemorySagaStore;
