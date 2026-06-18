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
exports.createMemoryStore = createMemoryStore;
exports.fromProjectMemoryItem = fromProjectMemoryItem;
exports.toProjectMemoryItem = toProjectMemoryItem;
const logging_1 = require("../logging");
const jsonStore_1 = require("./jsonStore");
async function createMemoryStore(type = 'in-memory') {
    switch (type) {
        case 'in-memory': {
            const { InMemoryMemoryStore } = await Promise.resolve().then(() => __importStar(require('../memory')));
            return new InMemoryMemoryStore();
        }
        case 'sqlite': {
            try {
                const { SqliteMemoryStore } = await Promise.resolve().then(() => __importStar(require('../runtime/sqliteMemoryStore')));
                const store = new SqliteMemoryStore('.commander/memory.db');
                store.init().catch((err) => (0, logging_1.getGlobalLogger)().warn('createMemoryStore', 'SqliteMemoryStore init failed', {
                    error: err.message,
                }));
                return store;
            }
            catch {
                (0, logging_1.getGlobalLogger)().warn('createMemoryStore', 'SqliteMemoryStore not available, falling back to JSON store');
                return new jsonStore_1.JsonMemoryStore('.commander/memory.json');
            }
        }
        case 'json':
            return new jsonStore_1.JsonMemoryStore('.commander/memory.json');
        default:
            throw new Error(`Unknown memory store type: ${type}`);
    }
}
function fromProjectMemoryItem(item) {
    var _a;
    return {
        id: item.id,
        projectId: item.projectId,
        missionId: item.missionId,
        agentId: item.agentId,
        kind: item.kind,
        duration: (_a = item.duration) !== null && _a !== void 0 ? _a : 'EPISODIC',
        title: item.title,
        content: item.content,
        tags: item.tags,
        priority: 50,
        createdAt: item.createdAt,
        lastAccessedAt: item.createdAt,
        confidence: 0.8,
    };
}
function toProjectMemoryItem(item) {
    return {
        id: item.id,
        projectId: item.projectId,
        missionId: item.missionId,
        agentId: item.agentId,
        kind: item.kind,
        title: item.title,
        content: item.content,
        tags: item.tags,
        createdAt: item.createdAt,
        duration: item.duration,
    };
}
