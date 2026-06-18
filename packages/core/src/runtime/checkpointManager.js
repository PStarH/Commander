"use strict";
/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * Inspired by oh-my-pi's checkpoint/rewind tools. Allows the agent to:
 * - Save a checkpoint of the current conversation state
 * - Rewind to a previous checkpoint (prune exploratory context)
 * - Collapse a checkpoint into a concise report
 *
 * This is critical for long coding sessions where the model may need to
 * backtrack after trying an approach that didn't work.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckpointManager = void 0;
exports.getCheckpointManager = getCheckpointManager;
exports.resetCheckpointManager = resetCheckpointManager;
// ============================================================================
// Checkpoint Manager
// ============================================================================
class CheckpointManager {
    constructor(maxCheckpoints = 20) {
        this.checkpoints = [];
        this.maxCheckpoints = maxCheckpoints;
    }
    /**
     * Save a checkpoint of the current conversation state.
     */
    save(label, messages, stepNumber, filesRead = [], filesModified = []) {
        const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tokenCount = this.estimateTokens(messages);
        const checkpoint = {
            id,
            label,
            timestamp: Date.now(),
            messages: [...messages], // Deep copy
            tokenCount,
            stepNumber,
            filesRead: [...filesRead],
            filesModified: [...filesModified],
        };
        this.checkpoints.push(checkpoint);
        // Trim old checkpoints if over limit
        while (this.checkpoints.length > this.maxCheckpoints) {
            this.checkpoints.shift();
        }
        return checkpoint;
    }
    /**
     * Get a checkpoint by ID.
     */
    get(id) {
        return this.checkpoints.find((cp) => cp.id === id);
    }
    /**
     * Get the most recent checkpoint.
     */
    getLatest() {
        return this.checkpoints[this.checkpoints.length - 1];
    }
    /**
     * List all checkpoints (summaries only, no message data).
     */
    list() {
        return this.checkpoints.map((cp) => ({
            id: cp.id,
            label: cp.label,
            timestamp: cp.timestamp,
            stepNumber: cp.stepNumber,
            messageCount: cp.messages.length,
            tokenCount: cp.tokenCount,
            filesRead: cp.filesRead,
            filesModified: cp.filesModified,
        }));
    }
    /**
     * Rewind to a checkpoint — return the messages to restore.
     * This effectively prunes all messages after the checkpoint.
     */
    rewind(id) {
        const checkpoint = this.checkpoints.find((cp) => cp.id === id);
        if (!checkpoint)
            return null;
        // Remove all checkpoints after this one
        const idx = this.checkpoints.indexOf(checkpoint);
        this.checkpoints = this.checkpoints.slice(0, idx + 1);
        return [...checkpoint.messages];
    }
    /**
     * Collapse a checkpoint into a concise summary.
     * Returns a system message that summarizes what happened since the checkpoint.
     */
    collapse(id) {
        const checkpoint = this.checkpoints.find((cp) => cp.id === id);
        if (!checkpoint)
            return null;
        const parts = [
            `## Checkpoint: ${checkpoint.label}`,
            `Saved at step ${checkpoint.stepNumber}`,
            '',
        ];
        if (checkpoint.filesRead.length > 0) {
            parts.push(`Files read: ${checkpoint.filesRead.join(', ')}`);
        }
        if (checkpoint.filesModified.length > 0) {
            parts.push(`Files modified: ${checkpoint.filesModified.join(', ')}`);
        }
        // Extract key decisions and findings from messages
        const decisions = [];
        const findings = [];
        for (const msg of checkpoint.messages) {
            if (msg.role === 'assistant' && msg.content) {
                // Extract decision patterns
                const decisionMatch = msg.content.match(/(?:I will|Let me|Going to|Plan to) .{10,100}/i);
                if (decisionMatch)
                    decisions.push(decisionMatch[0].slice(0, 120));
            }
            if (msg.role === 'tool' && msg.content) {
                const lines = msg.content.split('\n');
                const finding = lines.find((l) => l.trim().length > 20 && l.trim().length < 150);
                if (finding)
                    findings.push(finding.trim().slice(0, 100));
            }
        }
        if (decisions.length > 0) {
            parts.push(`\nKey decisions: ${decisions.slice(0, 3).join('; ')}`);
        }
        if (findings.length > 0) {
            parts.push(`\nKey findings: ${findings.slice(0, 3).join('; ')}`);
        }
        return parts.join('\n');
    }
    /**
     * Clear all checkpoints.
     */
    clear() {
        this.checkpoints = [];
    }
    /**
     * Get checkpoint count.
     */
    get size() {
        return this.checkpoints.length;
    }
    // ── Internal ──
    estimateTokens(messages) {
        let total = 0;
        for (const msg of messages) {
            const content = typeof msg.content === 'string' ? msg.content : '';
            total += Math.ceil(content.length / 4); // rough estimate
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    total += Math.ceil((tc.function.name.length + tc.function.arguments.length) / 4);
                }
            }
        }
        return total;
    }
}
exports.CheckpointManager = CheckpointManager;
// ============================================================================
// Global singleton
// ============================================================================
let globalCheckpointManager = null;
function getCheckpointManager() {
    if (!globalCheckpointManager) {
        globalCheckpointManager = new CheckpointManager();
    }
    return globalCheckpointManager;
}
function resetCheckpointManager() {
    globalCheckpointManager = null;
}
