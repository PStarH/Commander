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
exports.GlobTool = exports.FileListTool = exports.FileSearchTool = exports.FileEditTool = exports.FileWriteTool = exports.FileReadTool = void 0;
exports.getSafeRoot = getSafeRoot;
exports.isWithinRoot = isWithinRoot;
exports.safePath = safePath;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const snapshotStore_1 = require("../edit/snapshotStore");
const hashline_1 = require("../edit/hashline");
const hashAnchoredEditor_1 = require("../edit/hashAnchoredEditor");
const internalUrls_1 = require("../runtime/internalUrls");
const atomicWrite_1 = require("./_utils/atomicWrite");
/** Get the safe root directory. Dynamic to support runtime COMMANDER_WORKSPACE changes. */
function getSafeRoot() {
    return path.resolve(process.env.COMMANDER_WORKSPACE || process.cwd());
}
/** Check that a resolved path is within SAFE_ROOT (prevents prefix collision like workspace-evil). */
function isWithinRoot(resolved, root) {
    return resolved === root || resolved.startsWith(root + path.sep);
}
/**
 * Resolve a user-provided path relative to the safe workspace root.
 * Rejects paths that resolve outside the workspace, including symlink-based traversal.
 * Re-exports for use by other tools (patchTool, multimodal tools).
 */
function safePath(target) {
    const resolved = path.resolve(getSafeRoot(), target);
    // Resolve symlinks for the resolved path (e.g., /tmp -> /private/tmp on macOS)
    let resolvedReal;
    try {
        resolvedReal = fs.realpathSync(resolved);
    }
    catch {
        // File doesn't exist yet — resolve the parent directory
        let parent = path.dirname(resolved);
        while (parent !== '/' && !fs.existsSync(parent)) {
            parent = path.dirname(parent);
        }
        try {
            resolvedReal = fs.realpathSync(parent) + resolved.slice(parent.length);
        }
        catch {
            resolvedReal = resolved;
        }
    }
    if (!isWithinRoot(resolvedReal, getSafeRoot())) {
        throw new Error(`Access denied: path "${target}" is outside workspace`);
    }
    // GAP-15: Resolve symlinks to prevent traversal bypass.
    try {
        const real = fs.realpathSync(resolved);
        if (!isWithinRoot(real, getSafeRoot())) {
            throw new Error(`Access denied: symlink "${target}" points outside workspace`);
        }
        return real;
    }
    catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            let ancestor = path.dirname(resolved);
            while (ancestor !== getSafeRoot() && !fs.existsSync(ancestor)) {
                ancestor = path.dirname(ancestor);
            }
            try {
                const realAncestor = fs.realpathSync(ancestor);
                if (!isWithinRoot(realAncestor, getSafeRoot())) {
                    throw new Error(`Access denied: ancestor of "${target}" is outside workspace`);
                }
            }
            catch (e) {
                if (e instanceof Error && e.message.startsWith('Access denied'))
                    throw e;
                if (!isWithinRoot(resolved, getSafeRoot()))
                    throw new Error(`Access denied: path "${target}" is outside workspace`);
            }
            return resolved;
        }
        throw err;
    }
}
// ============================================================================
// FileReadTool — with hashline snapshot tracking
// ============================================================================
class FileReadTool {
    constructor() {
        this.definition = {
            name: 'file_read',
            description: 'Read a file. Returns content with line numbers in hashline format (¶path#HASH followed by LINE:content). Set includeHashes:true to get per-line content hashes (#XXXXXX) for drift-proof hash-anchored edits with file_hash_edit.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file (relative to workspace)' },
                    maxChars: {
                        type: 'number',
                        description: 'Maximum characters to return (default: 10000)',
                        default: 10000,
                    },
                    offset: { type: 'number', description: 'Start at this line number (1-indexed)' },
                    limit: { type: 'number', description: 'Maximum number of lines to return' },
                    includeHashes: {
                        type: 'boolean',
                        description: 'Include per-line content hashes (#XXXXXX) for hash-anchored edits (default: false)',
                        default: false,
                    },
                },
                required: ['path'],
            },
            examples: [
                { name: 'file_read', arguments: { path: 'package.json' } },
                { name: 'file_read', arguments: { path: 'src/index.ts', offset: 10, limit: 30 } },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a;
        const filePath = String((_a = args.path) !== null && _a !== void 0 ? _a : '');
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 10000, 1), 100000);
        const offset = Math.max(Number(args.offset) || 1, 1);
        const limit = args.limit ? Math.max(Number(args.limit), 1) : undefined;
        const includeHashes = args.includeHashes === true;
        if (!filePath)
            return 'Error: path is required';
        // ── Internal URL Protocol ──
        // Handle internal URLs like checkpoint://, memory://, skill://, agent://
        if ((0, internalUrls_1.isInternalUrl)(filePath)) {
            const router = (0, internalUrls_1.getInternalUrlRouter)();
            const result = await router.resolve(filePath);
            if (result) {
                const content = result.content;
                if (content.length > maxChars) {
                    return (content.slice(0, maxChars) + `\n\n...[truncated ${content.length - maxChars} chars]`);
                }
                return content;
            }
            return `Error: Unknown internal URL protocol: ${filePath}`;
        }
        try {
            const resolved = safePath(filePath);
            if (!fs.existsSync(resolved))
                return `Error: file not found: ${filePath}`;
            const stat = fs.statSync(resolved);
            if (stat.size > 1024 * 1024)
                return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: 1MB`;
            const content = fs.readFileSync(resolved, 'utf-8');
            // Record snapshot for hashline edit recovery
            const store = (0, snapshotStore_1.getSnapshotStore)();
            store.record(resolved, content);
            // Compute hash
            const hash = (0, snapshotStore_1.computeFileHash)(content);
            // Format with hashline header + line numbers
            const allLines = content.split('\n');
            const startIdx = offset - 1; // 0-indexed
            const endIdx = limit ? Math.min(startIdx + limit, allLines.length) : allLines.length;
            const displayLines = allLines.slice(startIdx, endIdx);
            // Format output: use anchored format if hashes requested, otherwise plain hashline
            if (includeHashes) {
                const result = (0, hashAnchoredEditor_1.formatAnchoredOutput)(filePath, content, { offset, limit, maxChars });
                return result;
            }
            // Build header
            const header = (0, hashline_1.formatHashlineHeader)(filePath, hash);
            // Build numbered lines
            const numberedLines = displayLines.map((line, i) => `${startIdx + i + 1}:${line}`).join('\n');
            // Add truncation info
            let truncationInfo = '';
            if (startIdx > 0 || endIdx < allLines.length) {
                truncationInfo = `\n[Showing lines ${startIdx + 1}-${endIdx} of ${allLines.length}]`;
                if (endIdx < allLines.length) {
                    truncationInfo += ` | Use offset=${endIdx + 1} for more`;
                }
            }
            const result = `${header}\n${numberedLines}${truncationInfo}`;
            if (result.length > maxChars) {
                return result.slice(0, maxChars) + `\n\n...[truncated ${result.length - maxChars} chars]`;
            }
            return result;
        }
        catch (err) {
            return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.FileReadTool = FileReadTool;
// ============================================================================
// FileWriteTool — unchanged (creates new files, no hashline needed)
// ============================================================================
class FileWriteTool {
    constructor() {
        this.definition = {
            name: 'file_write',
            description: 'Write content to a file. Creates the file if it does not exist. Overwrites existing content.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to the file (relative to workspace)' },
                    content: { type: 'string', description: 'Content to write' },
                },
                required: ['path', 'content'],
            },
            examples: [
                { name: 'file_write', arguments: { path: 'output.txt', content: 'Hello, world!' } },
                { name: 'file_write', arguments: { path: 'src/config.json', content: '{"debug": true}' } },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a, _b;
        const filePath = String((_a = args.path) !== null && _a !== void 0 ? _a : '');
        const content = String((_b = args.content) !== null && _b !== void 0 ? _b : '');
        if (!filePath)
            return 'Error: path is required';
        if (content.length > 10 * 1024 * 1024)
            return `Error: content too large (${(content.length / 1024 / 1024).toFixed(1)}MB). Max: 10MB`;
        try {
            const resolved = safePath(filePath);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            await (0, atomicWrite_1.atomicWriteFile)(resolved, content, { encoding: 'utf-8' });
            (0, snapshotStore_1.getSnapshotStore)().record(resolved, content);
            return `Written ${content.length} bytes to ${filePath}`;
        }
        catch (err) {
            return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.FileWriteTool = FileWriteTool;
// ============================================================================
// FileEditTool — supports both hashline and legacy string replacement
// ============================================================================
class FileEditTool {
    constructor() {
        this.definition = {
            name: 'file_edit',
            description: `Edit a file. Supports two modes:

HASHLINE MODE (preferred): Use the hashline format from file_read output.
The input starts with ¶PATH#TAG (the tag from your read output), followed by operations:
  ¶src/foo.ts#A1B2
  replace 3..5:
  +new line 3
  +new line 4
  +new line 5

Operations: replace N..M:, delete N..M, insert before/after N:, insert head/tail:
Body rows start with + (only +TEXT, no -old lines).
The tag ensures the file hasn't changed since you read it.

LEGACY MODE (backward-compatible): Use path + oldString + newString for simple string replacement.`,
            inputSchema: {
                type: 'object',
                properties: {
                    input: {
                        type: 'string',
                        description: 'Hashline-format edit (starts with ¶PATH#TAG). Preferred mode.',
                    },
                    path: {
                        type: 'string',
                        description: 'Path to the file (legacy mode, relative to workspace)',
                    },
                    oldString: {
                        type: 'string',
                        description: 'Text to replace (legacy mode, must exist in file)',
                    },
                    newString: { type: 'string', description: 'Replacement text (legacy mode)' },
                },
                required: [],
            },
            examples: [
                // Hashline example
                {
                    name: 'file_edit',
                    arguments: { input: '¶src/config.ts#A1B2\nreplace 3..3:\n+  port: 8080' },
                },
                // Legacy example
                {
                    name: 'file_edit',
                    arguments: { path: 'src/config.ts', oldString: 'port: 3000', newString: 'port: 8080' },
                },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a;
        const input = String((_a = args.input) !== null && _a !== void 0 ? _a : '');
        // Detect mode: hashline or legacy
        if (input && (0, hashline_1.isHashlineFormat)(input)) {
            return this.executeHashline(input);
        }
        // Legacy mode
        return this.executeLegacy(args);
    }
    /**
     * Hashline mode: parse and apply hashline edits.
     */
    async executeHashline(input) {
        const parsed = (0, hashline_1.parseHashline)(input);
        if (parsed.errors.length > 0) {
            return `Hashline parse errors:\n${parsed.errors.join('\n')}`;
        }
        if (parsed.sections.length === 0) {
            return 'Error: No valid hashline sections found in input';
        }
        const results = [];
        for (const section of parsed.sections) {
            try {
                // Resolve file path
                const resolved = safePath(section.filePath);
                section.filePath = resolved;
                const result = (0, hashline_1.applyHashlineSection)(section);
                if (result.success) {
                    let msg = `Updated ${section.filePath}`;
                    if (result.replacements)
                        msg += ` (${result.replacements} operation(s))`;
                    if (result.newHash)
                        msg += ` [hash: ${result.newHash}]`;
                    if (result.warnings && result.warnings.length > 0) {
                        msg += `\nWarnings:\n${result.warnings.join('\n')}`;
                    }
                    results.push(msg);
                }
                else {
                    results.push(`Error editing ${section.filePath}: ${result.error}`);
                }
            }
            catch (err) {
                results.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return results.join('\n');
    }
    /**
     * Legacy mode: exact string replacement (backward-compatible).
     */
    async executeLegacy(args) {
        var _a, _b, _c;
        const filePath = String((_a = args.path) !== null && _a !== void 0 ? _a : '');
        const oldStr = String((_b = args.oldString) !== null && _b !== void 0 ? _b : '');
        const newStr = String((_c = args.newString) !== null && _c !== void 0 ? _c : '');
        if (!filePath || !oldStr)
            return 'Error: path and oldString are required (or use hashline mode with input)';
        try {
            const resolved = safePath(filePath);
            if (!fs.existsSync(resolved))
                return `Error: file not found: ${filePath}`;
            let content = fs.readFileSync(resolved, 'utf-8');
            const idx = content.indexOf(oldStr);
            if (idx === -1)
                return `Error: oldString not found in ${filePath}`;
            const occurrences = content.split(oldStr).length - 1;
            content = content.split(oldStr).join(newStr);
            await (0, atomicWrite_1.atomicWriteFile)(resolved, content, { encoding: 'utf-8' });
            // Update snapshot
            (0, snapshotStore_1.getSnapshotStore)().record(resolved, content);
            return `Edited ${filePath}: replaced ${occurrences} occurrence(s) of "${oldStr.slice(0, 50)}..." with "${newStr.slice(0, 50)}..."`;
        }
        catch (err) {
            return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.FileEditTool = FileEditTool;
// ============================================================================
// FileSearchTool — unchanged
// ============================================================================
class FileSearchTool {
    constructor() {
        this.definition = {
            name: 'file_search',
            description: 'Search for files matching a pattern. Uses glob patterns. Returns matching file paths.',
            inputSchema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")' },
                    maxResults: { type: 'number', description: 'Maximum results (default: 20)', default: 20 },
                },
                required: ['pattern'],
            },
            examples: [
                { name: 'file_search', arguments: { pattern: 'src/**/*.ts' } },
                { name: 'file_search', arguments: { pattern: '**/*.json', maxResults: 5 } },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a;
        const pattern = String((_a = args.pattern) !== null && _a !== void 0 ? _a : '');
        const maxResults = Math.min(Math.max(Number(args.maxResults) || 20, 1), 100);
        if (!pattern)
            return 'Error: pattern is required';
        try {
            const files = this.globSearch(pattern, getSafeRoot()).slice(0, maxResults);
            if (files.length === 0)
                return `No files matching "${pattern}"`;
            return files.map((f, i) => `[${i + 1}] ${f}`).join('\n');
        }
        catch (err) {
            return `Error searching files: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
    globSearch(pattern, root) {
        const results = [];
        const parts = pattern.split('/');
        const filePattern = parts.pop() || '';
        const dirPattern = parts.join('/');
        let searchDir;
        let deep = false; // Whether to recurse into subdirectories
        if (dirPattern) {
            // Handle ** at the end of the directory pattern (e.g., "src/**" or "**")
            if (dirPattern.endsWith('/**') || dirPattern === '**') {
                const baseDir = dirPattern === '**' ? '' : dirPattern.replace('/**', '');
                searchDir = baseDir ? path.resolve(root, baseDir) : root;
                deep = true;
            }
            else {
                searchDir = path.resolve(root, dirPattern);
            }
            if (!isWithinRoot(searchDir, getSafeRoot()))
                return [];
        }
        else {
            searchDir = root;
        }
        if (!fs.existsSync(searchDir))
            return [];
        if (deep) {
            this.globRecurseDeep(searchDir, root, filePattern, results);
        }
        else {
            this.globRecurse(searchDir, root, filePattern, results);
        }
        return results;
    }
    globRecurse(dir, root, filePattern, results) {
        if (!fs.existsSync(dir))
            return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(root, fullPath);
                if (entry.isDirectory()) {
                    // For simple patterns like *.ts, do not recurse — * should not match /
                }
                else if (entry.isFile() && this.matchGlob(entry.name, filePattern)) {
                    results.push(relPath);
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('FileSystemTool', 'Directory scan failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    /** Recursive version used when the pattern contains ** — recurses into all subdirectories */
    globRecurseDeep(dir, root, filePattern, results) {
        if (!fs.existsSync(dir))
            return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPath = path.relative(root, fullPath);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules')
                        continue;
                    this.globRecurseDeep(fullPath, root, filePattern, results);
                }
                else if (entry.isFile() && this.matchGlob(entry.name, filePattern)) {
                    results.push(relPath);
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('FileSystemTool', 'Directory scan failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    matchGlob(name, pattern) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('^' + escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
        return regex.test(name);
    }
}
exports.FileSearchTool = FileSearchTool;
// ============================================================================
// FileListTool — unchanged
// ============================================================================
class FileListTool {
    constructor() {
        this.definition = {
            name: 'file_list',
            description: 'List files and directories in a directory. Returns entries with type.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path (relative to workspace, default: ".")',
                        default: '.',
                    },
                },
            },
            examples: [
                { name: 'file_list', arguments: { path: '.' } },
                { name: 'file_list', arguments: { path: 'src' } },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a;
        const dirPath = String((_a = args.path) !== null && _a !== void 0 ? _a : '.');
        try {
            const resolved = safePath(dirPath);
            if (!fs.existsSync(resolved))
                return `Error: directory not found: ${dirPath}`;
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            return entries
                .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
                .join('\n');
        }
        catch (err) {
            return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
}
exports.FileListTool = FileListTool;
// ============================================================================
// GlobTool — unchanged
// ============================================================================
class GlobTool {
    constructor() {
        this.definition = {
            name: 'glob',
            description: 'Find files matching a glob pattern. Searches by filename/path, not content. Use for: finding files by extension (**/*.ts), locating specific files (src/**/index.ts), discovering project structure. Use code_search to search inside files.',
            inputSchema: {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.{ts,tsx}", "package.json")',
                    },
                    path: {
                        type: 'string',
                        description: 'Directory to search in (default: workspace root)',
                        default: '.',
                    },
                    maxResults: { type: 'number', description: 'Maximum results (default: 50)', default: 50 },
                },
                required: ['pattern'],
            },
            examples: [
                { name: 'glob', arguments: { pattern: '**/*.ts' } },
                { name: 'glob', arguments: { pattern: 'src/**/*.{ts,tsx}', maxResults: 20 } },
            ],
            category: 'filesystem',
        };
    }
    async execute(args) {
        var _a, _b;
        const pattern = String((_a = args.pattern) !== null && _a !== void 0 ? _a : '');
        const searchPath = String((_b = args.path) !== null && _b !== void 0 ? _b : '.');
        const maxResults = Math.min(Math.max(Number(args.maxResults) || 50, 1), 200);
        if (!pattern)
            return 'Error: pattern is required';
        try {
            const rootDir = safePath(searchPath);
            if (!fs.existsSync(rootDir))
                return `Error: directory not found: ${searchPath}`;
            const files = this.globFind(rootDir, pattern, maxResults);
            if (files.length === 0)
                return `No files matching "${pattern}" in ${searchPath}`;
            const truncated = files.length >= maxResults ? `\n... (showing first ${maxResults})` : '';
            return `Found ${files.length} file(s):\n${files.join('\n')}${truncated}`;
        }
        catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
    }
    globFind(rootDir, pattern, maxResults) {
        const results = [];
        const parts = pattern.split('/');
        const filePattern = parts.pop() || '*';
        const dirPrefix = parts.join('/');
        let searchDir = rootDir;
        if (dirPrefix) {
            if (dirPrefix === '**') {
                searchDir = rootDir;
            }
            else {
                const resolved = path.resolve(rootDir, dirPrefix);
                if (!isWithinRoot(resolved, getSafeRoot()))
                    return [];
                searchDir = resolved;
            }
        }
        this.recurse(searchDir, rootDir, filePattern, dirPrefix === '**', results, maxResults);
        return results;
    }
    recurse(dir, root, filePattern, deep, results, limit) {
        if (results.length >= limit)
            return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= limit)
                    return;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
                        continue;
                    if (deep || this.matchGlob(entry.name, filePattern)) {
                        this.recurse(fullPath, root, filePattern, deep, results, limit);
                    }
                }
                else if (entry.isFile()) {
                    if (this.matchGlob(entry.name, filePattern)) {
                        results.push(path.relative(root, fullPath));
                    }
                }
            }
        }
        catch {
            // Skip unreadable directories
        }
    }
    matchGlob(name, pattern) {
        const expanded = pattern.replace(/\{([^}]+)\}/g, (_, opts) => `(${opts
            .split(',')
            .map((o) => o.trim())
            .join('|')})`);
        const escaped = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const regexStr = '^' +
            escaped
                .replace(/\*\*/g, '{{DOUBLESTAR}}')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]')
                .replace(/\{\{DOUBLESTAR\}\}/g, '.*') +
            '$';
        try {
            return new RegExp(regexStr).test(name);
        }
        catch {
            return false;
        }
    }
}
exports.GlobTool = GlobTool;
