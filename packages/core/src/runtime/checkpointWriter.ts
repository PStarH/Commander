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

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getMessageBus } from './messageBus';
import { createTenantAwareSingleton } from './tenantAwareSingleton';
import type { LLMProvider, LLMMessage } from './types';

// ============================================================================
// Types
// ============================================================================

/** Trigger points as percentage of hard token cap */
const DEFAULT_TRIGGER_POINTS = [0.2, 0.45, 0.7];

/** Minimum interval between checkpoints in ms (avoid spamming) */
const MIN_CHECKPOINT_INTERVAL_MS = 30_000;

/** Token budget for the checkpoint writer LLM call (kept small) */
const WRITER_TOKEN_BUDGET = 2000;

/** Maximum temperature for deterministic checkpoint writing */
const WRITER_TEMPERATURE = 0.1;

export interface CheckpointWriterConfig {
  /** Trigger points as percentage of the hard token cap */
  triggerPoints: number[];
  /** Minimum interval between checkpoints in ms */
  minIntervalMs: number;
  /** Max tokens for the writer LLM call */
  writerTokenBudget: number;
  /** Base directory for checkpoint files */
  storageDir?: string;
}

export interface CheckpointTrigger {
  /** Which trigger point fired (20, 45, 70, or 100 for terminal) */
  percent: number;
  /** Total tokens used so far */
  tokensUsed: number;
  /** Hard cap tokens */
  tokensHardCap: number;
  /** Percentage of budget used */
  ratio: number;
}

export interface CheckpointDocument {
  /** Run identifier */
  runId: string;
  /** Monotonic version number within this run */
  version: number;
  /** ISO timestamp */
  timestamp: string;
  /** Which trigger point fired */
  triggerPercent: number;

  // ── Current State ──
  goal: string;
  phase: string;
  stepNumber: number;

  // ── Progress ──
  completedSubtasks: Array<{
    id: string;
    goal: string;
    result: string;
    tokensUsed: number;
    durationMs: number;
  }>;
  pendingSubtasks: Array<{
    id: string;
    goal: string;
    estimatedTokens: number;
  }>;
  failedSubtasks: Array<{
    id: string;
    goal: string;
    error: string;
  }>;

  // ── Decisions & State ──
  keyDecisions: string[];
  filesRead: string[];
  filesModified: string[];
  errors: Array<{ nodeId: string; message: string; recovered: boolean }>;

  // ── Budget ──
  tokensUsed: number;
  tokensRemaining: number;
  budgetHardCap: number;

  // ── Next Steps ──
  nextAction: string;

  // ── Conversation Snapshot (last N messages for rebuild) ──
  recentMessages: Array<{ role: string; content: string }>;
}

export interface CheckpointResult {
  runId: string;
  version: number;
  filePath: string;
  triggerPercent: number;
  tokensUsed: number;
  tokensRemaining: number;
  completedCount: number;
  pendingCount: number;
  failedCount: number;
  durationMs: number;
}

// ============================================================================
// CheckpointWriter
// ============================================================================

export class CheckpointWriter {
  private config: CheckpointWriterConfig;
  /** Tracks which trigger points have already fired per runId */
  private firedTriggers: Map<string, Set<number>> = new Map();
  /** Tracks last checkpoint time per runId (min interval enforcement) */
  private lastCheckpointTime: Map<string, number> = new Map();
  /** Version counter per runId */
  private versionCounter: Map<string, number> = new Map();

  constructor(config?: Partial<CheckpointWriterConfig>) {
    this.config = {
      triggerPoints: config?.triggerPoints ?? DEFAULT_TRIGGER_POINTS,
      minIntervalMs: config?.minIntervalMs ?? MIN_CHECKPOINT_INTERVAL_MS,
      writerTokenBudget: config?.writerTokenBudget ?? WRITER_TOKEN_BUDGET,
      storageDir:
        config?.storageDir ?? path.join(process.cwd(), '.commander', 'memory', 'checkpoints'),
    };
  }

  // ========================================================================
  // Trigger Evaluation
  // ========================================================================

  /**
   * Check if a checkpoint should be written at this point.
   * Returns the trigger that fired, or null if no trigger should fire.
   */
  shouldTrigger(
    runId: string,
    tokensUsed: number,
    tokensHardCap: number,
  ): CheckpointTrigger | null {
    if (tokensHardCap <= 0) return null;

    const ratio = tokensUsed / tokensHardCap;
    const fired = this.firedTriggers.get(runId) ?? new Set();

    // Check each trigger point
    for (const point of this.config.triggerPoints) {
      if (ratio >= point && !fired.has(point)) {
        // Enforce min interval
        const lastTime = this.lastCheckpointTime.get(runId) ?? 0;
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
        const version = (this.versionCounter.get(runId) ?? 0) + 1;
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
      const version = (this.versionCounter.get(runId) ?? 0) + 1;
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
  forceTrigger(_runId: string): CheckpointTrigger {
    return {
      percent: 0, // 0 = manual
      tokensUsed: 0,
      tokensHardCap: 0,
      ratio: 0,
    };
  }

  /**
   * Test-only accessor: returns whether {@link percent} (as a fraction,
   * e.g. 0.2 / 0.45 / 0.7) has already fired for {@link runId}.
   * Lets async-migration / idempotency tests assert the trigger-fire
   * tracking Map without reaching into the TypeScript-private
   * `firedTriggers` Set field, which would couple the test to the
   * internal field name.
   *
   * @internal — not part of the supported CheckpointWriter interface.
   */
  isTriggerFired(runId: string, percent: number): boolean {
    const fired = this.firedTriggers.get(runId);
    return fired ? fired.has(percent) : false;
  }

  /**
   * Test-only accessor: number of distinct trigger points fired for
   * {@link runId}. Useful for idempotency tests that need to verify
   * `shouldTrigger` returns null after a point has been consumed.
   *
   * @internal — not part of the supported CheckpointWriter interface.
   */
  getTriggerFiredCount(runId: string): number {
    return this.firedTriggers.get(runId)?.size ?? 0;
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
  async writeCheckpoint(
    params: {
      runId: string;
      goal: string;
      phase: string;
      stepNumber: number;
      completedSubtasks: CheckpointDocument['completedSubtasks'];
      pendingSubtasks: CheckpointDocument['pendingSubtasks'];
      failedSubtasks: CheckpointDocument['failedSubtasks'];
      keyDecisions: string[];
      filesRead: string[];
      filesModified: string[];
      errors: CheckpointDocument['errors'];
      tokensUsed: number;
      tokensHardCap: number;
      recentMessages: CheckpointDocument['recentMessages'];
      trigger: CheckpointTrigger;
    },
    provider?: LLMProvider,
  ): Promise<CheckpointResult> {
    const startTime = Date.now();
    const trigPercent = params.trigger.percent;

    // Trigger + version already set synchronously in shouldTrigger().
    // Read the pre-bumped version for idempotency.
    const version = this.versionCounter.get(params.runId) ?? 1;

    // Determine next action
    let nextAction = '';
    if (params.failedSubtasks.length > 0) {
      nextAction = `Retry failed subtasks: ${params.failedSubtasks.map((s) => s.id).join(', ')}`;
    } else if (params.pendingSubtasks.length > 0) {
      nextAction = `Continue with: ${params.pendingSubtasks[0].goal.slice(0, 100)}`;
    } else {
      nextAction = 'Synthesize results and run quality gates';
    }

    // Build the checkpoint document
    const doc: CheckpointDocument = {
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
          if (enriched.nextAction) doc.nextAction = enriched.nextAction;
          if (enriched.keyDecisions?.length) {
            doc.keyDecisions = [...new Set([...doc.keyDecisions, ...enriched.keyDecisions])].slice(
              0,
              10,
            );
          }
        }
      } catch (e) {
        getGlobalLogger().debug('CheckpointWriter', 'LLM enrichment failed, using rule-based', {
          error: (e as Error)?.message,
        });
      }
    }

    // Persist to disk (async — survives the LLM enrichment write burst without
    // blocking the event loop between writes and the bus.publish() below).
    const filePath = await this.persist(params.runId, !!provider, doc);

    // Emit event (also serves as observability signal)
    try {
      getMessageBus().publish('checkpoint.written', 'checkpoint-writer', {
        runId: params.runId,
        version,
        triggerPercent: trigPercent,
        tokensUsed: params.tokensUsed,
        completedCount: params.completedSubtasks.length,
        pendingCount: params.pendingSubtasks.length,
        filePath,
      });
    } catch (err) {
      reportSilentFailure(err, 'checkpointWriter:342');
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

  /**
   * Async persist: writes the markdown to <storageDir>/<runId>.md via the
   * tmp-then-rename atomic pattern. Called from the async writeCheckpoint()
   * entry point so the event loop is not blocked while serialising large
   * composed documents (completed/pending subtasks can reach several MB).
   */
  private async persist(
    runId: string,
    llmEnriched: boolean,
    doc: CheckpointDocument,
  ): Promise<string> {
    const dir = this.config.storageDir!;
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

    const filePath = path.join(dir, `${runId}.md`);

    const markdown = this.toMarkdown(doc, llmEnriched);
    const tmpPath = filePath + '.tmp';

    try {
      await fs.promises.writeFile(tmpPath, markdown, { encoding: 'utf-8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
      try {
        await fs.promises.chmod(filePath, 0o600);
      } catch (err) {
        reportSilentFailure(err, 'checkpointWriter:persist.chmod');
        /* best-effort */
      }
    } catch (e) {
      getGlobalLogger().warn('CheckpointWriter', 'Failed to persist checkpoint', {
        error: (e as Error)?.message,
        runId,
      });
    }

    return filePath;
  }

  /**
   * Convert checkpoint document to Markdown (checkpoint.md format).
   */
  private toMarkdown(doc: CheckpointDocument, llmEnriched: boolean): string {
    const lines: string[] = [
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
      if (sub.result) lines.push(`  - _Result_: ${sub.result.slice(0, 200)}`);
      lines.push(`  - Tokens: ${sub.tokensUsed.toLocaleString()} | Duration: ${sub.durationMs}ms`);
    }

    if (doc.pendingSubtasks.length > 0) {
      lines.push(``, `### ⏳ Pending (${doc.pendingSubtasks.length})`, ``);
      for (const sub of doc.pendingSubtasks) {
        lines.push(
          `- **${sub.id}**: ${sub.goal.slice(0, 120)} (est. ${sub.estimatedTokens.toLocaleString()} tokens)`,
        );
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
        lines.push(
          `**Read** (${doc.filesRead.length}): ${doc.filesRead.slice(0, 20).join(', ')}${doc.filesRead.length > 20 ? '...' : ''}`,
        );
      }
      if (doc.filesModified.length > 0) {
        lines.push(
          `**Modified** (${doc.filesModified.length}): ${doc.filesModified.slice(0, 20).join(', ')}${doc.filesModified.length > 20 ? '...' : ''}`,
        );
      }
    }

    if (doc.errors.length > 0) {
      lines.push(``, `## Errors`, ``);
      for (const err of doc.errors.slice(0, 10)) {
        lines.push(
          `- [${err.recovered ? 'recovered' : 'unrecovered'}] **${err.nodeId}**: ${err.message.slice(0, 150)}`,
        );
      }
    }

    lines.push(``, `## Token Budget`, ``);
    lines.push(
      `- **Used**: ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()}`,
    );
    lines.push(`- **Remaining**: ${doc.tokensRemaining.toLocaleString()}`);
    lines.push(
      `- **Ratio**: ${((doc.tokensUsed / Math.max(1, doc.budgetHardCap)) * 100).toFixed(1)}%`,
    );

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
  private async enrichWithLLM(
    doc: CheckpointDocument,
    provider: LLMProvider,
  ): Promise<{ nextAction?: string; keyDecisions?: string[] } | null> {
    const prompt: LLMMessage[] = [
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
          ...doc.completedSubtasks.map(
            (s) => `- ${s.id}: ${s.goal.slice(0, 100)} → ${s.result.slice(0, 100)}`,
          ),
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

      if (response?.content) {
        // Extract JSON from potentially markdown-wrapped response
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            nextAction: typeof parsed.nextAction === 'string' ? parsed.nextAction : undefined,
            keyDecisions: Array.isArray(parsed.keyDecisions)
              ? parsed.keyDecisions.filter((d: unknown): d is string => typeof d === 'string')
              : undefined,
          };
        }
      }
    } catch (e) {
      getGlobalLogger().debug('CheckpointWriter', 'LLM enrichment call failed', {
        error: (e as Error)?.message,
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
  loadCheckpoint(runId: string): CheckpointDocument | null {
    const filePath = path.join(this.config.storageDir!, `${runId}.md`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return this.parseMarkdown(raw, runId);
    } catch (e) {
      getGlobalLogger().warn('CheckpointWriter', 'Failed to load checkpoint', {
        error: (e as Error)?.message,
        runId,
      });
      return null;
    }
  }

  /** Async variant of loadCheckpoint for rebuild/resume hot-paths. */
  async loadCheckpointAsync(runId: string): Promise<CheckpointDocument | null> {
    const filePath = path.join(this.config.storageDir!, `${runId}.md`);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return this.parseMarkdown(raw, runId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      getGlobalLogger().warn('CheckpointWriter', 'Failed to load checkpoint (async)', {
        error: (err as Error)?.message,
        runId,
      });
      return null;
    }
  }

  /**
   * List all checkpoint files on disk.
   */
  listCheckpoints(): Array<{
    runId: string;
    filePath: string;
    size: number;
    modifiedAt: string;
  }> {
    const dir = this.config.storageDir!;
    try {
      if (!fs.existsSync(dir)) return [];
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
    } catch (err) {
      reportSilentFailure(err, 'checkpointWriter:626');
      return [];
    }
  }

  /**
   * Async variant of listCheckpoints. Reads .md entries in the storage
   * directory via fs.promises and stats each one in parallel.
   */
  async listCheckpointsAsync(): Promise<
    Array<{
      runId: string;
      filePath: string;
      size: number;
      modifiedAt: string;
    }>
  > {
    const dir = this.config.storageDir!;
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      reportSilentFailure(err, 'checkpointWriter:listAsync');
      return [];
    }
    const mdFiles = entries.filter((f) => f.endsWith('.md'));
    const stats = await Promise.all(
      mdFiles.map((f) =>
        fs.promises
          .stat(path.join(dir, f))
          .then((stat) => ({ f, stat }))
          .catch(() => null),
      ),
    );
    const results: Array<{
      runId: string;
      filePath: string;
      size: number;
      modifiedAt: string;
    }> = [];
    for (const entry of stats) {
      if (!entry) continue;
      const fp = path.join(dir, entry.f);
      results.push({
        runId: entry.f.replace(/\.md$/, ''),
        filePath: fp,
        size: entry.stat.size,
        modifiedAt: entry.stat.mtime.toISOString(),
      });
    }
    results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return results;
  }

  /**
   * Delete all checkpoints for a run.
   */
  deleteCheckpoints(runId: string): void {
    this.firedTriggers.delete(runId);
    this.lastCheckpointTime.delete(runId);
    this.versionCounter.delete(runId);

    const filePath = path.join(this.config.storageDir!, `${runId}.md`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      reportSilentFailure(err, 'checkpointWriter:643');
      /* ignore */
    }
  }

  /** Async variant of deleteCheckpoints. */
  async deleteCheckpointsAsync(runId: string): Promise<void> {
    this.firedTriggers.delete(runId);
    this.lastCheckpointTime.delete(runId);
    this.versionCounter.delete(runId);
    const filePath = path.join(this.config.storageDir!, `${runId}.md`);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      reportSilentFailure(err, 'checkpointWriter:deleteAsync');
    }
  }

  /**
   * Reset all writer state (for tests).
   */
  reset(): void {
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
  private parseMarkdown(raw: string, runId: string): CheckpointDocument | null {
    try {
      const versionMatch = raw.match(/Checkpoint v(\d+)/);
      const triggerMatch = raw.match(/Trigger: (\d+)%/);
      const tsMatch = raw.match(/\*\*Timestamp\*\*: (.+)/);
      const phaseMatch = raw.match(/\*\*Phase\*\*: (.+)/);
      const stepMatch = raw.match(/\*\*Step\*\*: (\d+)/);
      const goalMatch = raw.match(/## Goal\n\n(.+?)\n\n##/s);
      // Parse the metadata line: **Completed**: N | **Pending**: M | **Failed**: K
      const countsMatch = raw.match(
        /\*\*Completed\*\*:\s*(\d+)\s*\|\s*\*\*Pending\*\*:\s*(\d+)\s*\|\s*\*\*Failed\*\*:\s*(\d+)/,
      );
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
      const effectiveTokens = tokensMatch ?? tokensFallbackMatch;

      return {
        runId,
        version: versionMatch ? parseInt(versionMatch[1], 10) : 1,
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        triggerPercent: triggerMatch ? parseInt(triggerMatch[1], 10) : 0,
        goal: goalMatch?.[1]?.trim() ?? '',
        phase: phaseMatch?.[1]?.trim() ?? 'unknown',
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
        nextAction: nextMatch?.[1]?.trim() ?? nextFallbackMatch?.[1]?.trim() ?? '',
        recentMessages: [],
      };
    } catch (err) {
      reportSilentFailure(err, 'checkpointWriter:728');
      return null;
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

const checkpointWriterSingleton = createTenantAwareSingleton(() => new CheckpointWriter());

export function getCheckpointWriter(): CheckpointWriter {
  return checkpointWriterSingleton.get();
}

export function resetCheckpointWriter(): void {
  checkpointWriterSingleton.reset();
}
