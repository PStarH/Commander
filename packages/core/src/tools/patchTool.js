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
exports.ApplyPatchTool = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const sandboxedExec_1 = require("./sandboxedExec");
const logging_1 = require("../logging");
const fileSystemTool_1 = require("./fileSystemTool");
/** Reject paths containing shell metacharacters that could enable injection. */
const SHELL_UNSAFE_RE = /[;&|`$(){}[\]!#~<>*\n\t'"\\\x00-\x1f]/;
function assertShellSafePath(filePath, label) {
    if (SHELL_UNSAFE_RE.test(filePath)) {
        throw new Error(`${label} contains shell-unsafe characters: ${filePath}`);
    }
}
const DEFINITION = {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to a file. The patch must be in standard unified diff format (diff -u old new). Validates the patch before applying and returns the result. Use this for surgical code modifications.',
    inputSchema: {
        type: 'object',
        properties: {
            patch: { type: 'string', description: 'The unified diff content to apply' },
            targetFile: {
                type: 'string',
                description: 'File to patch (if the diff does not include the file path)',
            },
            validate: { type: 'boolean', description: 'Run validation after applying (default: true)' },
            verifyCommand: {
                type: 'string',
                description: 'Command to run for verification (e.g., "npm test", "python -m pytest")',
            },
        },
        required: ['patch'],
    },
    examples: [
        {
            name: 'apply_patch',
            arguments: {
                patch: '--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1,3 +1,4 @@\n-old line\n+new line',
                validate: true,
            },
        },
        { name: 'apply_patch', arguments: { patch: '...', verifyCommand: 'npm test' } },
    ],
    category: 'development',
};
class ApplyPatchTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = false;
        this.isReadOnly = false;
        this.timeout = 120000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e;
        const patchContent = String((_a = args.patch) !== null && _a !== void 0 ? _a : '');
        const targetFile = String((_b = args.targetFile) !== null && _b !== void 0 ? _b : '');
        const shouldValidate = args.validate !== false;
        const verifyCommand = String((_c = args.verifyCommand) !== null && _c !== void 0 ? _c : '');
        if (!patchContent)
            return 'Error: No patch content provided.';
        const cwd = process.cwd();
        const patchFile = path.join(cwd, `.tmp-patch-${Date.now()}.diff`);
        try {
            // Write patch to temp file
            fs.writeFileSync(patchFile, patchContent, 'utf-8');
            // Try to extract target file from patch header
            let fileToPatch = targetFile;
            if (!fileToPatch) {
                const headerMatch = patchContent.match(/^\+\+\+\s+(?:b\/)?(.+?)$/m);
                if (headerMatch)
                    fileToPatch = headerMatch[1].trim();
            }
            if (!fileToPatch) {
                return 'Error: Could not determine target file from patch. Specify targetFile or include path in diff header (--- a/... / +++ b/...).';
            }
            let targetPath;
            try {
                targetPath = (0, fileSystemTool_1.safePath)(fileToPatch);
            }
            catch {
                return `Error: Target file "${fileToPatch}" is outside the workspace.`;
            }
            if (!fs.existsSync(targetPath)) {
                return `Error: Target file not found: ${fileToPatch}. Searched at: ${targetPath}`;
            }
            assertShellSafePath(targetPath, 'targetPath');
            assertShellSafePath(patchFile, 'patchFile');
            const patchArgsList = [
                ['--forward', '--unified', targetPath, '-i', patchFile],
                ['-p1', '--forward', '--unified', targetPath, '-i', patchFile],
                ['-p0', '--forward', '--unified', targetPath, '-i', patchFile],
            ];
            let patchApplied = false;
            for (const args of patchArgsList) {
                try {
                    (0, child_process_1.execFileSync)('patch', args, {
                        cwd,
                        encoding: 'utf-8',
                        timeout: 30000,
                        stdio: ['pipe', 'pipe', 'pipe'],
                    });
                    patchApplied = true;
                    break;
                }
                catch {
                    /* try next variant */
                }
            }
            if (!patchApplied) {
                return `Error: Patch application failed. The patch format may be invalid or the file content has changed.\n\nPatch content:\n${patchContent.slice(0, 1000)}`;
            }
            const outputLines = [];
            outputLines.push(`Patch applied to: ${fileToPatch}`);
            // Validate if requested
            if (shouldValidate) {
                try {
                    // Try TypeScript validation
                    if (fileToPatch.endsWith('.ts')) {
                        const tscResult = await (0, sandboxedExec_1.execSandboxed)('npx tsc --noEmit 2>&1 || true', 30, cwd);
                        const tscOutput = tscResult.stdout || tscResult.stderr;
                        // Split once and reuse
                        const tscLines = tscOutput.split('\n');
                        const errors = tscLines.filter((l) => l.includes('error TS')).length;
                        if (errors > 0) {
                            outputLines.push(`\n⚠️  TypeScript errors after patch: ${errors}`);
                            outputLines.push(tscLines.slice(0, 10).join('\n'));
                        }
                        else {
                            outputLines.push('\n✅ TypeScript validation: clean');
                        }
                    }
                    // Run ESLint if available
                    if (fs.existsSync(path.join(cwd, '.eslintrc'))) {
                        const lintResult = await (0, sandboxedExec_1.execSandboxed)('npx eslint --quiet . 2>&1 || true', 30, cwd);
                        const lintOutput = lintResult.stdout || lintResult.stderr;
                        if (lintOutput.trim()) {
                            outputLines.push(`\n⚠️  Lint issues found:\n${lintOutput.slice(0, 1000)}`);
                        }
                    }
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('ApplyPatchTool', 'Validation step failed', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
            }
            // Run verification command if provided
            if (verifyCommand) {
                outputLines.push(`\nRunning verification: ${verifyCommand}`);
                try {
                    const verifyResult = await (0, sandboxedExec_1.execSandboxed)(verifyCommand, 60, cwd);
                    if (verifyResult.exitCode === 0) {
                        outputLines.push(`✅ Verification passed:\n${verifyResult.stdout.slice(0, 500)}`);
                    }
                    else {
                        const stderr = ((_d = verifyResult.stderr) === null || _d === void 0 ? void 0 : _d.slice(0, 1000)) || '';
                        const stdout = ((_e = verifyResult.stdout) === null || _e === void 0 ? void 0 : _e.slice(0, 1000)) || '';
                        outputLines.push(`❌ Verification failed:\n${stderr || stdout || 'Exit code ' + verifyResult.exitCode}`);
                        // Auto-revert on failure
                        try {
                            const revertRes = await (0, sandboxedExec_1.execSandboxed)(`git checkout -- "${fileToPatch}"`, 10, cwd);
                            if (revertRes.exitCode === 0) {
                                outputLines.push('\n↩️  Patch reverted automatically.');
                            }
                            else {
                                outputLines.push('\n⚠️  Could not auto-revert. Manual restore needed.');
                                (0, logging_1.getGlobalLogger)().warn('ApplyPatchTool', 'Auto-revert failed', {
                                    stderr: revertRes.stderr,
                                });
                            }
                        }
                        catch (e) {
                            outputLines.push('\n⚠️  Could not auto-revert. Manual restore needed.');
                            (0, logging_1.getGlobalLogger)().warn('ApplyPatchTool', 'Auto-revert exception', {
                                error: e === null || e === void 0 ? void 0 : e.message,
                            });
                        }
                    }
                }
                catch (err) {
                    outputLines.push(`❌ Verification error: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            return outputLines.join('\n');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Patch failed: ${msg.slice(0, 300)}`;
        }
        finally {
            try {
                fs.unlinkSync(patchFile);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('ApplyPatchTool', 'Temp patch cleanup failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
}
exports.ApplyPatchTool = ApplyPatchTool;
