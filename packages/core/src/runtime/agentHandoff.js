"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentHandoff = void 0;
const tokenGovernor_1 = require("./tokenGovernor");
class AgentHandoff {
    constructor(inbox, checkpointer) {
        var _a;
        this.handoffs = new Map();
        this.UNRESOLVED_TTL_MS = 30 * 60 * 1000; // 30 minutes
        this.pruneTimer = null;
        this.inbox = inbox;
        this.checkpointer = checkpointer;
        this.pruneTimer = setInterval(() => this.pruneUnresolved(), this.UNRESOLVED_TTL_MS);
        if ((_a = this.pruneTimer) === null || _a === void 0 ? void 0 : _a.unref)
            this.pruneTimer.unref();
    }
    /** Prune handoffs that have been in a non-terminal state for too long */
    pruneUnresolved() {
        const threshold = Date.now() - this.UNRESOLVED_TTL_MS;
        for (const [id, h] of this.handoffs) {
            if (h.status === 'requested' && new Date(h.createdAt).getTime() < threshold) {
                h.status = 'failed';
                h.resolvedAt = new Date().toISOString();
                h.response = 'Timed out waiting for acceptance';
            }
        }
        this.pruneResolved();
    }
    /** Agent A initiates a handoff to Agent B */
    async request(handoff) {
        const full = {
            ...handoff,
            status: 'requested',
            createdAt: new Date().toISOString(),
        };
        this.handoffs.set(full.handoffId, full);
        this.inbox.send({
            id: `ho_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            from: handoff.fromAgent,
            to: handoff.toAgent,
            subject: `handoff: ${handoff.goal.slice(0, 100)}`,
            body: `Handoff request from ${handoff.fromAgent}: ${handoff.goal}`,
            priority: 'high',
            tags: ['handoff', 'request'],
            payload: { handoffId: full.handoffId },
        });
        return full;
    }
    /** Agent B accepts a handoff — returns the context needed to continue */
    async accept(handoffId, response) {
        const handoff = this.handoffs.get(handoffId);
        if (!handoff || handoff.status !== 'requested')
            return null;
        handoff.status = 'accepted';
        handoff.resolvedAt = new Date().toISOString();
        handoff.response = response;
        this.inbox.send({
            id: `ho_ack_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            from: handoff.toAgent,
            to: handoff.fromAgent,
            subject: `handoff accepted: ${handoff.goal.slice(0, 60)}`,
            body: response !== null && response !== void 0 ? response : 'Handoff accepted.',
            priority: 'normal',
            tags: ['handoff', 'accepted'],
            payload: { handoffId },
        });
        return handoff;
    }
    /** Agent B rejects a handoff */
    async reject(handoffId, reason) {
        const handoff = this.handoffs.get(handoffId);
        if (!handoff || handoff.status !== 'requested')
            return null;
        handoff.status = 'rejected';
        handoff.resolvedAt = new Date().toISOString();
        handoff.response = reason;
        this.inbox.send({
            id: `ho_rej_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            from: handoff.toAgent,
            to: handoff.fromAgent,
            subject: `handoff rejected: ${handoff.goal.slice(0, 60)}`,
            body: reason,
            priority: 'normal',
            tags: ['handoff', 'rejected'],
            payload: { handoffId },
        });
        this.pruneResolved();
        return handoff;
    }
    /** Mark a handoff as completed */
    complete(handoffId) {
        const handoff = this.handoffs.get(handoffId);
        if (handoff) {
            handoff.status = 'completed';
            handoff.resolvedAt = new Date().toISOString();
        }
        // Auto-prune resolved handoffs older than 10 minutes
        this.pruneResolved();
    }
    /** Remove resolved handoffs older than 10 minutes to prevent unbounded growth */
    pruneResolved(maxAgeMs = 600000) {
        const threshold = Date.now() - maxAgeMs;
        let removed = 0;
        for (const [id, h] of this.handoffs) {
            if (h.resolvedAt && new Date(h.resolvedAt).getTime() < threshold) {
                this.handoffs.delete(id);
                removed++;
            }
        }
        return removed;
    }
    /** Get handoff details */
    getHandoff(handoffId) {
        return this.handoffs.get(handoffId);
    }
    /** List handoffs for an agent */
    listForAgent(agentId) {
        return Array.from(this.handoffs.values()).filter((h) => h.fromAgent === agentId || h.toAgent === agentId);
    }
    /**
     * Build a structured WorkOrder from execution context.
     * Replaces free-form message passing with a typed schema.
     */
    static buildWorkOrder(params) {
        var _a, _b, _c, _d;
        return {
            goal: params.goal,
            completedSteps: (_a = params.completedSteps) !== null && _a !== void 0 ? _a : [],
            remainingTasks: (_b = params.remainingTasks) !== null && _b !== void 0 ? _b : [],
            artifacts: (_c = params.artifacts) !== null && _c !== void 0 ? _c : [],
            constraints: (_d = params.constraints) !== null && _d !== void 0 ? _d : [],
        };
    }
    /**
     * Generate a compressed ≤500-token ContextSummary from messages.
     * Extracts key phases, findings, decisions, and environment state
     * without passing the full message history.
     */
    static generateSummary(messages) {
        var _a;
        // Extract system instructions (first system message)
        const systemMsgs = messages.filter((m) => m.role === 'system');
        const userMsgs = messages.filter((m) => m.role === 'user');
        const assistantMsgs = messages.filter((m) => m.role === 'assistant');
        const toolMsgs = messages.filter((m) => m.role === 'tool');
        // Compress: extract key sentences from each message type
        const extractKeySentences = (text, maxSentences) => {
            const sentences = text
                .split(/[.\n]+/)
                .map((s) => s.trim())
                .filter((s) => s.length > 20 && s.length < 300);
            return sentences.slice(0, maxSentences).join('. ');
        };
        // Build executed plan summary from user messages
        const planParts = userMsgs.map((m) => extractKeySentences(m.content, 2)).filter(Boolean);
        const executedPlan = planParts.length > 0
            ? planParts.slice(0, 5).join('; ').slice(0, 300)
            : 'No explicit plan recorded';
        // Extract findings from tool results (first meaningful output per unique tool)
        const seenTools = new Set();
        const findings = [];
        for (const msg of toolMsgs) {
            const firstLine = (_a = msg.content.split('\n')[0]) === null || _a === void 0 ? void 0 : _a.trim();
            if (firstLine && firstLine.length > 10 && firstLine.length < 200) {
                const toolId = firstLine.slice(0, 40);
                if (!seenTools.has(toolId)) {
                    seenTools.add(toolId);
                    findings.push(firstLine.slice(0, 150));
                }
            }
            if (findings.length >= 5)
                break;
        }
        // Extract decisions from assistant messages
        const decisions = [];
        for (const msg of assistantMsgs) {
            const lines = msg.content.split('\n').filter((l) => l.trim().length > 20);
            for (const line of lines) {
                const lower = line.toLowerCase();
                if ((lower.includes('decid') ||
                    lower.includes('conclud') ||
                    lower.includes('therefor') ||
                    lower.includes('thus')) &&
                    line.length < 200) {
                    decisions.push(line.slice(0, 180));
                    if (decisions.length >= 3)
                        break;
                }
            }
            if (decisions.length >= 3)
                break;
        }
        // Environment snapshot: last system message
        const environmentSnapshot = systemMsgs.length > 0
            ? systemMsgs[systemMsgs.length - 1].content.slice(0, 200)
            : 'No environment snapshot available';
        // Open questions: last user message if it ends with a question
        const lastUser = userMsgs[userMsgs.length - 1];
        const openQuestions = [];
        if (lastUser) {
            const content = lastUser.content;
            const qMark = content.indexOf('?');
            if (qMark >= 0) {
                const before = content.slice(Math.max(0, qMark - 80), qMark + 1).trim();
                if (before.length > 10)
                    openQuestions.push(before);
            }
        }
        const summary = {
            executedPlan,
            findings: findings.length > 0 ? findings : ['No findings extracted'],
            decisions: decisions.length > 0 ? decisions : ['No decisions recorded'],
            environmentSnapshot,
            openQuestions,
        };
        // Enforce ≤500-token budget by truncating the largest text fields
        return AgentHandoff.capSummaryToTokens(summary, 500);
    }
    /**
     * Truncate a ContextSummary so its JSON representation is ≤ maxTokens.
     * Reduces field lengths proportionally, never deletes fields entirely.
     */
    static capSummaryToTokens(summary, maxTokens) {
        const estimate = (text) => tokenGovernor_1.TokenGovernor.estimateTokens(text);
        const totalTokens = (s) => estimate(s.executedPlan) +
            estimate(s.findings.join('\n')) +
            estimate(s.decisions.join('\n')) +
            estimate(s.environmentSnapshot) +
            estimate(s.openQuestions.join('\n'));
        let current = { ...summary };
        if (totalTokens(current) <= maxTokens)
            return current;
        // Budget per field: allocate proportionally, with a floor
        const fields = [
            'executedPlan',
            'findings',
            'decisions',
            'environmentSnapshot',
            'openQuestions',
        ];
        const toText = (s, field) => Array.isArray(s[field]) ? s[field].join('\n') : String(s[field]);
        let iterations = 0;
        while (totalTokens(current) > maxTokens && iterations < 20) {
            iterations++;
            const overage = totalTokens(current) - maxTokens;
            let reduced = false;
            for (const field of fields) {
                const text = toText(current, field);
                if (text.length <= 20)
                    continue;
                const fieldTokens = estimate(text);
                const share = Math.max(10, Math.floor((fieldTokens / Math.max(1, totalTokens(current))) * overage));
                const targetChars = Math.max(20, Math.floor(text.length * (1 - share / Math.max(1, fieldTokens))));
                if (targetChars < text.length) {
                    if (Array.isArray(current[field])) {
                        const joined = current[field].join('\n');
                        const truncated = joined.slice(0, targetChars);
                        current[field] = truncated.split('\n').filter(Boolean);
                    }
                    else {
                        current[field] = text.slice(0, targetChars);
                    }
                    reduced = true;
                }
            }
            if (!reduced)
                break;
        }
        return current;
    }
    /**
     * Shorthand: build both work order and context summary in one call.
     */
    static createHandoffContext(params) {
        const workOrder = AgentHandoff.buildWorkOrder(params);
        const contextSummary = params.messages
            ? AgentHandoff.generateSummary(params.messages)
            : {
                executedPlan: 'No execution plan provided',
                findings: [],
                decisions: [],
                environmentSnapshot: 'No environment snapshot',
                openQuestions: [],
            };
        return {
            workOrder,
            contextSummary,
            // Only include full messages when explicitly requested
            messages: params.includeFullMessages ? params.messages : undefined,
        };
    }
    dispose() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
}
exports.AgentHandoff = AgentHandoff;
