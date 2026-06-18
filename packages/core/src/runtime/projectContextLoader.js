"use strict";
/**
 * Project Context Loader
 *
 * Loads project-specific instructions from well-known markdown files and
 * injects them into the stable system prompt. This is the Commander
 * equivalent of Claude Code's CLAUDE.md / Codex CLI's AGENTS.md mechanism.
 *
 * Supported files (highest precedence last):
 *   1. PROJECT.md  — project overview, conventions, standards
 *   2. CLAUDE.md   — Claude-style project context
 *   3. AGENTS.md   — agent-specific instructions (most specific)
 *
 * Higher-precedence files appear later in the injected block so their
 * instructions have stronger recency in the model's attention.
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
exports.loadProjectContext = loadProjectContext;
exports.buildProjectContextBlock = buildProjectContextBlock;
exports.computeProjectContextCacheKey = computeProjectContextCacheKey;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
/** Max size per file in bytes. Prevents one giant file from eating the context window. */
const MAX_FILE_BYTES = 50000;
/** Well-known project context files in ascending precedence. */
const CONTEXT_FILENAMES = ['PROJECT.md', 'CLAUDE.md', 'AGENTS.md'];
/**
 * Load project context from the given directory.
 *
 * @param projectPath Directory to scan. Defaults to process.cwd() for CLI usage.
 * @returns ProjectContext. If no files exist, content is empty and cacheKey is stable.
 */
function loadProjectContext(projectPath = process.cwd()) {
    const snapshots = [];
    for (const filename of CONTEXT_FILENAMES) {
        const filePath = path.resolve(projectPath, filename);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile())
                continue;
            const content = readFileWithCap(filePath);
            if (content.trim().length === 0)
                continue;
            snapshots.push({ filePath, mtimeMs: stat.mtimeMs, content });
        }
        catch (err) {
            // File does not exist or is unreadable — skip silently.
            const code = err.code;
            if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
                // Best-effort warning for unexpected errors; do not fail the run.
                // eslint-disable-next-line no-console
                console.warn(`[projectContextLoader] Could not read ${filePath}: ${err.message}`);
            }
        }
    }
    const filesRead = snapshots.map((s) => s.filePath);
    const content = snapshots.length > 0
        ? snapshots.map((s) => `<!-- ${path.basename(s.filePath)} -->\n${s.content}`).join('\n\n')
        : '';
    const cacheKey = computeCacheKey(snapshots);
    return { filesRead, content, cacheKey };
}
/**
 * Build the `<project_context>` block for injection into the system prompt.
 * Returns an empty string if no project context files were found.
 */
function buildProjectContextBlock(ctx) {
    if (!ctx.content || ctx.filesRead.length === 0)
        return '';
    return [
        '<project_context>',
        '## Project Context',
        `The following instructions come from: ${ctx.filesRead.map((p) => path.basename(p)).join(', ')}`,
        '',
        ctx.content,
        '</project_context>',
    ].join('\n');
}
/**
 * Compute a deterministic cache key from file snapshots.
 * Key changes when any file is added, removed, or modified.
 */
function computeProjectContextCacheKey(snapshots) {
    return computeCacheKey(snapshots);
}
// ── internal helpers ──
function readFileWithCap(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        const toRead = Math.min(stat.size, MAX_FILE_BYTES);
        const buffer = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buffer, 0, toRead, 0);
        let raw = buffer.toString('utf8', 0, bytesRead);
        // If we truncated the file, drop the last potentially incomplete UTF-8 sequence
        // and any trailing partial line to avoid exposing a cut-off sentence.
        if (stat.size > MAX_FILE_BYTES) {
            raw = raw.replace(/[\uD800-\uDBFF]$/, '');
            const lastBreak = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r'));
            if (lastBreak > 0) {
                raw = raw.slice(0, lastBreak);
            }
        }
        return raw;
    }
    finally {
        fs.closeSync(fd);
    }
}
function computeCacheKey(snapshots) {
    const hash = crypto.createHash('sha256');
    for (const s of snapshots) {
        hash.update(path.basename(s.filePath));
        hash.update(String(s.mtimeMs));
    }
    // Include an explicit "no files" marker so empty contexts are also stable.
    if (snapshots.length === 0) {
        hash.update('__no_project_context__');
    }
    return hash.digest('hex');
}
