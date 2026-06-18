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
exports.MemoryListTool = exports.MemoryRecallTool = exports.MemoryStoreTool = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const MEMORY_DIR = path.join(process.cwd(), '.commander_memory');
if (!fs.existsSync(MEMORY_DIR))
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
class MemoryStoreTool {
    constructor() {
        this.definition = {
            name: 'memory_store',
            description: 'Store a key-value pair in persistent memory that survives across sessions. Retrieve later with memory_recall. Use for project context, user preferences, and cross-session state.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Memory key (use "project/topic" style)' },
                    value: { type: 'string', description: 'Value to store' },
                    namespace: {
                        type: 'string',
                        description: 'Namespace (default: "default")',
                        default: 'default',
                    },
                },
                required: ['key', 'value'],
            },
            examples: [
                { name: 'memory_store', arguments: { key: 'project/deadline', value: 'May 30th' } },
                {
                    name: 'memory_store',
                    arguments: { key: 'config/theme', value: 'dark', namespace: 'preferences' },
                },
            ],
            category: 'memory',
        };
    }
    async execute(args) {
        var _a, _b, _c;
        const key = String((_a = args.key) !== null && _a !== void 0 ? _a : '');
        const value = String((_b = args.value) !== null && _b !== void 0 ? _b : '');
        const namespace = String((_c = args.namespace) !== null && _c !== void 0 ? _c : 'default');
        if (!key)
            return 'Error: key is required';
        const nsDir = path.join(MEMORY_DIR, namespace);
        if (!fs.existsSync(nsDir))
            fs.mkdirSync(nsDir, { recursive: true });
        const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = path.join(nsDir, `${safeKey}.json`);
        const data = JSON.stringify({ key, value, timestamp: new Date().toISOString() }, null, 2);
        fs.writeFileSync(filePath, data, 'utf-8');
        return `Stored "${key}" in "${namespace}" (${value.length} chars)`;
    }
}
exports.MemoryStoreTool = MemoryStoreTool;
class MemoryRecallTool {
    constructor() {
        this.definition = {
            name: 'memory_recall',
            description: 'Recall stored memories by key or search across all stored values.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Specific key to recall' },
                    namespace: {
                        type: 'string',
                        description: 'Namespace (default: "default")',
                        default: 'default',
                    },
                    search: { type: 'string', description: 'Search term across all keys and values' },
                    limit: { type: 'number', description: 'Max results (default: 10)', default: 10 },
                },
            },
            examples: [
                { name: 'memory_recall', arguments: { key: 'project/deadline' } },
                { name: 'memory_recall', arguments: { search: 'config', namespace: 'preferences' } },
            ],
            category: 'memory',
        };
    }
    async execute(args) {
        var _a, _b;
        const key = args.key ? String(args.key) : null;
        const namespace = String((_a = args.namespace) !== null && _a !== void 0 ? _a : 'default');
        const search = args.search ? String(args.search).toLowerCase() : null;
        const limit = Math.min(Number((_b = args.limit) !== null && _b !== void 0 ? _b : 10), 100);
        const nsDir = path.join(MEMORY_DIR, namespace);
        if (!fs.existsSync(nsDir))
            return `No memories in "${namespace}"`;
        if (key) {
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filePath = path.join(nsDir, `${safeKey}.json`);
            if (!fs.existsSync(filePath))
                return `No memory for "${key}"`;
            let d;
            try {
                d = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('MemoryRecallTool', 'Failed to parse memory file', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
                d = {};
            }
            return `${d.key}: ${d.value}\n(updated: ${d.timestamp})`;
        }
        const files = fs.readdirSync(nsDir).filter((f) => f.endsWith('.json'));
        const results = [];
        for (const file of files) {
            try {
                let d;
                try {
                    d = JSON.parse(fs.readFileSync(path.join(nsDir, file), 'utf-8'));
                }
                catch {
                    d = {};
                }
                if (!search ||
                    d.key.toLowerCase().includes(search) ||
                    d.value.toLowerCase().includes(search)) {
                    results.push(d);
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('MemoryRecallTool', 'Failed to read memory entry', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return (results
            .slice(0, limit)
            .map((r) => `${r.key}: ${r.value.slice(0, 200)}`)
            .join('\n') || 'No results');
    }
}
exports.MemoryRecallTool = MemoryRecallTool;
class MemoryListTool {
    constructor() {
        this.definition = {
            name: 'memory_list',
            description: 'List all namespaces and entry counts in persistent memory.',
            inputSchema: { type: 'object', properties: {} },
            examples: [{ name: 'memory_list', arguments: {} }],
            category: 'memory',
        };
    }
    async execute() {
        if (!fs.existsSync(MEMORY_DIR))
            return 'No memory directory found';
        const namespaces = fs.readdirSync(MEMORY_DIR).filter((f) => {
            try {
                return fs.statSync(path.join(MEMORY_DIR, f)).isDirectory();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('MemoryListTool', 'Failed to stat namespace', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
                return false;
            }
        });
        if (namespaces.length === 0)
            return 'No memories stored';
        const parts = namespaces.map((ns) => {
            const count = fs
                .readdirSync(path.join(MEMORY_DIR, ns))
                .filter((f) => f.endsWith('.json')).length;
            return `${ns}: ${count} entries`;
        });
        return parts.join('\n');
    }
}
exports.MemoryListTool = MemoryListTool;
