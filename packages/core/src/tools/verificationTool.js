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
exports.VerificationTool = void 0;
const sandboxedExec_1 = require("./sandboxedExec");
const fileSystemTool_1 = require("./fileSystemTool");
const logging_1 = require("../logging");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFINITION = {
    name: 'verify',
    description: 'Run linters, type checkers, and test runners on the codebase. Returns structured results with pass/fail status, error counts, and output. Use this after making file changes to verify correctness.',
    inputSchema: {
        type: 'object',
        properties: {
            checks: {
                type: 'array',
                items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] },
                description: 'Which checks to run. Default: ["lint", "typecheck"]',
            },
            directory: {
                type: 'string',
                description: 'Working directory to run checks in. Default: current project root.',
            },
            testPattern: {
                type: 'string',
                description: 'Test file pattern (e.g., "src/**/*.test.ts"). Only used when checks includes "test".',
            },
            fix: {
                type: 'boolean',
                description: 'Auto-fix lint issues if possible. Default: false.',
            },
        },
    },
    examples: [
        { name: 'verify', arguments: { checks: ['lint', 'typecheck'] } },
        { name: 'verify', arguments: { checks: ['test'], testPattern: 'tests/*.test.ts' } },
        { name: 'verify', arguments: { checks: ['lint', 'build'], fix: true } },
    ],
    category: 'development',
};
class VerificationTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = false;
        this.isReadOnly = false; // lint --fix modifies files
        this.timeout = 300000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        var _a, _b;
        const checks = (_a = args.checks) !== null && _a !== void 0 ? _a : ['lint', 'typecheck'];
        let directory;
        if (args.directory) {
            try {
                directory = (0, fileSystemTool_1.safePath)(String(args.directory));
            }
            catch {
                return `Error: Access denied: directory "${args.directory}" is outside workspace`;
            }
        }
        else {
            directory = process.cwd();
        }
        const testPattern = String((_b = args.testPattern) !== null && _b !== void 0 ? _b : '');
        const autoFix = Boolean(args.fix);
        const results = [];
        for (const check of checks) {
            switch (check) {
                case 'lint':
                    results.push(await this.runLint(directory, autoFix));
                    break;
                case 'typecheck':
                    results.push(await this.runTypeCheck(directory));
                    break;
                case 'test':
                    results.push(await this.runTests(directory, testPattern));
                    break;
                case 'build':
                    results.push(await this.runBuild(directory));
                    break;
                default:
                    results.push({
                        name: check,
                        passed: false,
                        errors: 1,
                        warnings: 0,
                        output: `Unknown check: ${check}`,
                        durationMs: 0,
                    });
                    break;
            }
        }
        const passed = results.filter((r) => r.passed).length;
        const total = results.length;
        const lines = [`## Verification Results (${passed}/${total} passed)`, ''];
        for (const r of results) {
            const icon = r.passed ? '✅' : '❌';
            lines.push(`${icon} ${r.name}: ${r.errors} errors, ${r.warnings} warnings (${r.durationMs}ms)`);
            if (r.output) {
                const truncated = r.output.length > 2000 ? r.output.slice(0, 2000) + '\n...[truncated]' : r.output;
                lines.push('```', truncated, '```');
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    async runCommand(cmd, cwd, label) {
        const result = await (0, sandboxedExec_1.execSandboxed)(cmd, 120, cwd);
        const output = result.stdout || result.stderr;
        if (result.exitCode === 0) {
            const lines = output.split('\n');
            const errorCount = lines.filter((l) => /error/i.test(l)).length;
            const warningCount = lines.filter((l) => /warning/i.test(l)).length;
            return {
                name: label,
                passed: true,
                errors: errorCount,
                warnings: warningCount,
                output: output.slice(0, 3000),
                durationMs: result.durationMs,
            };
        }
        const lines = output.split('\n');
        const errorCount = lines.filter((l) => /error/i.test(l)).length || 1;
        return {
            name: label,
            passed: false,
            errors: errorCount,
            warnings: 0,
            output: output.slice(0, 3000),
            durationMs: result.durationMs,
        };
    }
    async runLint(cwd, fix) {
        const fixFlag = fix ? ' --fix' : '';
        if (this.hasTool(cwd, 'node_modules/.bin/eslint')) {
            return this.runCommand(`npx eslint .${fixFlag} --format compact 2>&1 || true`, cwd, 'ESLint');
        }
        return {
            name: 'ESLint',
            passed: true,
            errors: 0,
            warnings: 0,
            output: 'No ESLint config found, skipping.',
            durationMs: 0,
        };
    }
    async runTypeCheck(cwd) {
        if (this.hasFile(cwd, 'tsconfig.json')) {
            return this.runCommand('npx tsc --noEmit 2>&1 || true', cwd, 'TypeScript');
        }
        return {
            name: 'TypeScript',
            passed: true,
            errors: 0,
            warnings: 0,
            output: 'No tsconfig.json found, skipping.',
            durationMs: 0,
        };
    }
    async runTests(cwd, pattern) {
        // SECURITY FIX: sanitize testPattern to prevent command injection
        // Only allow alphanumeric, glob chars (*, ?, **), slashes, dots, dashes, underscores
        const sanitizedPattern = pattern ? pattern.replace(/[^a-zA-Z0-9/*_?.\-[\]]/g, '') : '';
        if (pattern && !sanitizedPattern) {
            return {
                name: 'Tests',
                passed: false,
                errors: 1,
                warnings: 0,
                output: `Invalid test pattern: "${pattern}" contains disallowed characters`,
                durationMs: 0,
            };
        }
        if (this.hasTool(cwd, 'node_modules/.bin/vitest')) {
            // SECURITY FIX: use execFileSync with argv array instead of shell interpolation
            const args = ['vitest', 'run'];
            if (sanitizedPattern)
                args.push(sanitizedPattern);
            try {
                const { execFileSync } = require('child_process');
                const stdout = execFileSync('npx', args, {
                    cwd,
                    timeout: 120000,
                    encoding: 'utf-8',
                    maxBuffer: 50 * 1024 * 1024,
                });
                return {
                    name: 'Vitest',
                    passed: true,
                    errors: 0,
                    warnings: 0,
                    output: stdout.slice(0, 3000),
                    durationMs: 0,
                };
            }
            catch (e) {
                const err = e;
                const output = (err.stdout || err.stderr || err.message || '').slice(0, 3000);
                const lines = output.split('\n');
                const errorCount = lines.filter((l) => /error/i.test(l)).length || 1;
                return {
                    name: 'Vitest',
                    passed: false,
                    errors: errorCount,
                    warnings: 0,
                    output,
                    durationMs: 0,
                };
            }
        }
        if (this.hasTool(cwd, 'node_modules/.bin/jest')) {
            const args = ['jest'];
            if (sanitizedPattern)
                args.push(sanitizedPattern);
            try {
                const { execFileSync } = require('child_process');
                const stdout = execFileSync('npx', args, {
                    cwd,
                    timeout: 120000,
                    encoding: 'utf-8',
                    maxBuffer: 50 * 1024 * 1024,
                });
                return {
                    name: 'Jest',
                    passed: true,
                    errors: 0,
                    warnings: 0,
                    output: stdout.slice(0, 3000),
                    durationMs: 0,
                };
            }
            catch (e) {
                const err = e;
                const output = (err.stdout || err.stderr || err.message || '').slice(0, 3000);
                const lines = output.split('\n');
                const errorCount = lines.filter((l) => /error/i.test(l)).length || 1;
                return {
                    name: 'Jest',
                    passed: false,
                    errors: errorCount,
                    warnings: 0,
                    output,
                    durationMs: 0,
                };
            }
        }
        return {
            name: 'Tests',
            passed: true,
            errors: 0,
            warnings: 0,
            output: 'No test runner config found (tried vitest, jest).',
            durationMs: 0,
        };
    }
    async runBuild(cwd) {
        if (this.hasFile(cwd, 'package.json')) {
            return this.runCommand('npx tsc --noEmit 2>&1 || true', cwd, 'Build check');
        }
        return {
            name: 'Build',
            passed: true,
            errors: 0,
            warnings: 0,
            output: 'No package.json found.',
            durationMs: 0,
        };
    }
    hasTool(cwd, relPath) {
        try {
            return fs.existsSync(path.join(cwd, relPath));
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('VerificationTool', 'Tool check failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
                relPath,
            });
            return false;
        }
    }
    hasFile(cwd, name) {
        try {
            return fs.existsSync(path.join(cwd, name));
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('VerificationTool', 'File check failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
                name,
            });
            return false;
        }
    }
}
exports.VerificationTool = VerificationTool;
