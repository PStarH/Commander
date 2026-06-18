"use strict";
/**
 * A2A v1.0 Protocol Compliance Types
 * Based on a2aproject/A2A specification v1.0
 * Covers: AgentCard, Task lifecycle, Message, JSON-RPC 2.0, SSE streaming
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.A2A_PROTOCOL_VERSION = exports.A2A_VERSION_HEADER = exports.AGENT_CARD_WELL_KNOWN_PATH = exports.A2A_METHODS = exports.A2A_ERROR = exports.A2A_INTERRUPTED_STATES = exports.A2A_TERMINAL_STATES = void 0;
exports.canTransition = canTransition;
exports.A2A_TERMINAL_STATES = new Set([
    'COMPLETED',
    'FAILED',
    'CANCELED',
    'REJECTED',
]);
exports.A2A_INTERRUPTED_STATES = new Set([
    'INPUT_REQUIRED',
    'AUTH_REQUIRED',
]);
// Valid state transitions
const A2A_TRANSITIONS = {
    SUBMITTED: ['WORKING', 'COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'],
    WORKING: ['COMPLETED', 'FAILED', 'CANCELED', 'INPUT_REQUIRED', 'AUTH_REQUIRED', 'REJECTED'],
    COMPLETED: [],
    FAILED: [],
    CANCELED: [],
    INPUT_REQUIRED: ['WORKING', 'CANCELED'],
    REJECTED: [],
    AUTH_REQUIRED: ['WORKING', 'CANCELED'],
};
function canTransition(from, to) {
    var _a, _b;
    return (_b = (_a = A2A_TRANSITIONS[from]) === null || _a === void 0 ? void 0 : _a.includes(to)) !== null && _b !== void 0 ? _b : false;
}
// A2A-specific JSON-RPC error codes
exports.A2A_ERROR = {
    TASK_NOT_FOUND: -32001,
    TASK_NOT_CANCELABLE: -32002,
    PUSH_NOTIFICATION_UNSUPPORTED: -32003,
    UNSUPPORTED_OPERATION: -32004,
    CONTENT_TYPE_NOT_SUPPORTED: -32005,
    INVALID_AGENT_RESPONSE: -32006,
};
// ============================================================================
// JSON-RPC Method name constants
// ============================================================================
exports.A2A_METHODS = {
    SEND_MESSAGE: 'message/send',
    SEND_MESSAGE_STREAM: 'message/stream',
    GET_TASK: 'tasks/get',
    LIST_TASKS: 'tasks/list',
    CANCEL_TASK: 'tasks/cancel',
    RESUBSCRIBE: 'tasks/resubscribe',
    GET_AGENT_CARD: 'agent/getCard',
};
// Well-known agent card path
exports.AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json';
exports.A2A_VERSION_HEADER = 'A2A-Version';
exports.A2A_PROTOCOL_VERSION = '1.0';
