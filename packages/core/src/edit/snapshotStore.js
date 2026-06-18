"use strict";
/**
 * File Snapshot Store — tracks file content hashes and lines for hashline edit recovery.
 *
 * Inspired by oh-my-pi's file-snapshot-store. Each file_read mints a snapshot
 * that the edit tool later validates against. If the file changed between read
 * and edit, the stale hash is detected BEFORE corruption occurs.
 *
 * Hash: 4-hex xxHash32 fingerprint of normalized file content.
 * Lines: stored for stale-anchor recovery (recomputing line numbers after drift).
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
exports.SnapshotStore = void 0;
exports.computeFileHash = computeFileHash;
exports.getSnapshotStore = getSnapshotStore;
exports.resetSnapshotStore = resetSnapshotStore;
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
// ============================================================================
// Hash computation
// ============================================================================
/** Number of hex characters in the content hash */
const HASH_LENGTH = 4;
/**
 * Normalize text before hashing: trim trailing whitespace from every line
 * so CRLF endings and display-trimmed lines do not invalidate a tag.
 */
function normalizeForHash(text) {
    return text.replace(/[ \t\r]+(?=\n|$)/g, '');
}
/**
 * Compute a 4-hex content hash for a file.
 * Uses Node.js crypto (xxHash not available natively, so we use SHA-256 truncated).
 * The hash is deterministic for identical normalized content.
 */
function computeFileHash(text) {
    const normalized = normalizeForHash(text);
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    // Take first 4 hex chars, uppercase
    return hash.slice(0, HASH_LENGTH).toUpperCase();
}
// ============================================================================
// Snapshot Store
// ============================================================================
/**
 * Per-session file snapshot store.
 * Keyed by resolved file path. Each read mints a fresh snapshot.
 */
class SnapshotStore {
    constructor() {
        this.snapshots = new Map();
    }
    /**
     * Record a snapshot for a file. Called after every successful file_read.
     */
    record(filePath, content) {
        const lines = content.split('\n');
        const hash = computeFileHash(content);
        this.snapshots.set(filePath, { hash, lines, timestamp: Date.now() });
    }
    /**
     * Get the snapshot for a file, if one exists.
     */
    get(filePath) {
        return this.snapshots.get(filePath);
    }
    /**
     * Get the hash for a file, or undefined if not read yet.
     */
    getHash(filePath) {
        var _a;
        return (_a = this.snapshots.get(filePath)) === null || _a === void 0 ? void 0 : _a.hash;
    }
    /**
     * Validate that a file's current content matches the expected hash.
     * Returns true if the hash matches (file unchanged since read).
     */
    validateHash(filePath, expectedHash) {
        const snapshot = this.snapshots.get(filePath);
        if (!snapshot)
            return false;
        return snapshot.hash === expectedHash;
    }
    /**
     * Read a file and compute its current hash.
     * Used for validation when the snapshot might be stale.
     */
    computeCurrentHash(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return computeFileHash(content);
        }
        catch {
            return null;
        }
    }
    /**
     * Validate a hashline edit against the current file state.
     * Returns { valid, currentHash, message }.
     */
    validateEdit(filePath, expectedHash) {
        const currentHash = this.computeCurrentHash(filePath);
        if (currentHash === null) {
            return { valid: false, currentHash: null, message: `File not found: ${filePath}` };
        }
        if (currentHash === expectedHash) {
            return { valid: true, currentHash };
        }
        return {
            valid: false,
            currentHash,
            message: `Stale hash for ${filePath}: expected ${expectedHash}, got ${currentHash}. File changed since last read. Re-read the file before editing.`,
        };
    }
    /**
     * Clear all snapshots (e.g., on session reset).
     */
    clear() {
        this.snapshots.clear();
    }
    /**
     * Get snapshot count (for diagnostics).
     */
    get size() {
        return this.snapshots.size;
    }
}
exports.SnapshotStore = SnapshotStore;
// ============================================================================
// Global singleton
// ============================================================================
let globalSnapshotStore = null;
function getSnapshotStore() {
    if (!globalSnapshotStore) {
        globalSnapshotStore = new SnapshotStore();
    }
    return globalSnapshotStore;
}
function resetSnapshotStore() {
    globalSnapshotStore = null;
}
