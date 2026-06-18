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
exports.atomicWriteFile = atomicWriteFile;
exports.registerTmpCleanup = registerTmpCleanup;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
/**
 * Write a file atomically: write to a uniquely-named temp file in the same
 * directory, fsync, then rename. A crash at any point leaves either the
 * old file intact or the new file complete — never a half-written file.
 *
 * Why same-directory: rename(2) is atomic only on the same filesystem.
 * Placing the temp file next to the target (not in /tmp) keeps the rename
 * atomic and lets the file inherit the target's directory permissions.
 *
 * Why randomUUID + pid: protects against collisions when multiple
 * processes / concurrent invocations write to the same directory at
 * the same millisecond.
 */
async function atomicWriteFile(filePath, content, options = {}) {
    var _a, _b, _c;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${(0, crypto_1.randomUUID)()}.tmp`);
    const bytes = typeof content === 'string'
        ? Buffer.byteLength(content, (_a = options.encoding) !== null && _a !== void 0 ? _a : 'utf8')
        : content.byteLength;
    let handle;
    try {
        handle = await fs.promises.open(tmpPath, 'w', (_b = options.mode) !== null && _b !== void 0 ? _b : 0o644);
        if (typeof content === 'string') {
            await handle.writeFile(content, (_c = options.encoding) !== null && _c !== void 0 ? _c : 'utf8');
        }
        else {
            await handle.writeFile(content);
        }
        await handle.sync();
    }
    catch (err) {
        if (handle) {
            await handle.close().catch(() => { });
        }
        await fs.promises.unlink(tmpPath).catch(() => { });
        throw err;
    }
    finally {
        if (handle) {
            await handle.close().catch(() => { });
        }
    }
    await fs.promises.rename(tmpPath, filePath);
    return { path: filePath, bytes, tmpPath };
}
/**
 * Register a cleanup hook so .tmp files in the target directory are
 * removed on process exit / SIGINT / SIGTERM. Best-effort: this is a
 * safety net for crashes, not a replacement for try/catch in callers.
 */
function registerTmpCleanup(directory) {
    const cleanup = () => {
        try {
            const entries = fs.readdirSync(directory);
            for (const entry of entries) {
                if (entry.includes('.tmp')) {
                    try {
                        fs.unlinkSync(path.join(directory, entry));
                    }
                    catch { }
                }
            }
        }
        catch { }
    };
    const onExit = () => cleanup();
    const onSignal = (sig) => {
        cleanup();
        process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
    };
    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return () => {
        process.removeListener('exit', onExit);
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
    };
}
