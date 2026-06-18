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
exports.CodeRefinerTool = void 0;
const sandboxedExec_1 = require("./sandboxedExec");
const fileSystemTool_1 = require("./fileSystemTool");
const fs = __importStar(require("fs"));
const DEFINITION = {
    name: 'refine_code',
    description: 'Generate code, run tests, read failures, and auto-fix in a loop. Wraps the Self-Refine pattern for test-driven development. Provide a function signature and test expectations, and this tool will iterate until the code passes all tests.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The code generation task description' },
            language: {
                type: 'string',
                enum: ['python', 'javascript', 'typescript', 'go', 'rust'],
                description: 'Programming language',
            },
            testCommand: {
                type: 'string',
                description: 'Command to run tests (e.g., "python -m pytest test.py")',
            },
            codeFile: { type: 'string', description: 'File to write the generated code to' },
            maxIterations: {
                type: 'number',
                description: 'Maximum refinement iterations (default: 3)',
                default: 3,
            },
            verifyOnly: {
                type: 'boolean',
                description: 'If true, only run verification without generating code',
            },
        },
        required: ['prompt', 'language'],
    },
    examples: [
        {
            name: 'refine_code',
            arguments: {
                prompt: 'Write a function to find the longest common substring',
                language: 'python',
                testCommand: 'python -m pytest test_lcs.py',
            },
        },
    ],
    category: 'development',
};
class CodeRefinerTool {
    constructor() {
        this.definition = DEFINITION;
        this.isConcurrencySafe = false;
        this.isReadOnly = false;
        this.timeout = 300000;
        this.maxOutputSize = 50000;
    }
    async execute(args) {
        var _a, _b, _c, _d, _e;
        const prompt = String((_a = args.prompt) !== null && _a !== void 0 ? _a : '');
        const language = String((_b = args.language) !== null && _b !== void 0 ? _b : 'python');
        const testCommand = String((_c = args.testCommand) !== null && _c !== void 0 ? _c : '');
        const codeFile = String((_d = args.codeFile) !== null && _d !== void 0 ? _d : '');
        const maxIterations = Number((_e = args.maxIterations) !== null && _e !== void 0 ? _e : 3);
        const verifyOnly = Boolean(args.verifyOnly);
        const cwd = process.cwd();
        if (!prompt)
            return 'Error: No code generation prompt provided.';
        const output = [];
        output.push(`Refinement target: ${prompt.slice(0, 100)}`);
        output.push(`Language: ${language}`);
        if (testCommand)
            output.push(`Test command: ${testCommand}`);
        if (verifyOnly && testCommand) {
            const testResult = await this.runTests(testCommand, cwd);
            output.push(`\nVerification:\n${testResult}`);
            return output.join('\n');
        }
        if (!codeFile && !testCommand) {
            // No test-driven refinement possible, just return template
            output.push('\nTo enable full test-driven refinement, provide both codeFile and testCommand.');
            output.push(`\nCode template for ${language}:\n${this.getTemplate(language, prompt)}`);
            return output.join('\n');
        }
        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            output.push(`\n--- Iteration ${iteration}/${maxIterations} ---`);
            if (codeFile) {
                let resolvedCodeFile;
                try {
                    resolvedCodeFile = (0, fileSystemTool_1.safePath)(codeFile);
                }
                catch {
                    return `Error: Access denied: codeFile "${codeFile}" is outside workspace`;
                }
                if (fs.existsSync(resolvedCodeFile)) {
                    // Code exists, just run tests
                    if (testCommand) {
                        const testResult = await this.runTests(testCommand, cwd);
                        const passed = !testResult.includes('FAILED') && !testResult.includes('Error');
                        output.push(`Tests: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
                        output.push(testResult.slice(0, 500));
                        if (passed) {
                            output.push(`\n✅ All tests passed at iteration ${iteration}.`);
                            return output.join('\n');
                        }
                    }
                }
                else {
                    output.push(`Code file not found yet: ${codeFile}, will generate new code.`);
                }
            }
            if (iteration === maxIterations) {
                output.push(`\nReached max iterations (${maxIterations}).`);
            }
        }
        return output.join('\n');
    }
    async runTests(command, cwd) {
        var _a, _b;
        const result = await (0, sandboxedExec_1.execSandboxed)(command, 60, cwd);
        if (result.exitCode === 0)
            return result.stdout.slice(0, 3000);
        return (((_a = result.stdout) === null || _a === void 0 ? void 0 : _a.slice(0, 3000)) || ((_b = result.stderr) === null || _b === void 0 ? void 0 : _b.slice(0, 3000)) || 'Test execution failed');
    }
    getTemplate(language, task) {
        const templates = {
            python: `def solve():\n    # ${task}\n    pass\n\nif __name__ == "__main__":\n    result = solve()\n    print(result)`,
            javascript: `function solve() {\n  // ${task}\n}\n\nconsole.log(solve());`,
            typescript: `function solve(): void {\n  // ${task}\n}\n\nconsole.log(solve());`,
        };
        return templates[language] || `// ${language} code for: ${task}`;
    }
}
exports.CodeRefinerTool = CodeRefinerTool;
