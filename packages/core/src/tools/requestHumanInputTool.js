"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRequestHumanInputTool = createRequestHumanInputTool;
const interruptError_1 = require("../runtime/interruptError");
/**
 * Built-in tool that requests human input mid-execution.
 * When ctx.resumeWith is set, returns that value (resume path).
 * Otherwise throws InterruptError to pause execution (interrupt path).
 */
function createRequestHumanInputTool() {
    return {
        definition: {
            name: 'request_human_input',
            description: 'Pause execution and request input from a human. Use when you need approval, clarification, or a decision before continuing. The human response will be returned as the tool result.',
            category: 'control',
            inputSchema: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'Why you need human input (e.g., "Approve destructive action?", "Which approach should I take?")',
                    },
                    value: {
                        description: 'Optional payload to present to the human (proposed action, options, etc.)',
                    },
                },
                required: ['reason'],
            },
        },
        execute(args, ctx) {
            var _a, _b;
            // Resume path: if human input was provided, return it
            if ((ctx === null || ctx === void 0 ? void 0 : ctx.resumeWith) !== undefined) {
                return Promise.resolve(String(ctx.resumeWith));
            }
            // Interrupt path: pause execution
            const reason = String((_a = args.reason) !== null && _a !== void 0 ? _a : 'Human input requested');
            const value = (_b = args.value) !== null && _b !== void 0 ? _b : reason;
            throw new interruptError_1.InterruptError(reason, value);
        },
        isReadOnly: true,
        riskLevel: 'low',
    };
}
