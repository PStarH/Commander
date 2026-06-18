"use strict";
/**
 * Default compensation handlers for built-in mutation tools.
 *
 * Each handler implements the inverse of a single tool's side effect. The
 * handler is invoked by RunLedger.abortAndCompensate() in reverse execution
 * order.
 *
 * Snapshot pattern: file_write/file_edit/copy_etc use a snapshot-then-mutate
 * pattern via the snapshot tool. The compensation restores the pre-mutation
 * state. If the snapshot is missing (e.g. process crashed before snapshot
 * was taken), the compensation is best-effort and reports failure to the
 * dead-letter queue.
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
exports.defaultCompensationHandlers = void 0;
exports.takeSnapshot = takeSnapshot;
exports.registerCompensationHandler = registerCompensationHandler;
exports.resolveMutationFlag = resolveMutationFlag;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const log = (0, logging_1.getGlobalLogger)();
/** Marker for actions we acknowledge cannot be undone. */
async function nonCompensable(action) {
    log.warn('ATR', `Tool ${action.toolName} is non-compensable; side effect committed`, {
        actionId: action.actionId,
        description: action.description,
    });
    return {
        success: false,
        error: `Tool ${action.toolName} is non-compensable; manual intervention required`,
    };
}
/**
 * Read a snapshot file (if it exists) and restore the original file. Snapshots
 * are written by file_write before the write, and live at
 *   <originalPath>.atr-snapshot.<actionId>
 * This is the recovery side of the snapshot-before-mutate pattern.
 */
async function restoreFromSnapshot(action) {
    var _a;
    const filePath = (_a = action.args.path) !== null && _a !== void 0 ? _a : action.args.filePath;
    if (typeof filePath !== 'string')
        return { success: true };
    const snapshotPath = `${filePath}.atr-snapshot.${action.actionId}`;
    try {
        if (!fs.existsSync(snapshotPath)) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return { success: true };
        }
        const original = fs.readFileSync(snapshotPath, 'utf-8');
        fs.writeFileSync(filePath, original, 'utf-8');
        fs.unlinkSync(snapshotPath);
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
/**
 * Take a snapshot of a file before mutation. Called by tools that
 * register a `beforeExecute` snapshot hook. No-op if file does not exist.
 */
function takeSnapshot(filePath, actionId) {
    if (typeof filePath !== 'string')
        return;
    try {
        if (fs.existsSync(filePath)) {
            const snapshotPath = `${filePath}.atr-snapshot.${actionId}`;
            fs.copyFileSync(filePath, snapshotPath);
        }
    }
    catch (err) {
        log.warn('ATR', 'Snapshot failed', { filePath, actionId, error: err.message });
    }
}
exports.defaultCompensationHandlers = {
    file_write: restoreFromSnapshot,
    file_edit: restoreFromSnapshot,
    apply_patch: restoreFromSnapshot,
    code_fixer: restoreFromSnapshot,
    code_refiner: restoreFromSnapshot,
    mkdir: async (action) => {
        var _a;
        const dir = (_a = action.args.path) !== null && _a !== void 0 ? _a : action.args.dir;
        if (typeof dir !== 'string')
            return { success: true };
        try {
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
            }
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    },
    file_delete: async (action) => {
        return restoreFromSnapshot(action);
    },
    shell_execute: nonCompensable,
    python_execute: nonCompensable,
    git_push: nonCompensable,
    git_commit: nonCompensable,
    web_fetch: nonCompensable,
    web_search: nonCompensable,
    browser_fetch: nonCompensable,
    memory_store: async (action) => {
        const key = action.args.key;
        if (typeof key !== 'string')
            return { success: true };
        try {
            const memoryPath = path.join(process.cwd(), '.commander', 'memory.json');
            if (!fs.existsSync(memoryPath))
                return { success: true };
            const data = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
            const filtered = data.filter((e) => e.key !== key);
            fs.writeFileSync(memoryPath, JSON.stringify(filtered, null, 2), 'utf-8');
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    },
};
/**
 * Register the default compensation handlers on a RunLedger instance.
 * Idempotent — safe to call multiple times.
 */
function registerCompensationHandler(ledger, toolName, handler) {
    if (toolName && handler) {
        ledger.registerCompensation(toolName, handler);
        return;
    }
    for (const [name, h] of Object.entries(exports.defaultCompensationHandlers)) {
        ledger.registerCompensation(name, h);
    }
}
const HEURISTIC_KEYWORDS = [
    'write',
    'edit',
    'delete',
    'mkdir',
    'mv',
    'cp',
    'bash',
    'shell',
    'git',
    'patch',
    'fixer',
    'refiner',
];
/**
 * Resolve whether a tool is a mutation, using the explicit `mutation` flag
 * from ToolDefinition when present, falling back to a substring heuristic
 * for legacy tools. This is the API the runtime should call instead of
 * the bare `isMutationTool()` heuristic.
 */
function resolveMutationFlag(toolName, definition) {
    if ((definition === null || definition === void 0 ? void 0 : definition.mutation) === true) {
        return {
            isMutation: true,
            source: 'declared',
            handlerName: toolName in exports.defaultCompensationHandlers ? toolName : undefined,
        };
    }
    if ((definition === null || definition === void 0 ? void 0 : definition.mutation) === false) {
        return { isMutation: false, source: 'declared' };
    }
    const lower = toolName.toLowerCase();
    const matched = HEURISTIC_KEYWORDS.find((k) => lower.includes(k));
    if (matched) {
        return {
            isMutation: true,
            source: 'heuristic',
            handlerName: toolName in exports.defaultCompensationHandlers ? toolName : undefined,
        };
    }
    return { isMutation: false, source: 'default' };
}
