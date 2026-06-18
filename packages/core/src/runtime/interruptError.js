"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InterruptError = void 0;
/**
 * Thrown by tools to request human input mid-execution.
 * The runtime catches this and returns an 'interrupted' status.
 * On resume, the human's input becomes the tool's return value.
 */
class InterruptError extends Error {
    constructor(reason, value) {
        super(`Interrupt: ${reason}`);
        this.name = 'InterruptError';
        this.reason = reason;
        this.value = value !== null && value !== void 0 ? value : reason;
    }
}
exports.InterruptError = InterruptError;
