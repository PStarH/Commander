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
exports.LSPAttachTool = exports.LSPDiagnosticsTool = void 0;
exports.initLSP = initLSP;
exports.disconnectLSP = disconnectLSP;
exports.resetLSP = resetLSP;
exports.isLSPReady = isLSPReady;
exports.attachDiagnostics = attachDiagnostics;
exports.getFileDiagnostics = getFileDiagnostics;
exports.hasLSErrors = hasLSErrors;
exports.getLSErrorCount = getLSErrorCount;
exports.openLSEDocument = openLSEDocument;
/**
 * Language Server Protocol integration for real-time diagnostics.
 * Spawns LSP servers over stdin/stdout JSON-RPC for TypeScript/JavaScript.
 * Used to surface diagnostics, type checking, and code quality feedback.
 * This module bridges editor-style analysis into the agent runtime.
 * It supports on-demand inspection of source files during execution.
 * The goal is fast, localized feedback without leaving the workflow.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const logging_1 = require("../logging");
const fileSystemTool_1 = require("../tools/fileSystemTool");
class LSPClient {
    constructor(serverCommand, serverArgs = [], workspaceRoot = process.cwd()) {
        this.serverCommand = serverCommand;
        this.serverArgs = serverArgs;
        this.workspaceRoot = workspaceRoot;
        this.process = null;
        this.pendingRequests = new Map();
        this.diagnostics = new Map();
        this.messageId = 0;
        this.isConnected = false;
        // GAP-20: Bound diagnostics map to prevent unbounded memory growth
        this.MAX_DIAGNOSTIC_FILES = 500;
        this.MAX_DIAGNOSTICS_PER_FILE = 200;
        this.diagnosticsInsertOrder = [];
        // O(1) membership check alongside the insert-order array
        this.diagnosticsFileSet = new Set();
    }
    connect() {
        return new Promise((resolve, reject) => {
            var _a, _b, _c;
            this.process = (0, child_process_1.spawn)(this.serverCommand, this.serverArgs, {
                cwd: this.workspaceRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, NODE_ENV: 'development' },
            });
            // Guard against multiple resolve/reject calls (timeout + error + sendRequest can race)
            let settled = false;
            const settle = (fn) => {
                if (!settled) {
                    settled = true;
                    fn();
                }
            };
            const timeout = setTimeout(() => settle(() => {
                var _a;
                (_a = this.process) === null || _a === void 0 ? void 0 : _a.kill();
                this.process = null;
                reject(new Error('LSP connection timeout'));
            }), 10000);
            this.process.on('error', (err) => {
                settle(() => {
                    var _a;
                    clearTimeout(timeout);
                    (_a = this.process) === null || _a === void 0 ? void 0 : _a.kill();
                    this.process = null;
                    reject(new Error(`LSP process error: ${err.message}`));
                });
            });
            this.process.on('close', (code) => {
                this.isConnected = false;
                if (code !== 0 && code !== null) {
                    (0, logging_1.getGlobalLogger)().warn('LSP', 'Server exited with non-zero code', { code });
                }
            });
            let buffer = '';
            (_a = this.process.stdout) === null || _a === void 0 ? void 0 : _a.on('data', (chunk) => {
                var _a;
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
                for (const line of lines) {
                    if (line.trim())
                        this.handleMessage(line);
                }
            });
            (_b = this.process.stderr) === null || _b === void 0 ? void 0 : _b.on('data', (chunk) => {
                (0, logging_1.getGlobalLogger)().warn('LSP', 'stderr output', { output: chunk.toString().slice(0, 200) });
            });
            this.sendRequest('initialize', {
                processId: (_c = process.pid) !== null && _c !== void 0 ? _c : null,
                rootUri: `file://${this.workspaceRoot}`,
                capabilities: {
                    textDocument: {
                        synchronization: { didSave: true },
                    },
                    workspace: { applyEdit: false },
                },
            })
                .then(() => {
                settle(() => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    this.sendNotification('initialized', {});
                    resolve();
                });
            })
                .catch((e) => settle(() => reject(e)));
        });
    }
    disconnect() {
        if (this.process) {
            this.sendNotification('shutdown', {}).catch((e) => (0, logging_1.getGlobalLogger)().debug('LSP', 'shutdown error', { error: e === null || e === void 0 ? void 0 : e.message }));
            this.process.kill();
            this.process = null;
            this.isConnected = false;
            this.pendingRequests.clear();
        }
    }
    get isReady() {
        return this.isConnected;
    }
    getFileDiagnostics(filePath) {
        const normalized = path.resolve(filePath);
        return this.diagnostics.get(normalized) || [];
    }
    hasErrors(filePath) {
        return this.getFileDiagnostics(filePath).some((d) => d.severity === 1);
    }
    getErrorCount(filePath) {
        const diagnostics = this.getFileDiagnostics(filePath);
        return {
            errors: diagnostics.filter((d) => d.severity === 1).length,
            warnings: diagnostics.filter((d) => d.severity === 2 || d.severity === 3).length,
        };
    }
    attachToContent(content, filePath) {
        const diagnostics = this.getFileDiagnostics(filePath);
        if (diagnostics.length === 0)
            return content;
        const lines = content.split('\n');
        const errors = [];
        const warnings = [];
        for (const d of diagnostics) {
            const line = d.range.start.line;
            const col = d.range.start.character;
            const msg = d.message.slice(0, 80);
            if (d.severity === 1) {
                errors.push(`  Line ${line + 1}:${col} ERROR: ${msg}`);
            }
            else if (d.severity === 2) {
                warnings.push(`  Line ${line + 1}:${col} WARN: ${msg}`);
            }
        }
        const result = [content];
        if (errors.length > 0)
            result.push('\n--- LSP Errors ---');
        for (const e of errors.slice(0, 10))
            result.push(e);
        if (warnings.length > 0)
            result.push('\n--- LSP Warnings ---');
        for (const w of warnings.slice(0, 10))
            result.push(w);
        if (errors.length > 10)
            result.push(`  ... and ${errors.length - 10} more errors`);
        if (warnings.length > 10)
            result.push(`  ... and ${warnings.length - 10} more warnings`);
        return result.join('\n');
    }
    sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            var _a;
            if (!((_a = this.process) === null || _a === void 0 ? void 0 : _a.stdin)) {
                reject(new Error('LSP not connected'));
                return;
            }
            const id = this.messageId++;
            this.pendingRequests.set(id, { resolve, reject });
            const msg = { jsonrpc: '2.0', id, method, params };
            this.process.stdin.write(JSON.stringify(msg) + '\n');
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`LSP request ${method} timed out`));
                }
            }, 15000);
            if (typeof timer.unref === 'function')
                timer.unref();
        });
    }
    sendNotification(method, params) {
        var _a;
        if (!((_a = this.process) === null || _a === void 0 ? void 0 : _a.stdin))
            return Promise.resolve();
        const msg = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        return Promise.resolve();
    }
    handleMessage(line) {
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
                const { resolve, reject } = this.pendingRequests.get(msg.id);
                this.pendingRequests.delete(msg.id);
                if (msg.error)
                    reject(new Error(msg.error.message));
                else
                    resolve(msg.result);
            }
            if (msg.method === 'textDocument/publishDiagnostics') {
                const params = msg.params;
                const filePath = params.uri.replace('file://', '');
                // GAP-20: Bound diagnostics per file
                const diags = params.diagnostics.slice(0, this.MAX_DIAGNOSTICS_PER_FILE);
                // GAP-20: Evict oldest file entries when map grows too large
                if (!this.diagnostics.has(filePath) && this.diagnostics.size >= this.MAX_DIAGNOSTIC_FILES) {
                    const oldest = this.diagnosticsInsertOrder.shift();
                    if (oldest) {
                        this.diagnostics.delete(oldest);
                        this.diagnosticsFileSet.delete(oldest);
                    }
                }
                this.diagnostics.set(filePath, diags);
                if (!this.diagnosticsFileSet.has(filePath)) {
                    this.diagnosticsInsertOrder.push(filePath);
                    this.diagnosticsFileSet.add(filePath);
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('LSP', 'Failed to handle message', { error: e === null || e === void 0 ? void 0 : e.message });
        }
    }
    openDocument(filePath, content) {
        const text = content !== null && content !== void 0 ? content : (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
        this.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: `file://${filePath}`,
                languageId: this.getLanguageId(filePath),
                version: 1,
                text,
            },
        }).catch((e) => (0, logging_1.getGlobalLogger)().debug('LSP', 'didOpen error', { error: e === null || e === void 0 ? void 0 : e.message }));
    }
    getLanguageId(filePath) {
        var _a;
        const ext = path.extname(filePath).toLowerCase();
        const map = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.rs': 'rust',
            '.go': 'go',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.cs': 'csharp',
            '.rb': 'ruby',
            '.php': 'php',
            '.html': 'html',
            '.css': 'css',
            '.json': 'json',
            '.md': 'markdown',
            '.yaml': 'yaml',
            '.yml': 'yaml',
        };
        return (_a = map[ext]) !== null && _a !== void 0 ? _a : 'plaintext';
    }
}
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
let _lspConfig = null;
const lspClientSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => {
    if (!_lspConfig)
        throw new Error('LSP not initialized. Call initLSP() first.');
    return new LSPClient(_lspConfig.command, _lspConfig.args, _lspConfig.workspaceRoot);
}, {
    dispose: (client) => client.disconnect(),
});
let globalLSPEnabled = false;
function initLSP(serverCommand, serverArgs, workspaceRoot) {
    _lspConfig = {
        command: serverCommand,
        args: serverArgs,
        workspaceRoot: workspaceRoot !== null && workspaceRoot !== void 0 ? workspaceRoot : process.cwd(),
    };
    lspClientSingleton.reset();
    const client = lspClientSingleton.get();
    return client
        .connect()
        .then(() => {
        globalLSPEnabled = true;
    })
        .catch((e) => {
        (0, logging_1.getGlobalLogger)().debug('LSP', 'connect failed', { error: e === null || e === void 0 ? void 0 : e.message });
        return;
    });
}
function getLSPClient() {
    if (!_lspConfig)
        return null;
    try {
        return lspClientSingleton.get();
    }
    catch {
        return null;
    }
}
function disconnectLSP() {
    const client = getLSPClient();
    if (client)
        client.disconnect();
    lspClientSingleton.reset();
    globalLSPEnabled = false;
}
function resetLSP() {
    const client = getLSPClient();
    if (client)
        client.disconnect();
    lspClientSingleton.reset();
    globalLSPEnabled = false;
}
function isLSPReady() {
    var _a;
    const client = getLSPClient();
    return globalLSPEnabled && ((_a = client === null || client === void 0 ? void 0 : client.isReady) !== null && _a !== void 0 ? _a : false);
}
function attachDiagnostics(content, filePath) {
    var _a;
    const client = getLSPClient();
    return (_a = client === null || client === void 0 ? void 0 : client.attachToContent(content, filePath)) !== null && _a !== void 0 ? _a : content;
}
function getFileDiagnostics(filePath) {
    var _a;
    const client = getLSPClient();
    return (_a = client === null || client === void 0 ? void 0 : client.getFileDiagnostics(filePath)) !== null && _a !== void 0 ? _a : [];
}
function hasLSErrors(filePath) {
    var _a;
    const client = getLSPClient();
    return (_a = client === null || client === void 0 ? void 0 : client.hasErrors(filePath)) !== null && _a !== void 0 ? _a : false;
}
function getLSErrorCount(filePath) {
    var _a;
    const client = getLSPClient();
    return (_a = client === null || client === void 0 ? void 0 : client.getErrorCount(filePath)) !== null && _a !== void 0 ? _a : { errors: 0, warnings: 0 };
}
function openLSEDocument(filePath, content) {
    var _a;
    (_a = getLSPClient()) === null || _a === void 0 ? void 0 : _a.openDocument(filePath, content);
}
class LSPDiagnosticsTool {
    constructor() {
        this.definition = {
            name: 'lsp_diagnostics',
            description: 'Get LSP diagnostics for a file. Returns type errors, lint warnings, and compiler errors from the language server.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file' },
                },
                required: ['filePath'],
            },
        };
    }
    async execute(args) {
        var _a;
        const filePath = String((_a = args.filePath) !== null && _a !== void 0 ? _a : '');
        if (!filePath)
            return 'Error: filePath is required';
        // Validate workspace boundary
        try {
            (0, fileSystemTool_1.safePath)(filePath);
        }
        catch {
            return `Error: Access denied: filePath "${filePath}" is outside workspace`;
        }
        const diagnostics = getFileDiagnostics(filePath);
        if (diagnostics.length === 0) {
            return `No LSP diagnostics for "${filePath}"`;
        }
        const result = [`LSP Diagnostics for ${filePath}:`];
        for (const d of diagnostics) {
            const line = d.range.start.line + 1;
            const col = d.range.start.character + 1;
            const sev = d.severity === 1 ? 'ERROR' : d.severity === 2 ? 'WARNING' : 'INFO';
            const src = d.source ? `[${d.source}] ` : '';
            result.push(`  ${line}:${col} ${sev}: ${src}${d.message}`);
        }
        return result.join('\n');
    }
}
exports.LSPDiagnosticsTool = LSPDiagnosticsTool;
class LSPAttachTool {
    constructor() {
        this.definition = {
            name: 'lsp_attach',
            description: 'Attach LSP diagnostics to file content. Returns file content with inline diagnostics annotations.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path to the file' },
                },
                required: ['filePath'],
            },
        };
    }
    async execute(args) {
        var _a;
        const filePath = String((_a = args.filePath) !== null && _a !== void 0 ? _a : '');
        if (!filePath)
            return 'Error: filePath is required';
        // Validate workspace boundary
        let resolved;
        try {
            resolved = (0, fileSystemTool_1.safePath)(filePath);
        }
        catch {
            return `Error: Access denied: filePath "${filePath}" is outside workspace`;
        }
        if (!fs.existsSync(resolved))
            return `Error: file not found: ${filePath}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        const enriched = attachDiagnostics(content, filePath);
        return enriched;
    }
}
exports.LSPAttachTool = LSPAttachTool;
