"use strict";
/**
 * CheckpointWriter — MiMo-inspired independent checkpoint sub-agent.
 *
 * Core insight from MiMo Code: the agent is NOT the LLM — it's the harness.
 * Memory management must happen OUTSIDE the main agent's attention, using a
 * dedicated sub-agent that runs at strategic token-budget thresholds.
 *
 * This writer:
 * 1. Triggers at 20%, 45%, 70% of the hard token cap (not emergency thresholds)
 * 2. Runs as a fire-and-forget LLM call, not consuming main agent context
 * 3. Produces a structured checkpoint.md that feeds the Rebuild Prompt mechanism
 * 4. Writes to .commander/memory/checkpoints/{runId}.md with version tracking
 *
 * Key difference from existing StateCheckpointer:
 * - StateCheckpointer: saves raw execution state for crash recovery (in-band)
 * - CheckpointWriter: produces human/LLM-readable progress document (out-of-band)
 */
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
exports.CheckpointWriter = void 0;
exports.getCheckpointWriter = getCheckpointWriter;
exports.resetCheckpointWriter = resetCheckpointWriter;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const messageBus_1 = require("./messageBus");
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
// ============================================================================
// Types
// ============================================================================
/** Trigger points as percentage of hard token cap */
const DEFAULT_TRIGGER_POINTS = [0.2, 0.45, 0.7];
/** Minimum interval between checkpoints in ms (avoid spamming) */
const MIN_CHECKPOINT_INTERVAL_MS = 30000;
/** Token budget for the checkpoint writer LLM call (kept small) */
const WRITER_TOKEN_BUDGET = 2000;
/** Maximum temperature for deterministic checkpoint writing */
const WRITER_TEMPERATURE = 0.1;
// ============================================================================
// CheckpointWriter
// ============================================================================
class CheckpointWriter {
    constructor(config) {
        var _a, _b, _c, _d;
        /** Tracks which trigger points have already fired per runId */
        this.firedTriggers = new Map();
        /** Tracks last checkpoint time per runId (min interval enforcement) */
        this.lastCheckpointTime = new Map();
        /** Version counter per runId */
        this.versionCounter = new Map();
        this.config = {
            triggerPoints: (_a = config === null || config === void 0 ? void 0 : config.triggerPoints) !== null && _a !== void 0 ? _a : DEFAULT_TRIGGER_POINTS,
            minIntervalMs: (_b = config === null || config === void 0 ? void 0 : config.minIntervalMs) !== null && _b !== void 0 ? _b : MIN_CHECKPOINT_INTERVAL_MS,
            writerTokenBudget: (_c = config === null || config === void 0 ? void 0 : config.writerTokenBudget) !== null && _c !== void 0 ? _c : WRITER_TOKEN_BUDGET,
            storageDir: (_d = config === null || config === void 0 ? void 0 : config.storageDir) !== null && _d !== void 0 ? _d : path.join(process.cwd(), '.commander', 'memory', 'checkpoints'),
        };
    }
    // ========================================================================
    // Trigger Evaluation
    // ========================================================================
    /**
     * Check if a checkpoint should be written at this point.
     * Returns the trigger that fired, or null if no trigger should fire.
     */
    shouldTrigger(runId, tokensUsed, tokensHardCap) {
        var _a, _b, _c, _d;
        if (tokensHardCap <= 0)
            return null;
        const ratio = tokensUsed / tokensHardCap;
        const fired = (_a = this.firedTriggers.get(runId)) !== null && _a !== void 0 ? _a : new Set();
        // Check each trigger point
        for (const point of this.config.triggerPoints) {
            if (ratio >= point && !fired.has(point)) {
                // Enforce min interval
                const lastTime = (_b = this.lastCheckpointTime.get(runId)) !== null && _b !== void 0 ? _b : 0;
                if (Date.now() - lastTime < this.config.minIntervalMs) {
                    return null;
                }
                // Mark trigger as fired SYNCHRONOUSLY to prevent race conditions
                // when multiple maybeCheckpoint() calls overlap (e.g., Phase 6 + Phase 7).
                const trigPercent = Math.round(point * 100);
                fired.add(point);
                this.firedTriggers.set(runId, fired);
                this.lastCheckpointTime.set(runId, Date.now());
                // Bump version synchronously too (avoids duplicate versions)
                const version = ((_c = this.versionCounter.get(runId)) !== null && _c !== void 0 ? _c : 0) + 1;
                this.versionCounter.set(runId, version);
                return {
                    percent: trigPercent,
                    tokensUsed,
                    tokensHardCap,
                    ratio,
                };
            }
        }
        // Terminal checkpoint (100%) — always fire if not yet done
        if (ratio >= 0.98 && !fired.has(100)) {
            fired.add(100);
            this.firedTriggers.set(runId, fired);
            this.lastCheckpointTime.set(runId, Date.now());
            const version = ((_d = this.versionCounter.get(runId)) !== null && _d !== void 0 ? _d : 0) + 1;
            this.versionCounter.set(runId, version);
            return {
                percent: 100,
                tokensUsed,
                tokensHardCap,
                ratio,
            };
        }
        return null;
    }
    /**
     * Force a checkpoint regardless of trigger points.
     * Useful for manual CLI invocation or pre-shutdown.
     */
    forceTrigger(runId) {
        return {
            percent: 0, // 0 = manual
            tokensUsed: 0,
            tokensHardCap: 0,
            ratio: 0,
        };
    }
    // ========================================================================
    // Checkpoint Writing
    // ========================================================================
    /**
     * Write a checkpoint document for the given run.
     *
     * @param params - The data needed to build the checkpoint
     * @param provider - LLM provider for generating the structured checkpoint
     *                   (if null, uses a rule-based fallback)
     */
    async writeCheckpoint(params, provider) {
        var _a, _b;
        const startTime = Date.now();
        const trigPercent = params.trigger.percent;
        // Trigger + version already set synchronously in shouldTrigger().
        // Read the pre-bumped version for idempotency.
        const version = (_a = this.versionCounter.get(params.runId)) !== null && _a !== void 0 ? _a : 1;
        // Determine next action
        let nextAction = '';
        if (params.failedSubtasks.length > 0) {
            nextAction = `Retry failed subtasks: ${params.failedSubtasks.map((s) => s.id).join(', ')}`;
        }
        else if (params.pendingSubtasks.length > 0) {
            nextAction = `Continue with: ${params.pendingSubtasks[0].goal.slice(0, 100)}`;
        }
        else {
            nextAction = 'Synthesize results and run quality gates';
        }
        // Build the checkpoint document
        const doc = {
            runId: params.runId,
            version,
            timestamp: new Date().toISOString(),
            triggerPercent: trigPercent,
            goal: params.goal.slice(0, 500),
            phase: params.phase,
            stepNumber: params.stepNumber,
            completedSubtasks: params.completedSubtasks.map((s) => ({
                ...s,
                result: s.result.slice(0, 300),
            })),
            pendingSubtasks: params.pendingSubtasks,
            failedSubtasks: params.failedSubtasks.map((s) => ({
                ...s,
                error: s.error.slice(0, 200),
            })),
            keyDecisions: params.keyDecisions.slice(0, 10),
            filesRead: params.filesRead.slice(0, 50),
            filesModified: params.filesModified.slice(0, 50),
            errors: params.errors.slice(0, 20),
            tokensUsed: params.tokensUsed,
            tokensRemaining: Math.max(0, params.tokensHardCap - params.tokensUsed),
            budgetHardCap: params.tokensHardCap,
            nextAction,
            recentMessages: params.recentMessages.slice(-20),
        };
        // Enrich with LLM-generated next-action and key decisions if provider available
        if (provider && params.completedSubtasks.length > 0) {
            try {
                const enriched = await this.enrichWithLLM(doc, provider);
                if (enriched) {
                    if (enriched.nextAction)
                        doc.nextAction = enriched.nextAction;
                    if ((_b = enriched.keyDecisions) === null || _b === void 0 ? void 0 : _b.length) {
                        doc.keyDecisions = [...new Set([...doc.keyDecisions, ...enriched.keyDecisions])].slice(0, 10);
                    }
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('CheckpointWriter', 'LLM enrichment failed, using rule-based', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        // Persist to disk
        const filePath = this.persist(params.runId, !!provider, doc);
        // Emit event (also serves as observability signal)
        try {
            (0, messageBus_1.getMessageBus)().publish('checkpoint.written', 'checkpoint-writer', {
                runId: params.runId,
                version,
                triggerPercent: trigPercent,
                tokensUsed: params.tokensUsed,
                completedCount: params.completedSubtasks.length,
                pendingCount: params.pendingSubtasks.length,
                filePath,
            });
        }
        catch {
            /* best-effort */
        }
        return {
            runId: params.runId,
            version,
            filePath,
            triggerPercent: trigPercent,
            tokensUsed: params.tokensUsed,
            tokensRemaining: Math.max(0, params.tokensHardCap - params.tokensUsed),
            completedCount: params.completedSubtasks.length,
            pendingCount: params.pendingSubtasks.length,
            failedCount: params.failedSubtasks.length,
            durationMs: Date.now() - startTime,
        };
    }
    // ========================================================================
    // Persistence
    // ========================================================================
    persist(runId, llmEnriched, doc) {
        const dir = this.config.storageDir;
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const filePath = path.join(dir, `${runId}.md`);
        const markdown = this.toMarkdown(doc, llmEnriched);
        const tmpPath = filePath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, markdown, { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmpPath, filePath);
            try {
                fs.chmodSync(filePath, 0o600);
            }
            catch {
                /* best-effort */
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('CheckpointWriter', 'Failed to persist checkpoint', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId,
            });
        }
        return filePath;
    }
    /**
     * Convert checkpoint document to Markdown (checkpoint.md format).
     */
    toMarkdown(doc, llmEnriched) {
        const lines = [
            `# Checkpoint v${doc.version} — ${doc.triggerPercent > 0 ? `Trigger: ${doc.triggerPercent}%` : 'Manual'}`,
            ``,
            `- **Run**: \`${doc.runId}\``,
            `- **Timestamp**: ${doc.timestamp}`,
            `- **Phase**: ${doc.phase}`,
            `- **Step**: ${doc.stepNumber}`,
            `- **Enriched**: ${llmEnriched ? 'LLM' : 'Rule-based'}`,
            `- **Completed**: ${doc.completedSubtasks.length} | **Pending**: ${doc.pendingSubtasks.length} | **Failed**: ${doc.failedSubtasks.length}`,
            `- **Budget**: ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()} tokens`,
            `- **Next**: ${doc.nextAction}`,
            ``,
            `## Goal`,
            ``,
            `${doc.goal}`,
            ``,
            `## Progress`,
            ``,
            `### ✅ Completed (${doc.completedSubtasks.length})`,
            ``,
        ];
        for (const sub of doc.completedSubtasks) {
            lines.push(`- **${sub.id}**: ${sub.goal.slice(0, 120)}`);
            if (sub.result)
                lines.push(`  - _Result_: ${sub.result.slice(0, 200)}`);
            lines.push(`  - Tokens: ${sub.tokensUsed.toLocaleString()} | Duration: ${sub.durationMs}ms`);
        }
        if (doc.pendingSubtasks.length > 0) {
            lines.push(``, `### ⏳ Pending (${doc.pendingSubtasks.length})`, ``);
            for (const sub of doc.pendingSubtasks) {
                lines.push(`- **${sub.id}**: ${sub.goal.slice(0, 120)} (est. ${sub.estimatedTokens.toLocaleString()} tokens)`);
            }
        }
        if (doc.failedSubtasks.length > 0) {
            lines.push(``, `### ❌ Failed (${doc.failedSubtasks.length})`, ``);
            for (const sub of doc.failedSubtasks) {
                lines.push(`- **${sub.id}**: ${sub.goal.slice(0, 120)}`);
                lines.push(`  - _Error_: ${sub.error}`);
            }
        }
        if (doc.keyDecisions.length > 0) {
            lines.push(``, `## Key Decisions`, ``);
            for (const d of doc.keyDecisions) {
                lines.push(`- ${d}`);
            }
        }
        if (doc.filesRead.length > 0 || doc.filesModified.length > 0) {
            lines.push(``, `## File State`, ``);
            if (doc.filesRead.length > 0) {
                lines.push(`**Read** (${doc.filesRead.length}): ${doc.filesRead.slice(0, 20).join(', ')}${doc.filesRead.length > 20 ? '...' : ''}`);
            }
            if (doc.filesModified.length > 0) {
                lines.push(`**Modified** (${doc.filesModified.length}): ${doc.filesModified.slice(0, 20).join(', ')}${doc.filesModified.length > 20 ? '...' : ''}`);
            }
        }
        if (doc.errors.length > 0) {
            lines.push(``, `## Errors`, ``);
            for (const err of doc.errors.slice(0, 10)) {
                lines.push(`- [${err.recovered ? 'recovered' : 'unrecovered'}] **${err.nodeId}**: ${err.message.slice(0, 150)}`);
            }
        }
        lines.push(``, `## Token Budget`, ``);
        lines.push(`- **Used**: ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()}`);
        lines.push(`- **Remaining**: ${doc.tokensRemaining.toLocaleString()}`);
        lines.push(`- **Ratio**: ${((doc.tokensUsed / Math.max(1, doc.budgetHardCap)) * 100).toFixed(1)}%`);
        lines.push(``, `## Next Action`, ``);
        lines.push(doc.nextAction);
        // Include a compact conversation snapshot for rebuild
        if (doc.recentMessages.length > 0) {
            lines.push(``, `## Recent Context (${doc.recentMessages.length} messages)`, ``);
            lines.push('```');
            for (const msg of doc.recentMessages.slice(-10)) {
                const roleLabel = msg.role.toUpperCase().padEnd(10);
                const content = msg.content.replace(/\n/g, ' ').slice(0, 200);
                lines.push(`[${roleLabel}] ${content}`);
            }
            lines.push('```');
        }
        return lines.join('\n');
    }
    // ========================================================================
    // LLM Enrichment
    // ========================================================================
    /**
     * Use a lightweight LLM call to enrich the checkpoint with:
     * - A concise next-action recommendation
     * - Extracted key decisions the rule-based approach may miss
     */
    async enrichWithLLM(doc, provider) {
        const prompt = [
            {
                role: 'system',
                content: `You are a checkpoint writer. Your job is to write a concise progress summary for a long-running AI agent session. Be factual and brief. Do NOT invent information not present in the input.`,
            },
            {
                role: 'user',
                content: [
                    `Goal: ${doc.goal.slice(0, 300)}`,
                    ``,
                    `Completed (${doc.completedSubtasks.length}):`,
                    ...doc.completedSubtasks.map((s) => `- ${s.id}: ${s.goal.slice(0, 100)} → ${s.result.slice(0, 100)}`),
                    ``,
                    `Pending (${doc.pendingSubtasks.length}):`,
                    ...doc.pendingSubtasks.map((s) => `- ${s.id}: ${s.goal.slice(0, 100)}`),
                    ``,
                    `Failed (${doc.failedSubtasks.length}):`,
                    ...doc.failedSubtasks.map((s) => `- ${s.id}: ${s.goal.slice(0, 100)}`),
                    ``,
                    `Errors:`,
                    ...doc.errors.map((e) => `- ${e.nodeId}: ${e.message.slice(0, 100)}`),
                    ``,
                    `Token usage: ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()}`,
                    ``,
                    `Write a JSON with two fields:`,
                    `1. "nextAction": A single sentence describing what the agent should do next.`,
                    `2. "keyDecisions": An array of up to 3 key decisions made so far (only if clearly present in the data).`,
                    ``,
                    `Output ONLY valid JSON. No markdown, no explanation.`,
                ].join('\n'),
            },
        ];
        try {
            const response = await provider.call({
                model: '',
                messages: prompt,
                maxTokens: this.config.writerTokenBudget,
                temperature: WRITER_TEMPERATURE,
            });
            if (response === null || response === void 0 ? void 0 : response.content) {
                // Extract JSON from potentially markdown-wrapped response
                const jsonMatch = response.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : undefined,
                        keyDecisions: Array.isArray(parsed.keyDecisions)
                            ? parsed.keyDecisions.filter((d) => typeof d === 'string')
                            : undefined,
                    };
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('CheckpointWriter', 'LLM enrichment call failed', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        return null;
    }
    // ========================================================================
    // Query Methods
    // ========================================================================
    /**
     * Load a checkpoint document from disk.
     */
    loadCheckpoint(runId) {
        const filePath = path.join(this.config.storageDir, `${runId}.md`);
        try {
            if (!fs.existsSync(filePath))
                return null;
            const raw = fs.readFileSync(filePath, 'utf-8');
            return this.parseMarkdown(raw, runId);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('CheckpointWriter', 'Failed to load checkpoint', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId,
            });
            return null;
        }
    }
    /**
     * List all checkpoint files on disk.
     */
    listCheckpoints() {
        const dir = this.config.storageDir;
        try {
            if (!fs.existsSync(dir))
                return [];
            const files = fs
                .readdirSync(dir)
                .filter((f) => f.endsWith('.md'))
                .map((f) => {
                const fp = path.join(dir, f);
                const stat = fs.statSync(fp);
                return {
                    runId: f.replace(/\.md$/, ''),
                    filePath: fp,
                    size: stat.size,
                    modifiedAt: stat.mtime.toISOString(),
                };
            })
                .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
            return files;
        }
        catch {
            return [];
        }
    }
    /**
     * Delete all checkpoints for a run.
     */
    deleteCheckpoints(runId) {
        this.firedTriggers.delete(runId);
        this.lastCheckpointTime.delete(runId);
        this.versionCounter.delete(runId);
        const filePath = path.join(this.config.storageDir, `${runId}.md`);
        try {
            if (fs.existsSync(filePath))
                fs.unlinkSync(filePath);
        }
        catch {
            /* ignore */
        }
    }
    /**
     * Reset all writer state (for tests).
     */
    reset() {
        this.firedTriggers.clear();
        this.lastCheckpointTime.clear();
        this.versionCounter.clear();
    }
    // ========================================================================
    // Markdown Parser (reverse of toMarkdown)
    // ========================================================================
    /**
     * Parse summary metadata from the checkpoint markdown.
     * This is a lightweight extractor for listing mode — it reads the
     * metadata header block (first ~15 lines) to avoid full O(n²) I/O.
     * The markdown now includes a metadata line with counts/budget/next-action.
     */
    parseMarkdown(raw, runId) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        try {
            const versionMatch = raw.match(/Checkpoint v(\d+)/);
            const triggerMatch = raw.match(/Trigger: (\d+)%/);
            const tsMatch = raw.match(/\*\*Timestamp\*\*: (.+)/);
            const phaseMatch = raw.match(/\*\*Phase\*\*: (.+)/);
            const stepMatch = raw.match(/\*\*Step\*\*: (\d+)/);
            const goalMatch = raw.match(/## Goal\n\n(.+?)\n\n##/s);
            // Parse the metadata line: **Completed**: N | **Pending**: M | **Failed**: K
            const countsMatch = raw.match(/\*\*Completed\*\*:\s*(\d+)\s*\|\s*\*\*Pending\*\*:\s*(\d+)\s*\|\s*\*\*Failed\*\*:\s*(\d+)/);
            const tokensMatch = raw.match(/\*\*Used\*\*:\s*([\d,]+)\s*\/\s*([\d,]+)/);
            // If no metadata header, fall back to the Budget section
            const tokensFallbackMatch = !tokensMatch
                ? raw.match(/\*\*Used\*\*:\s*([\d,]+)\s*\/\s*([\d,]+)/)
                : null;
            const nextMatch = raw.match(/\*\*Next\*\*:\s*(.+)/);
            const nextFallbackMatch = !nextMatch ? raw.match(/## Next Action\n\n(.+?)\n/s) : null;
            const completedCount = countsMatch ? parseInt(countsMatch[1], 10) : 0;
            const pendingCount = countsMatch ? parseInt(countsMatch[2], 10) : 0;
            const failedCount = countsMatch ? parseInt(countsMatch[3], 10) : 0;
            const effectiveTokens = tokensMatch !== null && tokensMatch !== void 0 ? tokensMatch : tokensFallbackMatch;
            return {
                runId,
                version: versionMatch ? parseInt(versionMatch[1], 10) : 1,
                timestamp: (_a = tsMatch === null || tsMatch === void 0 ? void 0 : tsMatch[1]) !== null && _a !== void 0 ? _a : new Date().toISOString(),
                triggerPercent: triggerMatch ? parseInt(triggerMatch[1], 10) : 0,
                goal: (_c = (_b = goalMatch === null || goalMatch === void 0 ? void 0 : goalMatch[1]) === null || _b === void 0 ? void 0 : _b.trim()) !== null && _c !== void 0 ? _c : '',
                phase: (_e = (_d = phaseMatch === null || phaseMatch === void 0 ? void 0 : phaseMatch[1]) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : 'unknown',
                stepNumber: stepMatch ? parseInt(stepMatch[1], 10) : 0,
                completedSubtasks: new Array(completedCount).fill(null).map((_, i) => ({
                    id: `task-${i}`,
                    goal: '',
                    result: '',
                    tokensUsed: 0,
                    durationMs: 0,
                })),
                pendingSubtasks: new Array(pendingCount).fill(null).map((_, i) => ({
                    id: `task-${i}`,
                    goal: '',
                    estimatedTokens: 0,
                })),
                failedSubtasks: new Array(failedCount).fill(null).map((_, i) => ({
                    id: `task-${i}`,
                    goal: '',
                    error: '',
                })),
                keyDecisions: [],
                filesRead: [],
                filesModified: [],
                errors: [],
                tokensUsed: effectiveTokens ? parseInt(effectiveTokens[1].replace(/,/g, ''), 10) : 0,
                tokensRemaining: 0,
                budgetHardCap: effectiveTokens ? parseInt(effectiveTokens[2].replace(/,/g, ''), 10) : 0,
                nextAction: (_j = (_g = (_f = nextMatch === null || nextMatch === void 0 ? void 0 : nextMatch[1]) === null || _f === void 0 ? void 0 : _f.trim()) !== null && _g !== void 0 ? _g : (_h = nextFallbackMatch === null || nextFallbackMatch === void 0 ? void 0 : nextFallbackMatch[1]) === null || _h === void 0 ? void 0 : _h.trim()) !== null && _j !== void 0 ? _j : '',
                recentMessages: [],
            };
        }
        catch {
            return null;
        }
    }
}
exports.CheckpointWriter = CheckpointWriter;
// ============================================================================
// Singleton
// ============================================================================
const checkpointWriterSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new CheckpointWriter());
function getCheckpointWriter() {
    return checkpointWriterSingleton.get();
}
function resetCheckpointWriter() {
    checkpointWriterSingleton.reset();
}
