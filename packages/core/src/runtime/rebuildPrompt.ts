/**
 * RebuildPrompt — MiMo-inspired Layer 5: Context Reconstruction.
 *
 * When progressive compaction (Layers 1-4) can no longer keep the context
 * under budget, this module performs a full context window reset and
 * reconstructs a fresh prompt from structured, persistent storage.
 *
 * Core insight from MiMo Code:
 * - Layers 1-4 are summarization — they KEEP history, just compressed
 * - Layer 5 is RECONSTRUCTION — it discards all history and rebuilds
 * - The model sees a fresh, clean context; the harness preserves continuity
 *
 * Injection order (MiMo-aligned):
 * 1. System Prompt (original, always preserved)
 * 2. Task List / Goal
 * 3. Session State (from checkpoint.md via CheckpointWriter)
 * 4. Recent User Messages (verbatim last ~3 exchanges)
 * 5. Project Memory (from ThreeLayerMemory — embedded search)
 * 6. Next Step directive
 *
 * Each section has its own token budget. Total cap: ~65K tokens
 * (leaves 63K for the model to respond within a 128K window).
 */

import { getGlobalLogger } from '../logging';
import { getMessageBus } from './messageBus';
import { TokenGovernor } from './tokenGovernor';
import type { LLMMessage } from './types';

// ============================================================================
// Budget Constants
// ============================================================================

/** Total token budget for the rebuilt prompt */
const REBUILD_TOTAL_BUDGET = 65_000;

/** Section token caps (in order of injection) */
const SECTION_CAPS: Record<string, number> = {
  systemPrompt: 4_000,
  taskAndGoal: 2_000,
  sessionState: 25_000,
  recentUserMessages: 8_000,
  projectMemory: 20_000,
  nextStep: 2_000,
  // remainder ~4K for overhead
};

/** Marker for rebuilt context */
const REBUILD_MARKER = '__REBUILT__';

// ============================================================================
// Types
// ============================================================================

export interface RebuildParams {
  /** Run identifier for loading the checkpoint */
  runId: string;
  /** The original goal/task description */
  goal: string;
  /** Current phase (deliberation, execution, synthesis, etc.) */
  phase: string;
  /** Current step number */
  stepNumber: number;
  /** Original system prompt messages (always preserved) */
  systemPrompt: LLMMessage[];
  /** Recent user messages to carry forward verbatim */
  recentUserMessages: LLMMessage[];
  /** Token usage stats for the current run */
  tokenUsage: { totalTokens: number; budgetHardCap: number };
  /** Optional: path to checkpoint file (auto-detected if not provided) */
  checkpointPath?: string;
}

export interface RebuildSection {
  name: string;
  cap: number;
  used: number;
  content: string;
}

export interface RebuildResult {
  messages: LLMMessage[];
  sections: RebuildSection[];
  totalTokens: number;
  budget: number;
  description: string;
}

// ============================================================================
// RebuildPrompt
// ============================================================================

export class RebuildPrompt {
  private rebuildCount = new Map<string, number>();
  private readonly maxTrackedRuns = 500;

  /**
   * Check if a rebuild is warranted.
   * External callers (e.g., CLI diagnostics) can use this for informational purposes.
   * The primary trigger path is via ContextCompactor.needsCompaction() → layer 5.
   */
  needsRebuild(
    runId: string,
    currentTokens: number,
    maxContextTokens: number,
    compactionCount: number,
  ): boolean {
    if (maxContextTokens <= 0) return false;
    if (currentTokens / maxContextTokens < 0.95) return false;
    if (compactionCount < 1) return false; // Don't rebuild without trying compaction first

    const rebuilds = this.rebuildCount.get(runId) ?? 0;
    if (rebuilds >= 3) return false; // Safety: max 3 rebuilds per run

    return true;
  }

  /**
   * Perform a context rebuild.
   *
   * Constructs a fresh set of messages by reading from:
   * 1. System prompt (preserved verbatim from original)
   * 2. Checkpoint.md (from CheckpointWriter on disk)
   * 3. ThreeLayerMemory (episodic + long-term search)
   * 4. Recent user messages
   *
   * The original conversation history is DISCARDED.
   * Only structured state is carried forward.
   */
  async rebuild(params: RebuildParams): Promise<RebuildResult> {
    const startTime = Date.now();
    const sections: RebuildSection[] = [];
    const messages: LLMMessage[] = [];

    // Bump rebuild counter (prune old entries to prevent unbounded growth)
    const count = (this.rebuildCount.get(params.runId) ?? 0) + 1;
    this.rebuildCount.set(params.runId, count);
    this.pruneIfNeeded();

    // ── Section 1: System Prompt (preserved verbatim) ────────────────
    const systemSection = this.buildSystemSection(params.systemPrompt, SECTION_CAPS.systemPrompt);
    messages.push(...params.systemPrompt.slice(0, 2)); // Keep original system messages
    sections.push(systemSection);

    // ── Section 2: Task & Goal ──────────────────────────────────────
    const taskSection = this.buildTaskSection(params.goal, params.phase, params.stepNumber, count);
    messages.push({
      role: 'system',
      content: taskSection.content,
    });
    sections.push(taskSection);

    // ── Section 3: Session State (from checkpoint.md) ────────────────
    const sessionSection = await this.buildSessionSection(
      params.runId,
      params.checkpointPath,
      SECTION_CAPS.sessionState,
    );
    if (sessionSection.used > 0) {
      messages.push({
        role: 'system',
        content: markRebuilt(sessionSection.content),
      });
    }
    sections.push(sessionSection);

    // ── Section 4: Recent User Messages (verbatim) ──────────────────
    const recentSection = this.buildRecentSection(
      params.recentUserMessages,
      SECTION_CAPS.recentUserMessages,
    );
    messages.push(...params.recentUserMessages);
    sections.push(recentSection);

    // ── Section 5: Project Memory (from ThreeLayerMemory) ───────────
    const memorySection = await this.buildMemorySection(params.goal, SECTION_CAPS.projectMemory);
    if (memorySection.used > 0) {
      messages.push({
        role: 'system',
        content: markRebuilt(memorySection.content),
      });
    }
    sections.push(memorySection);

    // ── Section 6: Next Step Directive ──────────────────────────────
    const nextSection = this.buildNextStepSection(params.stepNumber, count);
    messages.push({
      role: 'system',
      content: nextSection.content,
    });
    sections.push(nextSection);

    // Compute totals
    const totalTokens = sections.reduce((s, sec) => s + sec.used, 0);

    // Emit rebuild event
    try {
      getMessageBus().publish('context.rebuilt', 'rebuild-prompt', {
        runId: params.runId,
        rebuildCount: count,
        totalTokens,
        sections: sections.map((s) => ({ name: s.name, used: s.used, cap: s.cap })),
        durationMs: Date.now() - startTime,
      });
    } catch {
      /* best-effort */
    }

    getGlobalLogger().info('RebuildPrompt', 'Context rebuilt', {
      runId: params.runId,
      rebuildCount: count,
      totalTokens,
      budget: REBUILD_TOTAL_BUDGET,
    });

    return {
      messages,
      sections,
      totalTokens,
      budget: REBUILD_TOTAL_BUDGET,
      description: `Rebuild #${count}: ${sections.length} sections, ${totalTokens.toLocaleString()} tokens / ${REBUILD_TOTAL_BUDGET.toLocaleString()} budget`,
    };
  }

  /**
   * Reset rebuild counter for a run (for tests, and after run completion).
   * Call this from the orchestrator's finally block to prevent unbounded Map growth.
   */
  resetRun(runId: string): void {
    this.rebuildCount.delete(runId);
  }

  /** Prune old run entries to prevent unbounded growth. */
  private pruneIfNeeded(): void {
    if (this.rebuildCount.size > this.maxTrackedRuns) {
      const oldest = this.rebuildCount.keys().next().value;
      if (oldest) this.rebuildCount.delete(oldest);
    }
  }

  // ========================================================================
  // Section Builders
  // ========================================================================

  private buildSystemSection(systemPrompt: LLMMessage[], cap: number): RebuildSection {
    const content = systemPrompt
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const truncated = fitToCap(content, cap);
    return { name: 'systemPrompt', cap, used: estimateTokens(truncated), content: truncated };
  }

  private buildTaskSection(
    goal: string,
    phase: string,
    stepNumber: number,
    rebuildCount: number,
  ): RebuildSection {
    const lines = [
      `## Current Task (Rebuild #${rebuildCount})`,
      ``,
      `**Goal**: ${goal.slice(0, 1000)}`,
      `**Phase**: ${phase}`,
      `**Step**: ${stepNumber}`,
      ``,
      `You are continuing a long-running session. The conversation history has been archived.`,
      `Below is a structured summary of the current state. Use this to continue where you left off.`,
    ].join('\n');

    const truncated = fitToCap(lines, SECTION_CAPS.taskAndGoal);
    return {
      name: 'taskAndGoal',
      cap: SECTION_CAPS.taskAndGoal,
      used: estimateTokens(truncated),
      content: truncated,
    };
  }

  private async buildSessionSection(
    runId: string,
    checkpointPath: string | undefined,
    cap: number,
  ): Promise<RebuildSection> {
    try {
      // Dynamically import to avoid circular dependency
      const { getCheckpointWriter } = await import('./checkpointWriter');
      const writer = getCheckpointWriter();

      // Try to load checkpoint from disk
      let checkpointContent = '';
      const doc = writer.loadCheckpoint(runId);
      if (doc) {
        const lines: string[] = [
          `## Session State (from checkpoint.md)`,
          ``,
          `### Progress`,
          `- Completed: ${doc.completedSubtasks.length} subtask(s)`,
          `- Pending: ${doc.pendingSubtasks.length} subtask(s)`,
          `- Failed: ${doc.failedSubtasks.length} subtask(s)`,
          ``,
        ];

        if (doc.completedSubtasks.length > 0) {
          lines.push(`### Completed Subtasks`);
          for (const sub of doc.completedSubtasks.slice(0, 10)) {
            lines.push(`- **${sub.id}**: ${sub.goal.slice(0, 100)} → ${sub.result.slice(0, 150)}`);
          }
          lines.push('');
        }

        if (doc.pendingSubtasks.length > 0) {
          lines.push(`### Pending Subtasks`);
          for (const sub of doc.pendingSubtasks.slice(0, 5)) {
            lines.push(`- **${sub.id}**: ${sub.goal.slice(0, 100)}`);
          }
          lines.push('');
        }

        if (doc.failedSubtasks.length > 0) {
          lines.push(`### Failed Subtasks`);
          for (const sub of doc.failedSubtasks.slice(0, 5)) {
            lines.push(
              `- **${sub.id}**: ${sub.goal.slice(0, 100)} (Error: ${sub.error.slice(0, 100)})`,
            );
          }
          lines.push('');
        }

        if (doc.keyDecisions.length > 0) {
          lines.push(`### Key Decisions`);
          for (const d of doc.keyDecisions.slice(0, 5)) {
            lines.push(`- ${d}`);
          }
          lines.push('');
        }

        if (doc.errors.length > 0) {
          lines.push(`### Errors Encountered`);
          for (const e of doc.errors.slice(0, 5)) {
            lines.push(
              `- [${e.recovered ? 'recovered' : 'unrecovered'}] ${e.message.slice(0, 120)}`,
            );
          }
          lines.push('');
        }

        lines.push(`### Token Budget`);
        lines.push(
          `- Used: ${doc.tokensUsed.toLocaleString()} / ${doc.budgetHardCap.toLocaleString()}`,
        );
        lines.push(
          `- Ratio: ${((doc.tokensUsed / Math.max(1, doc.budgetHardCap)) * 100).toFixed(0)}%`,
        );
        lines.push('');

        if (doc.nextAction) {
          lines.push(`### Next Action`);
          lines.push(doc.nextAction);
          lines.push('');
        }

        checkpointContent = lines.join('\n');
      } else {
        // No checkpoint found — use fallback
        checkpointContent = `## Session State\n\nNo checkpoint data available. Continue from the last known state.`;
      }

      const truncated = fitToCap(checkpointContent, cap);
      return { name: 'sessionState', cap, used: estimateTokens(truncated), content: truncated };
    } catch (e) {
      getGlobalLogger().warn('RebuildPrompt', 'Failed to build session section', {
        error: (e as Error)?.message,
        runId,
      });
      const fallback = `## Session State\n\nUnable to load checkpoint. Continue from the last known state.`;
      return { name: 'sessionState', cap, used: estimateTokens(fallback), content: fallback };
    }
  }

  private buildRecentSection(recentUserMessages: LLMMessage[], cap: number): RebuildSection {
    if (recentUserMessages.length === 0) {
      return { name: 'recentUserMessages', cap, used: 0, content: '' };
    }

    // Keep the last 3 user+assistant turn pairs, capped by token budget
    const kept: LLMMessage[] = [];
    let tokens = 0;

    for (let i = recentUserMessages.length - 1; i >= 0 && tokens < cap; i--) {
      const msg = recentUserMessages[i];
      const content = typeof msg.content === 'string' ? msg.content : '';
      const msgTokens = estimateTokens(content) + 10;
      if (tokens + msgTokens > cap) break;
      kept.unshift(msg); // Preserve order
      tokens += msgTokens;
    }

    return {
      name: 'recentUserMessages',
      cap,
      used: tokens,
      content: `${kept.length} recent messages carried forward`,
    };
  }

  private async buildMemorySection(goal: string, cap: number): Promise<RebuildSection> {
    try {
      // Dynamically import ThreeLayerMemory
      const { getGlobalThreeLayerMemory } = await import('../threeLayerMemory');
      const memory = getGlobalThreeLayerMemory();

      // Search for relevant memories across layers
      const episodic = memory.query({
        layer: 'episodic',
        keywords: goal.split(/\s+/).filter((w) => w.length > 3),
        limit: 5,
        importanceThreshold: 0.5,
      });

      const longTerm = memory.query({
        layer: 'longterm',
        keywords: goal.split(/\s+/).filter((w) => w.length > 3),
        limit: 5,
        importanceThreshold: 0.5,
      });

      const procedural = memory.query({
        layer: 'procedural',
        keywords: goal.split(/\s+/).filter((w) => w.length > 3),
        limit: 3,
      });

      const allMemories = [...episodic, ...longTerm, ...procedural];
      if (allMemories.length === 0) {
        return { name: 'projectMemory', cap, used: 0, content: '' };
      }

      const lines: string[] = [
        `## Project Memory (from ThreeLayerMemory)`,
        ``,
        `Relevant knowledge from past sessions:`,
        ``,
      ];

      let tokensUsed = estimateTokens(lines.join('\n'));

      for (const mem of allMemories) {
        const entry = `- **[${mem.layer}]** ${mem.content.slice(0, 200)}`;
        const entryTokens = estimateTokens(entry);
        if (tokensUsed + entryTokens > cap) break;
        lines.push(entry);
        tokensUsed += entryTokens;
      }

      const content = lines.join('\n');
      return { name: 'projectMemory', cap, used: tokensUsed, content };
    } catch (e) {
      getGlobalLogger().warn('RebuildPrompt', 'Failed to build memory section', {
        error: (e as Error)?.message,
      });
      return { name: 'projectMemory', cap, used: 0, content: '' };
    }
  }

  private buildNextStepSection(stepNumber: number, rebuildCount: number): RebuildSection {
    const lines = [
      `## Instructions`,
      ``,
      `You have been rebuilt into a fresh context window (rebuild #${rebuildCount}).`,
      `The full conversation history is archived. The structured state above contains`,
      `everything you need to continue.`,
      ``,
      `**Your next step**: Review the session state above, identify the next pending`,
      `subtask or action, and continue execution. Do NOT re-execute completed subtasks.`,
      `Focus on what remains to be done.`,
    ].join('\n');

    const truncated = fitToCap(lines, SECTION_CAPS.nextStep);
    return {
      name: 'nextStep',
      cap: SECTION_CAPS.nextStep,
      used: estimateTokens(truncated),
      content: truncated,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function estimateTokens(text: string): number {
  return TokenGovernor.estimateTokens(text);
}

function fitToCap(text: string, cap: number): string {
  if (estimateTokens(text) <= cap) return text;
  // Truncate proportionally: char-based approximation
  const ratio = cap / Math.max(1, estimateTokens(text));
  const targetLen = Math.floor(text.length * ratio);
  // Try to truncate at a paragraph boundary
  const truncated = text.slice(0, targetLen);
  const lastPara = truncated.lastIndexOf('\n\n');
  if (lastPara > targetLen * 0.5) {
    return truncated.slice(0, lastPara) + '\n\n...[truncated to fit token budget]';
  }
  return truncated + '\n...[truncated to fit token budget]';
}

function markRebuilt(content: string): string {
  return `${REBUILD_MARKER}\n${content}`;
}

/**
 * Check if a message was produced by the rebuild prompt.
 */
export function isRebuilt(msg: LLMMessage): boolean {
  return typeof msg.content === 'string' && msg.content.startsWith(REBUILD_MARKER);
}

// ============================================================================
// Singleton
// ============================================================================

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const rebuildPromptSingleton = createTenantAwareSingleton(() => new RebuildPrompt());

export function getRebuildPrompt(): RebuildPrompt {
  return rebuildPromptSingleton.get();
}

export function resetRebuildPrompt(): void {
  rebuildPromptSingleton.reset();
}
