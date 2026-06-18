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
exports.DriveOrchestrator = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const types_1 = require("./types");
const messageBus_1 = require("../runtime/messageBus");
const logging_1 = require("../logging");
const structuredOutput_1 = require("../runtime/structuredOutput");
const llmJsonExtractor_1 = require("../runtime/llmJsonExtractor");
const PLAN_PROMPT = `You are a Drive Planner. Break the following goal into a sequence of concrete, actionable steps.

Each step must be:
- Specific: a single unit of work
- Achievable: can be completed in one execution pass
- Verifiable: success/failure is clear

Output ONLY valid JSON with no markdown formatting:

{
  "steps": [
    { "description": "Step 1: what to do" },
    { "description": "Step 2: what to do" }
  ],
  "reasoning": "why this plan"
}`;
const REPLAN_PROMPT = `You are a Drive Replanner. The following steps failed or are blocked. Re-plan the remaining work.

Failed steps show errors. Pending steps haven't been attempted yet.
Output a revised plan for the remaining work.

Output ONLY valid JSON with no markdown formatting:

{
  "steps": [
    { "description": "Revised step 1" },
    { "description": "Revised step 2" }
  ],
  "reasoning": "why this revised plan"
}`;
const WORKER_PROMPT = `You are a Drive Worker Agent. You have access to tools for file system operations, command execution, and web search.

Execute the assigned step thoroughly. Make real changes to the codebase or system as needed.
Provide a clear summary of what was done.`;
let stepCounter = 0;
function generateStepId() {
    return `step_${Date.now()}_${++stepCounter}`;
}
class DriveOrchestrator {
    constructor(provider, runtime, config) {
        var _a;
        this.provider = provider;
        this.runtime = runtime !== null && runtime !== void 0 ? runtime : null;
        this.config = { ...types_1.DEFAULT_DRIVE_CONFIG, ...config };
        this.model = (_a = this.config.model) !== null && _a !== void 0 ? _a : 'gpt-4o-mini';
        this.resetState('', 0);
        fs.mkdirSync(this.config.checkpointDir, { recursive: true });
    }
    async execute(goal) {
        var _a, _b, _c;
        const bus = (0, messageBus_1.getMessageBus)();
        const startTime = Date.now();
        let totalTokensUsed = 0;
        bus.publish('drive.started', 'drive-orch', { goal, mode: this.config.mode });
        // Check for existing checkpoint
        const checkpoint = this.loadCheckpoint(goal);
        if (checkpoint) {
            this.state = checkpoint;
            if (this.config.verbose) {
                (0, logging_1.getGlobalLogger)().info('DriveOrchestrator', `Resumed from checkpoint: ${this.state.steps.filter((s) => s.status === 'completed').length}/${this.state.steps.length} steps done`);
            }
        }
        else {
            // Plan: decompose goal into steps
            const plan = await this.planGoal(goal);
            if (!plan) {
                return this.buildResult(goal, 'failed', startTime, totalTokensUsed, []);
            }
            totalTokensUsed += plan.tokens;
            this.resetState(goal, startTime);
            this.state.steps = plan.data.steps.map((s) => ({
                id: generateStepId(),
                description: s.description,
                status: 'pending',
                retryCount: 0,
                maxRetries: 3,
            }));
            this.saveCheckpoint();
        }
        // Execution loop
        let iteration = 0;
        const maxIterations = this.config.maxIterations;
        while (iteration < maxIterations) {
            iteration++;
            this.state.iteration = iteration;
            const allDone = this.state.steps.every((s) => s.status === 'completed');
            if (allDone)
                break;
            const hasBlocked = this.state.steps.some((s) => s.status === 'blocked');
            if (hasBlocked && iteration > 1) {
                // Re-plan remaining steps
                const replanResult = await this.replan();
                if (replanResult) {
                    totalTokensUsed += replanResult.tokens;
                    this.saveCheckpoint();
                }
            }
            // Find next step to execute (pending or failed with retries left)
            const step = this.state.steps.find((s) => s.status === 'pending' || (s.status === 'failed' && s.retryCount < s.maxRetries));
            if (!step) {
                // May have all completed, or all blocked
                break;
            }
            // Execute step
            step.status = 'running';
            bus.publish('drive.step_started', 'drive-orch', {
                stepId: step.id,
                description: step.description,
            });
            if (this.runtime) {
                // Execute with real tool access via AgentRuntimeInterface
                const agentResult = await this.executeWithRuntime(step, goal);
                if (agentResult) {
                    step.agentResult = agentResult;
                    totalTokensUsed += agentResult.totalTokenUsage.totalTokens;
                    if (agentResult.status === 'success') {
                        step.status = 'completed';
                        step.result = agentResult.summary.slice(0, 2000);
                    }
                    else {
                        step.status = 'failed';
                        step.error = (_a = agentResult.error) !== null && _a !== void 0 ? _a : 'Execution failed';
                        step.retryCount++;
                    }
                }
                else {
                    step.status = 'failed';
                    step.error = 'Runtime execution returned no result';
                    step.retryCount++;
                }
            }
            else {
                // No runtime — execute with direct LLM call
                const result = await this.executeDirect(step, goal);
                if (result) {
                    totalTokensUsed += result.tokens;
                    step.status = 'completed';
                    step.result = result.output;
                }
                else {
                    step.status = 'failed';
                    step.error = 'Direct execution failed';
                    step.retryCount++;
                }
            }
            // If failed too many times, mark as blocked
            if (step.status === 'failed' && step.retryCount >= step.maxRetries) {
                step.status = 'blocked';
                bus.publish('drive.step_failed', 'drive-orch', {
                    stepId: step.id,
                    description: step.description,
                });
            }
            this.state.totalTokensUsed += (_c = (_b = step.agentResult) === null || _b === void 0 ? void 0 : _b.totalTokenUsage.totalTokens) !== null && _c !== void 0 ? _c : 0;
            bus.publish('drive.step_completed', 'drive-orch', {
                stepId: step.id,
                status: step.status,
            });
            this.saveCheckpoint();
        }
        // Determine final status
        const completed = this.state.steps.filter((s) => s.status === 'completed').length;
        const total = this.state.steps.length;
        const status = completed === total
            ? 'completed'
            : completed > 0
                ? 'partial'
                : 'failed';
        bus.publish('drive.completed', 'drive-orch', {
            goal,
            status,
            iterations: iteration,
            stepsCompleted: completed,
            stepsTotal: total,
        });
        return this.buildResult(goal, status, startTime, this.state.totalTokensUsed, this.state.steps);
    }
    async planGoal(goal) {
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, PLAN_PROMPT, `Goal: ${goal}`);
        if (result && !(0, structuredOutput_1.validateShape)(result.data, { steps: 'array', reasoning: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('DriveOrchestrator', 'planGoal: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async replan() {
        const failedSteps = this.state.steps.filter((s) => s.status === 'failed' || s.status === 'blocked');
        const pendingSteps = this.state.steps.filter((s) => s.status === 'pending');
        const context = [
            'Goal: ' + this.state.goal,
            '',
            'Failed/blocked steps:',
            ...failedSteps.map((s) => `  - ${s.description}${s.error ? ': ' + s.error : ''}`),
            '',
            'Pending steps:',
            ...pendingSteps.map((s) => `  - ${s.description}`),
        ].join('\n');
        const result = await (0, llmJsonExtractor_1.callLLMJSON)(this.provider, this.model, REPLAN_PROMPT, context);
        if (result && !(0, structuredOutput_1.validateShape)(result.data, { steps: 'array', reasoning: 'string' })) {
            (0, logging_1.getGlobalLogger)().warn('DriveOrchestrator', 'replan: LLM response failed shape validation');
            return null;
        }
        return result;
    }
    async executeWithRuntime(step, goal) {
        if (!this.runtime)
            throw new Error('DriveRuntime not initialized');
        return this.runtime.execute({
            agentId: 'drive-worker',
            projectId: 'drive',
            goal: `[Drive] ${goal}\nStep: ${step.description}`,
            availableTools: [
                'read',
                'write',
                'edit',
                'glob',
                'grep',
                'bash',
                'lsp_diagnostics',
                'websearch',
                'webfetch',
            ],
            maxSteps: 15,
            tokenBudget: 32000,
            contextData: {},
        });
    }
    async executeDirect(step, goal) {
        var _a, _b;
        try {
            const response = await this.provider.call({
                model: this.model,
                messages: [
                    { role: 'system', content: WORKER_PROMPT },
                    {
                        role: 'user',
                        content: `Goal: ${goal}\n\nStep: ${step.description}\n\nExecute this step.`,
                    },
                ],
                temperature: 0.3,
                maxTokens: 4096,
            });
            return { output: response.content, tokens: (_b = (_a = response.usage) === null || _a === void 0 ? void 0 : _a.totalTokens) !== null && _b !== void 0 ? _b : 0 };
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('DriveOrchestrator', 'Direct execution failed', err);
            return null;
        }
    }
    // ========================================================================
    // State checkpointing
    // ========================================================================
    resetState(goal, startTime) {
        this.state = {
            goal,
            steps: [],
            currentStepIndex: 0,
            iteration: 0,
            startTime,
            lastCheckpoint: '',
            totalTokensUsed: 0,
        };
    }
    checkpointPath(goal) {
        const safe = goal.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        return path.join(this.config.checkpointDir, `${safe}.json`);
    }
    saveCheckpoint() {
        try {
            const cp = this.checkpointPath(this.state.goal);
            this.state.lastCheckpoint = new Date().toISOString();
            const tmp = cp + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
            fs.renameSync(tmp, cp);
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().error('DriveOrchestrator', 'Checkpoint save failed', err);
        }
    }
    loadCheckpoint(goal) {
        try {
            const cp = this.checkpointPath(goal);
            if (!fs.existsSync(cp))
                return null;
            const data = JSON.parse(fs.readFileSync(cp, 'utf-8'));
            return data;
        }
        catch {
            return null;
        }
    }
    // ========================================================================
    // Result builder
    // ========================================================================
    buildResult(goal, status, startTime, totalTokensUsed, steps) {
        const elapsed = Date.now() - startTime;
        const completed = steps.filter((s) => s.status === 'completed').length;
        const total = steps.length;
        const failed = steps.filter((s) => s.status === 'failed' || s.status === 'blocked');
        const lines = [
            `Goal: ${goal.slice(0, 120)}`,
            `Status: ${status}`,
            `Steps: ${completed}/${total} completed`,
            `Total tokens: ${totalTokensUsed.toLocaleString()}`,
        ];
        if (failed.length > 0) {
            lines.push(`Blocked: ${failed.map((s) => s.description).join(', ')}`);
        }
        return {
            goal,
            status,
            steps,
            totalIterations: this.state.iteration,
            totalDurationMs: elapsed,
            totalTokensUsed,
            summary: lines.join('\n'),
        };
    }
}
exports.DriveOrchestrator = DriveOrchestrator;
