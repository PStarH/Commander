"use strict";
/**
 * Internal URL Protocol — unified resource access for the agent.
 *
 * Inspired by oh-my-pi's internal URL system. Provides a single interface
 * to access different resource types through the file_read tool:
 *
 * - agent://<id> — subagent output
 * - memory://<key> — memory store entries
 * - skill://<name> — skill content
 * - checkpoint://<id> — checkpoint state
 *
 * This simplifies the tool interface — the agent uses file_read for everything.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InternalUrlRouter = void 0;
exports.parseInternalUrl = parseInternalUrl;
exports.isInternalUrl = isInternalUrl;
exports.getInternalUrlRouter = getInternalUrlRouter;
exports.resetInternalUrlRouter = resetInternalUrlRouter;
const checkpointManager_1 = require("./checkpointManager");
/**
 * Parse an internal URL like "agent://id/output" or "memory://key?namespace=ns"
 */
function parseInternalUrl(url) {
    const match = url.match(/^([a-z]+):\/\/([^?]+)(?:\?(.+))?$/);
    if (!match)
        return null;
    const [, protocol, pathPart, queryPart] = match;
    const params = {};
    if (queryPart) {
        for (const param of queryPart.split('&')) {
            const [key, value] = param.split('=');
            if (key)
                params[decodeURIComponent(key)] = decodeURIComponent(value !== null && value !== void 0 ? value : '');
        }
    }
    return {
        protocol: protocol.toLowerCase(),
        path: pathPart,
        params,
    };
}
/**
 * Check if a string is an internal URL.
 */
function isInternalUrl(url) {
    return /^[a-z]+:\/\//.test(url) && !url.startsWith('http://') && !url.startsWith('https://');
}
// ============================================================================
// URL Router
// ============================================================================
class InternalUrlRouter {
    constructor() {
        this.handlers = new Map();
        // Register built-in handlers
        this.register('checkpoint', this.handleCheckpoint.bind(this));
        this.register('memory', this.handleMemory.bind(this));
        this.register('skill', this.handleSkill.bind(this));
        this.register('agent', this.handleAgent.bind(this));
    }
    /**
     * Register a handler for a protocol.
     */
    register(protocol, handler) {
        this.handlers.set(protocol.toLowerCase(), handler);
    }
    /**
     * Resolve an internal URL to its content.
     */
    async resolve(url) {
        const parsed = parseInternalUrl(url);
        if (!parsed)
            return null;
        const handler = this.handlers.get(parsed.protocol);
        if (!handler)
            return null;
        try {
            return await handler(parsed.path, parsed.params);
        }
        catch (err) {
            return {
                content: `Error resolving ${url}: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    /**
     * Check if a URL can be handled.
     */
    canHandle(url) {
        const parsed = parseInternalUrl(url);
        if (!parsed)
            return false;
        return this.handlers.has(parsed.protocol);
    }
    /**
     * Get list of supported protocols.
     */
    getProtocols() {
        return Array.from(this.handlers.keys());
    }
    // ── Built-in Handlers ──
    async handleCheckpoint(path, params) {
        const manager = (0, checkpointManager_1.getCheckpointManager)();
        if (path === 'list' || path === '') {
            const checkpoints = manager.list();
            if (checkpoints.length === 0) {
                return { content: 'No checkpoints saved.', immutable: true };
            }
            const lines = checkpoints.map((cp) => {
                const age = Math.round((Date.now() - cp.timestamp) / 1000);
                return `${cp.id} | ${cp.label} | step ${cp.stepNumber} | ${cp.messageCount} msgs | ${age}s ago`;
            });
            return { content: `Checkpoints:\n${lines.join('\n')}`, immutable: true };
        }
        // Get specific checkpoint
        const checkpoint = manager.get(path);
        if (!checkpoint) {
            return { content: `Checkpoint not found: ${path}` };
        }
        if (params.action === 'collapse') {
            const summary = manager.collapse(path);
            return { content: summary || 'Failed to collapse checkpoint', immutable: true };
        }
        // Return checkpoint summary
        return {
            content: [
                `Checkpoint: ${checkpoint.label}`,
                `ID: ${checkpoint.id}`,
                `Step: ${checkpoint.stepNumber}`,
                `Messages: ${checkpoint.messages.length}`,
                `Tokens: ${checkpoint.tokenCount}`,
                `Files read: ${checkpoint.filesRead.join(', ') || 'none'}`,
                `Files modified: ${checkpoint.filesModified.join(', ') || 'none'}`,
            ].join('\n'),
            immutable: true,
        };
    }
    async handleMemory(path, params) {
        // Memory access would integrate with the memory system
        // For now, return a placeholder
        const namespace = params.namespace || 'default';
        return {
            content: `Memory access: ${path} (namespace: ${namespace})\nNote: Memory integration pending.`,
            immutable: false,
        };
    }
    async handleSkill(path, _params) {
        // Skill access would integrate with the skill system
        return {
            content: `Skill: ${path}\nNote: Skill integration pending.`,
            immutable: true,
        };
    }
    async handleAgent(path, _params) {
        // Agent output access would integrate with the subagent system
        return {
            content: `Agent output: ${path}\nNote: Agent integration pending.`,
            immutable: true,
        };
    }
}
exports.InternalUrlRouter = InternalUrlRouter;
// ============================================================================
// Global singleton
// ============================================================================
let globalRouter = null;
function getInternalUrlRouter() {
    if (!globalRouter) {
        globalRouter = new InternalUrlRouter();
    }
    return globalRouter;
}
function resetInternalUrlRouter() {
    globalRouter = null;
}
