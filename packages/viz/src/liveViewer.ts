/**
 * liveViewer.ts — Subscribes to Commander's MessageBus for real-time
 * execution topology visualization.
 *
 * Imports from packages/core at runtime — users must have core available.
 * Falls back to file read mode if bus is unavailable.
 */

import type { ExecutionData, TraceEvent } from './topology';
import { renderSummary, buildTree, renderTree } from './topology';
import { cursorHide, cursorShow, clearScreen, cursorAt, fg, dim } from './ansi';

// ---------------------------------------------------------------------------
// Live Viewer
// ---------------------------------------------------------------------------

export interface LiveViewerOptions {
  /** Refresh interval in ms */
  refreshMs: number;
  /** Show token counts */
  showTokens: boolean;
  /** Show timing */
  showTiming: boolean;
}

const DEFAULT_OPTS: LiveViewerOptions = {
  refreshMs: 200,
  showTokens: true,
  showTiming: true,
};

export class LiveViewer {
  private events: TraceEvent[] = [];
  private runId = '';
  private agentId = 'unknown';
  private startedAt = '';
  private topology = '';
  private effort = '';
  private goal = '';
  private opts: LiveViewerOptions;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private frameCount = 0;

  constructor(opts?: Partial<LiveViewerOptions>) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /** Add a trace event from a bus subscriber or SSE stream */
  pushEvent(event: TraceEvent): void {
    this.events.push(event);
    if (!this.runId && event.runId) this.runId = event.runId;
    if (!this.agentId || this.agentId === 'unknown') this.agentId = event.agentId;
    if (!this.startedAt || event.timestamp < this.startedAt) this.startedAt = event.timestamp;
    // Keep buffer bounded
    if (this.events.length > 5000) {
      this.events = this.events.slice(-4000);
    }
  }

  setMeta(meta: { topology?: string; effort?: string; goal?: string }): void {
    if (meta.topology) this.topology = meta.topology;
    if (meta.effort) this.effort = meta.effort;
    if (meta.goal) this.goal = meta.goal;
  }

  /** Start live rendering loop */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    process.stdout.write(cursorHide);
    this.render();
    this.intervalId = setInterval(() => this.render(), this.opts.refreshMs);
    if (this.intervalId.unref) this.intervalId.unref();
  }

  /** Stop live rendering */
  stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    process.stdout.write(cursorShow);
  }

  /** Render one frame */
  private render(): void {
    if (!this.isRunning) return;
    this.frameCount++;

    const execData: ExecutionData = {
      runId: this.runId || 'live',
      agentId: this.agentId,
      startedAt: this.startedAt || new Date().toISOString(),
      events: this.events,
      summary: computeLiveSummary(this.events),
      topology: this.topology,
      effort: this.effort,
      goal: this.goal,
    };

    const tree = buildTree(execData);

    const lines: string[] = [];
    lines.push(clearScreen);
    lines.push(cursorAt(1, 1));

    // Header
    lines.push(renderSummary(execData));
    lines.push('');

    // Tree
    const treeStr = renderTree(tree, {
      showTokens: this.opts.showTokens,
      showTiming: this.opts.showTiming,
      showCost: false,
      compact: this.events.length > 100,
      maxDepth: 8,
    });
    lines.push(treeStr);

    // Footer with live indicator
    lines.push('');
    const status = this.frameCount % 2 === 0 ? fg('green', '● LIVE') : fg('cyan', '● LIVE');
    lines.push(status + dim(` ${this.events.length} events · q to quit`));

    process.stdout.write(lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Static snapshot render (one-shot)
// ---------------------------------------------------------------------------

export function renderSnapshot(exec: ExecutionData): string {
  const tree = buildTree(exec);
  const parts: string[] = [];

  parts.push(renderSummary(exec));
  parts.push('');
  parts.push(
    renderTree(tree, {
      showTokens: true,
      showTiming: true,
      showCost: false,
      compact: false,
      maxDepth: 10,
    }),
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeLiveSummary(events: TraceEvent[]): ExecutionData['summary'] {
  let totalDurationMs = 0;
  let totalTokens = 0;
  let llmCalls = 0;
  let toolExecutions = 0;
  let errors = 0;
  for (const ev of events) {
    totalDurationMs += ev.durationMs || 0;
    if (ev.type === 'llm_call') {
      llmCalls++;
      totalTokens += ev.data?.tokenUsage?.totalTokens ?? 0;
    } else if (ev.type === 'tool_execution') toolExecutions++;
    else if (ev.type === 'error') errors++;
  }
  return {
    totalEvents: events.length,
    totalDurationMs,
    totalTokens,
    llmCalls,
    toolExecutions,
    errors,
    modelUsed: '',
  };
}

// Testing support — reset internal state
export function resetLiveViewer(v: LiveViewer): void {
  v['events'] = [];
  v['runId'] = '';
  v['frameCount'] = 0;
}
