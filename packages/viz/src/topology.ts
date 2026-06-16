/**
 * topology.ts — Execution topology tree builder + ANSI renderer.
 *
 * Converts flat TraceEvent arrays into a tree structure using
 * parentSpanId links, then renders as a Unicode topology graph.
 */

import {
  fg, dim, bold, formatDuration, formatTokens,
  BOX, type ColorName,
} from './ansi';

// Types (subset of runtime types — avoids importing packages/core)

export interface TraceEvent {
  id: string;
  spanId: string;
  traceId: string;
  runId: string;
  agentId: string;
  type: 'llm_call' | 'tool_execution' | 'decision' | 'error' | 'state_change' | 'verification';
  timestamp: string;
  durationMs: number;
  data: {
    input?: unknown;
    output?: unknown;
    error?: string;
    modelInfo?: { model: string; provider: string; tier?: string };
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    evaluationScore?: number;
    evaluationPassed?: boolean;
  };
  parentSpanId?: string;
}

export interface ExecutionSummary {
  totalEvents: number;
  totalDurationMs: number;
  totalTokens: number;
  llmCalls: number;
  toolExecutions: number;
  errors: number;
  modelUsed: string;
}

export interface ExecutionData {
  runId: string;
  agentId: string;
  startedAt: string;
  completedAt?: string;
  events: TraceEvent[];
  summary: ExecutionSummary;
  topology?: string;
  effort?: string;
  goal?: string;
}

// ---------------------------------------------------------------------------
// Visual Tree Node
// ---------------------------------------------------------------------------

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface VizNode {
  id: string;
  label: string;
  type: 'root' | 'agent' | 'llm_call' | 'tool_execution' | 'decision' | 'error' | 'verification';
  status: NodeStatus;
  depth: number;
  durationMs?: number;
  tokens?: number;
  cost?: number;
  error?: string;
  children: VizNode[];
}

// ---------------------------------------------------------------------------
// Tree Builder
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<NodeStatus, ColorName> = {
  pending: 'gray',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
  skipped: 'gray',
};

const TYPE_ICONS: Record<VizNode['type'], string> = {
  root: '📋',
  agent: '●',
  llm_call: '◇',
  tool_execution: '⚡',
  decision: '◆',
  error: '✗',
  verification: '✓',
};

export function buildTree(data: ExecutionData): VizNode {
  const events = data.events;

  const root: VizNode = {
    id: 'root',
    label: data.goal || data.agentId || data.runId,
    type: 'root',
    status: data.completedAt ? 'completed' : 'running',
    depth: 0,
    children: [],
  };

  // Build spanId → VizNode map + child list
  const nodeMap = new Map<string, VizNode>();
  const spanToAgent = new Map<string, string>();

  // First pass: identify agent boundaries from runId/agentId
  // Agent runs are the top-level containers — their spans are the main tree
  const agentNodes = new Map<string, VizNode>();

  // Collect events by agent ID for grouping
  const eventsByAgent = new Map<string, TraceEvent[]>();
  for (const ev of events) {
    const aid = ev.agentId || 'default';
    if (!eventsByAgent.has(aid)) eventsByAgent.set(aid, []);
    eventsByAgent.get(aid)!.push(ev);
  }

  // Create agent-level nodes
  for (const [agentId, agentEvents] of eventsByAgent) {
    if (agentId === 'unknown' || agentId === 'default') continue;

    const firstEvent = agentEvents[0];
    const lastEvent = agentEvents[agentEvents.length - 1];
    const totalAgentTokens = agentEvents.reduce(
      (sum, e) => sum + (e.data?.tokenUsage?.totalTokens ?? 0), 0
    );
    const agentDur = firstEvent && lastEvent
      ? new Date(lastEvent.timestamp).getTime() - new Date(firstEvent.timestamp).getTime()
      : undefined;

    const agentNode: VizNode = {
      id: `agent:${agentId}`,
      label: agentId.length > 40 ? agentId.slice(0, 39) + '…' : agentId,
      type: 'agent',
      status: hasFailedEvents(agentEvents) ? 'failed' : 'completed',
      depth: 1,
      durationMs: agentDur,
      tokens: totalAgentTokens,
      children: [],
    };
    agentNodes.set(agentId, agentNode);
    root.children.push(agentNode);

    // Second pass: build children under agent using parentSpanId
    const agentEventsBySpan = new Map<string, TraceEvent>();
    const childEvents: TraceEvent[] = [];

    for (const ev of agentEvents) {
      if (ev.parentSpanId && agentEventsBySpan.has(ev.parentSpanId)) {
        childEvents.push(ev);
      } else {
        agentEventsBySpan.set(ev.spanId, ev);
      }
    }

    // Match children to parents
    const childNodes = new Map<string, VizNode>();
    for (const ev of agentEvents) {
      if (ev.type === 'llm_call') {
        const n: VizNode = {
          id: ev.spanId,
          label: shortModelName(ev.data?.modelInfo?.model || 'LLM'),
          type: 'llm_call',
          status: 'completed',
          depth: 2,
          durationMs: ev.durationMs,
          tokens: ev.data?.tokenUsage?.totalTokens,
          children: [],
        };
        childNodes.set(ev.spanId, n);
        spanToAgent.set(ev.spanId, agentId);
      } else if (ev.type === 'tool_execution') {
        const n: VizNode = {
          id: ev.spanId,
          label: String(ev.data?.output && typeof ev.data.output === 'object'
            && 'name' in (ev.data.output as Record<string, unknown>)
            ? (ev.data.output as Record<string, string>).name : extractToolName(ev.data)),
          type: 'tool_execution',
          status: ev.data?.error ? 'failed' : 'completed',
          depth: 2,
          durationMs: ev.durationMs,
          error: ev.data?.error,
          children: [],
        };
        childNodes.set(ev.spanId, n);
        spanToAgent.set(ev.spanId, agentId);
      } else if (ev.type === 'decision') {
        const n: VizNode = {
          id: ev.spanId,
          label: truncate(String(ev.data?.output ?? ''), 50),
          type: 'decision',
          status: 'completed',
          depth: 2,
          durationMs: ev.durationMs,
          children: [],
        };
        childNodes.set(ev.spanId, n);
      } else if (ev.type === 'error') {
        const n: VizNode = {
          id: ev.spanId,
          label: truncate(ev.data?.error ?? 'error', 50),
          type: 'error',
          status: 'failed',
          depth: 2,
          durationMs: ev.durationMs,
          error: ev.data?.error,
          children: [],
        };
        childNodes.set(ev.spanId, n);
      } else if (ev.type === 'verification') {
        const passed = ev.data?.evaluationPassed ?? true;
        const n: VizNode = {
          id: ev.spanId,
          label: passed ? 'verification passed' : 'verification FAILED',
          type: 'verification',
          status: passed ? 'completed' : 'failed',
          depth: 2,
          durationMs: ev.durationMs,
          children: [],
        };
        childNodes.set(ev.spanId, n);
      }
    }

    // Wire parentSpanId for proper nesting
    for (const [spanId, node] of childNodes) {
      const parentEv = agentEvents.find(e => e.spanId === spanId);
      if (parentEv?.parentSpanId && childNodes.has(parentEv.parentSpanId)) {
        childNodes.get(parentEv.parentSpanId)!.children.push(node);
      } else {
        agentNode.children.push(node);
      }
    }
  }

  // If no agent nodes, flatten events directly under root
  if (root.children.length === 0) {
    for (const ev of events) {
      const n = eventToNode(ev);
      if (n) root.children.push(n);
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  showTokens: boolean;
  showCost: boolean;
  showTiming: boolean;
  compact: boolean;
  maxDepth: number;
}

const DEFAULT_OPTIONS: RenderOptions = {
  showTokens: true,
  showCost: false,
  showTiming: true,
  compact: false,
  maxDepth: 10,
};

/**
 * Render the topology tree as a string with ANSI colors and Unicode box drawing.
 * Returns the complete output — caller writes to stdout.
 */
export function renderTree(node: VizNode, options?: Partial<RenderOptions>): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  // Header
  const statusColor = STATUS_COLORS[node.status];
  lines.push(
    fg('cyan', BOX.TL + BOX.H.repeat(4)) + ' ' +
    bold(fg('white', node.label))
  );

  // Summary bar
  const summaryParts: string[] = [];
  if (node.tokens !== undefined) summaryParts.push(formatTokens(node.tokens));
  if (node.durationMs !== undefined) summaryParts.push(formatDuration(node.durationMs));
  if (summaryParts.length > 0) {
    lines.push(fg('cyan', BOX.V) + ' ' + dim(summaryParts.join(' · ')));
  }
  lines.push(fg('cyan', BOX.V));

  // Recursive tree
  const totalChildren = countAllChildren(node);
  for (let i = 0; i < node.children.length; i++) {
    renderNode(node.children[i], lines, '', i === node.children.length - 1, opts, totalChildren);
  }

  return lines.join('\n');
}

function renderNode(
  n: VizNode, lines: string[], prefix: string, isLast: boolean,
  opts: RenderOptions, siblingCount: number,
): void {
  if (n.depth > opts.maxDepth) return;

  // Build tree connector
  const connector = isLast ? BOX.BL + BOX.H : BOX.T_RIGHT + BOX.H;

  // Label
  const statusColor = STATUS_COLORS[n.status] || 'white';
  const icon = n.type ? TYPE_ICONS[n.type] || '•' : '•';

  const labelParts: string[] = [fg(statusColor, icon + ' ' + n.label)];
  if (n.error) {
    // Append error indicator without adding extra spacing in compact mode
  }
  if (opts.showTiming && n.durationMs !== undefined) {
    labelParts.push(dim(' ' + formatDuration(n.durationMs)));
  }
  if (opts.showTokens && n.tokens !== undefined && n.tokens > 0) {
    labelParts.push(dim(' [' + formatTokens(n.tokens) + ']'));
  }

  // Handle error annotations
  let errorSuffix = '';
  if (n.error && !opts.compact) {
    errorSuffix = ' ' + fg('red', '✗ ' + truncate(n.error, 60));
  }

  lines.push(
    prefix + connector + ' ' + labelParts.join('') + errorSuffix
  );

  // Children
  for (let i = 0; i < n.children.length; i++) {
    const childPrefix = prefix + (isLast ? '  ' : BOX.V + ' ');
    renderNode(n.children[i], lines, childPrefix, i === n.children.length - 1, opts, siblingCount);
  }
}

/**
 * Render a compact one-line summary of the execution.
 */
export function renderSummary(exec: ExecutionData): string {
  const s = exec.summary;
  const parts: string[] = [];
  parts.push(fg('cyan', bold('execution')));
  parts.push(dim(exec.runId.slice(0, 8)));
  if (exec.topology) parts.push(fg('magenta', exec.topology));
  if (exec.effort) parts.push(fg('yellow', exec.effort));
  parts.push(dim(`${s.totalEvents} events`));
  parts.push(formatDuration(s.totalDurationMs));
  parts.push(formatTokens(s.totalTokens));
  if (s.errors > 0) parts.push(fg('red', `${s.errors} errors`));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFailedEvents(events: TraceEvent[]): boolean {
  return events.some(e => e.type === 'error' || (e.type === 'verification' && e.data?.evaluationPassed === false));
}

function eventToNode(ev: TraceEvent): VizNode | null {
  if (ev.type === 'llm_call') {
    return {
      id: ev.spanId,
      label: shortModelName(ev.data?.modelInfo?.model || 'LLM'),
      type: 'llm_call',
      status: 'completed',
      depth: 1,
      durationMs: ev.durationMs,
      tokens: ev.data?.tokenUsage?.totalTokens,
      children: [],
    };
  }
  if (ev.type === 'tool_execution') {
    return {
      id: ev.spanId,
      label: extractToolName(ev.data),
      type: 'tool_execution',
      status: ev.data?.error ? 'failed' : 'completed',
      depth: 1,
      durationMs: ev.durationMs,
      error: ev.data?.error,
      children: [],
    };
  }
  return null;
}

function countAllChildren(n: VizNode): number {
  let count = n.children.length;
  for (const c of n.children) count += countAllChildren(c);
  return count;
}

function shortModelName(model: string): string {
  if (!model) return 'LLM';
  // Strip provider prefix, keep short name
  const parts = model.split('/');
  const name = parts[parts.length - 1];
  if (name.length > 25) return name.slice(0, 24) + '…';
  return name;
}

function extractToolName(data: TraceEvent['data']): string {
  if (!data) return 'tool';
  const output = data.output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.toolName === 'string') return o.toolName;
    if (typeof o.tool === 'string') return o.tool;
  }
  const input = data.input;
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    if (typeof i.toolName === 'string') return i.toolName;
    if (typeof i.name === 'string') return i.name;
  }
  return 'tool';
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
