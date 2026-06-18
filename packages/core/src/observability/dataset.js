"use strict";
/**
 * P-obs-3: Dataset + DatasetStore (Braintrust-style).
 *
 * A Dataset is a named collection of test cases. Each case has an
 * `input` (the agent's goal), an optional `expected` (what the
 * agent should produce), and a rubric reference. The store is
 * in-memory with optional JSON-file persistence — production
 * deployments can mount a writable volume and call `saveAll()` on
 * shutdown to keep the dataset across restarts.
 *
 * Braintrust parity:
 *  - dataset has id, name, description, rubricId, cases
 *  - case has id, input, expected, metadata, rubricId
 *  - store exposes list/get/create/update/delete + bulk load/save
 */
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
exports.DatasetStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * In-memory dataset store with optional JSON file persistence.
 * Thread-safety: not thread-safe; intended for single-process use.
 */
class DatasetStore {
    constructor(config = {}) {
        this.datasets = new Map();
        this.persistenceDir = config.persistenceDir;
        if (this.persistenceDir) {
            try {
                fs.mkdirSync(this.persistenceDir, { recursive: true });
            }
            catch {
                /* best-effort */
            }
        }
    }
    // ────────── CRUD ──────────
    list() {
        return Array.from(this.datasets.values()).sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    }
    get(id) {
        return this.datasets.get(id);
    }
    create(input) {
        var _a;
        const now = new Date().toISOString();
        const dataset = {
            id: (_a = input.id) !== null && _a !== void 0 ? _a : generateId('ds'),
            name: input.name,
            description: input.description,
            rubricId: input.rubricId,
            cases: input.cases,
            createdAt: now,
            updatedAt: now,
        };
        this.datasets.set(dataset.id, dataset);
        return dataset;
    }
    update(id, patch) {
        const existing = this.datasets.get(id);
        if (!existing)
            return undefined;
        const updated = {
            ...existing,
            ...patch,
            id: existing.id, // id is immutable
            createdAt: existing.createdAt, // createdAt is immutable
            updatedAt: new Date().toISOString(),
        };
        this.datasets.set(id, updated);
        return updated;
    }
    delete(id) {
        return this.datasets.delete(id);
    }
    // ────────── Persistence ──────────
    /** Write a single dataset to disk. No-op when persistence is disabled. */
    save(id) {
        if (!this.persistenceDir)
            return false;
        const dataset = this.datasets.get(id);
        if (!dataset)
            return false;
        try {
            const filePath = path.join(this.persistenceDir, `${id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2), 'utf-8');
            return true;
        }
        catch {
            return false;
        }
    }
    /** Write all datasets to disk. */
    saveAll() {
        if (!this.persistenceDir)
            return 0;
        let n = 0;
        for (const id of this.datasets.keys()) {
            if (this.save(id))
                n++;
        }
        return n;
    }
    /** Load a dataset from a JSON file and add it to the store. */
    loadFromFile(filePath) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed.id || !parsed.rubricId || !Array.isArray(parsed.cases))
                return undefined;
            this.datasets.set(parsed.id, parsed);
            return parsed;
        }
        catch {
            return undefined;
        }
    }
    /** Load every `*.json` file in the persistence directory. */
    loadAllFromDir() {
        if (!this.persistenceDir)
            return 0;
        let n = 0;
        try {
            const files = fs.readdirSync(this.persistenceDir).filter((f) => f.endsWith('.json'));
            for (const f of files) {
                if (this.loadFromFile(path.join(this.persistenceDir, f)))
                    n++;
            }
        }
        catch {
            /* best-effort */
        }
        return n;
    }
    /** Count of datasets in memory. */
    size() {
        return this.datasets.size;
    }
}
exports.DatasetStore = DatasetStore;
/** Simple ID generator: `ds_<timestamp>_<rand>`. */
function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
