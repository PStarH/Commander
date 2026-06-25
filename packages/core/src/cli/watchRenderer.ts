/**
 * Watch Renderer — Rich terminal visualization for agent execution
 *
 * Shows a real-time DAG of agent execution with:
 *   - ASCII task tree with state-colored nodes
 *   - Critical path highlighting
 *   - Strategy selection display (Thompson Sampling)
 *   - Token usage counter + cost accumulator
 *   - Scrollable event log
 */
import * as blessed from 'blessed';
import type { Widgets } from 'blessed';
import * as fs from 'fs';
import type { MessageBusTopic, BusMessage } from '../runtime/types';
import { reportSilentFailure } from '../silentFailureReporter';
import { getMessageBus } from '../runtime/messageBus';

// ============================================================================
// Types
// ============================================================================

interface AgentNode {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  parentId: string | null;
  children: string[];
  depth: number;
  isOnCriticalPath: boolean;
  durationMs?: number;
  tokens?: number;
}

interface WatchEvent {
  timestamp: string;
  topic: string;
  source: string;
  detail: string;
  icon: string;
}

interface WatchStats {
  totalTokens: number;
  totalCostUsd: number;
  agentsSpawned: number;
  agentsCompleted: number;
  agentsFailed: number;
  toolsCalled: number;
  topology: string;
  strategy: string;
  elapsedMs: number;
}

// ============================================================================
// Colors & Icons
// ============================================================================

const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
};

// ============================================================================
// Watch Renderer
// ============================================================================

export class WatchRenderer {
  private screen: Widgets.Screen;
  private dagBox: Widgets.BoxElement;
  private eventList: Widgets.ListElement;
  private statsBox: Widgets.BoxElement;
  private headerBox: Widgets.BoxElement;
  private statusBar: Widgets.BoxElement;

  private nodes: Map<string, AgentNode> = new Map();
  private events: WatchEvent[] = [];
  private stats: WatchStats = {
    totalTokens: 0,
    totalCostUsd: 0,
    agentsSpawned: 0,
    agentsCompleted: 0,
    agentsFailed: 0,
    toolsCalled: 0,
    topology: 'SINGLE',
    strategy: 'deliberating...',
    elapsedMs: 0,
  };

  private startTime = Date.now();
  private unsubscribers: Array<() => void> = [];
  private isRunning = true;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private logFile: number | null = null;

  constructor(logFilePath?: string) {
    if (logFilePath) {
      try {
        this.logFile = fs.openSync(logFilePath, 'a');
      } catch (err) {
        reportSilentFailure(err, 'cli/watchRenderer:128');
      }
    }
    // ── Screen ──────────────────────────────────────────────────────
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Commander — Watch Mode',
      dockBorders: true,
      fullUnicode: true,
    });

    // ── Header ──────────────────────────────────────────────────────
    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '',
      tags: true,
      style: { fg: 'white', bg: 'blue', bold: true },
    });

    // ── DAG Visualization (left, 60%) ───────────────────────────────
    this.dagBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: '60%',
      height: '100%-6',
      label: ' {bold}Task Graph{/bold} ',
      tags: true,
      border: 'line',
      style: {
        fg: 'white',
        border: { fg: 'cyan' },
        label: { fg: 'cyan', bold: true },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { style: { bg: 'cyan' } },
      keys: true,
      vi: true,
    });

    // ── Event Log (right top, 60% height) ───────────────────────────
    const eventBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: '60%',
      width: '40%',
      height: '60%-3',
      label: ' {bold}Events{/bold} ',
      tags: true,
      border: 'line',
      style: {
        fg: 'white',
        border: { fg: 'yellow' },
        label: { fg: 'yellow', bold: true },
      },
    });

    this.eventList = blessed.list({
      parent: eventBox,
      top: 0,
      left: 0,
      width: '100%-2',
      height: '100%-2',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { style: { bg: 'yellow' } },
      keys: true,
      vi: true,
      style: { fg: 'white' },
      mouse: true,
    });

    // ── Stats Panel (right bottom, 40% height) ──────────────────────
    this.statsBox = blessed.box({
      parent: this.screen,
      top: '60%',
      left: '60%',
      width: '40%',
      height: '100%-6',
      label: ' {bold}Stats{/bold} ',
      tags: true,
      border: 'line',
      style: {
        fg: 'white',
        border: { fg: 'magenta' },
        label: { fg: 'magenta', bold: true },
      },
    });

    // ── Status Bar ──────────────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '',
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    // ── Key Bindings ────────────────────────────────────────────────
    this.screen.key(['q', 'C-c'], () => {
      this.isRunning = false;
      this.cleanup();
      process.exit(0);
    });

    this.screen.key(['tab'], () => {
      this.screen.focusNext();
    });

    // Focus the DAG box by default
    this.dagBox.focus();
  }

  /** Subscribe to message bus events */
  subscribe(topics: MessageBusTopic[]): void {
    const bus = getMessageBus();
    for (const topic of topics) {
      const unsub = bus.subscribe(topic, (msg: BusMessage) => {
        this.handleEvent(msg);
      });
      this.unsubscribers.push(unsub);
    }
  }

  /** Start the render tick (100ms for smooth updates) */
  start(): void {
    this.startTime = Date.now();
    this.tickTimer = setInterval(() => this.render(), 100);
    this.tickTimer.unref();
    this.render();
  }

  /** Stop rendering and clean up */
  cleanup(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const unsub of this.unsubscribers) unsub();
    if (this.logFile !== null) {
      try {
        fs.closeSync(this.logFile);
      } catch (err) {
        reportSilentFailure(err, 'cli/watchRenderer:275');
      }
    }
    this.screen.destroy();
  }

  /** Get final stats for external reporting */
  getStats(): WatchStats {
    return { ...this.stats };
  }

  // ── Event Handling ────────────────────────────────────────────────

  private handleEvent(msg: BusMessage): void {
    const topic = msg.topic;
    const payload = msg.payload as Record<string, unknown> | undefined;
    const ts = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    // Update nodes
    if (topic === 'agent.started') {
      const id =
        (payload?.taskId as string) || (payload?.execId as string) || `agent-${this.nodes.size}`;
      const label = this.truncate(
        (payload?.goal as string) || (payload?.detail as string) || id,
        40,
      );
      this.addNode(id, label, 'running');
      this.stats.agentsSpawned++;
      this.addEvent(ts, topic, (payload?.detail as string) || label, '▶');
    } else if (topic === 'agent.completed') {
      const id = (payload?.taskId as string) || '';
      this.updateNodeStatus(id, 'completed');
      this.stats.agentsCompleted++;
      if (payload?.metrics) {
        const m = payload.metrics as Record<string, number>;
        if (m.totalTokens) this.stats.totalTokens += m.totalTokens;
        if (m.totalCostUsd) this.stats.totalCostUsd += m.totalCostUsd;
      }
      this.addEvent(ts, topic, `completed: ${id}`, '✔');
    } else if (topic === 'agent.failed') {
      const id = (payload?.taskId as string) || '';
      this.updateNodeStatus(id, 'failed');
      this.stats.agentsFailed++;
      this.addEvent(ts, topic, `failed: ${payload?.error || id}`, '✘');
    } else if (topic === 'tool.executed' || topic === 'tool.completed') {
      this.stats.toolsCalled++;
      const name = (payload?.name as string) || 'tool';
      const dur = payload?.durationMs ? ` (${payload.durationMs}ms)` : '';
      this.addEvent(ts, topic, `${name}${dur}`, '⚡');
    } else if (topic === 'tool.started') {
      const name = (payload?.name as string) || 'tool';
      this.addEvent(ts, topic, name, '◇');
    } else if (topic === 'tool.timeout') {
      this.addEvent(ts, topic, `${payload?.name} (${payload?.timeoutMs}ms)`, '⏱');
    } else if (topic === 'tool.retry') {
      this.addEvent(ts, topic, `${payload?.name} attempt ${payload?.attempt}`, '↻');
    } else if (topic === 'tool.blocked') {
      this.addEvent(ts, topic, `${payload?.name}: ${payload?.reason}`, '⊘');
    } else if (topic === 'system.alert') {
      const level = (payload?.level as string) || 'info';
      const icon = level === 'error' ? '✘' : level === 'warn' ? '⚠' : 'ℹ';
      this.addEvent(ts, topic, (payload?.message as string) || '', icon);
    } else if (topic === 'goal.started') {
      this.stats.strategy = (payload?.mode as string) || 'auto';
      this.addEvent(ts, topic, (payload?.goal as string) || '', '◉');
    } else if (topic === 'goal.decomposed') {
      this.addEvent(ts, topic, 'task decomposed', '⊕');
    } else if (topic === 'goal.completed') {
      this.addEvent(ts, topic, 'goal completed', '★');
    } else {
      this.addEvent(ts, topic, JSON.stringify(payload ?? {}).slice(0, 60), '•');
    }

    // Update topology from system alerts about topology changes
    if (topic === 'system.alert' && payload?.message) {
      const msg = payload.message as string;
      const topoMatch = msg.match(/Topology(?:\s+refined)?:\s*(\w+)/i);
      if (topoMatch) this.stats.topology = topoMatch[1];
      const stratMatch = msg.match(/selected\s+(\w+)\s+topology/i);
      if (stratMatch) this.stats.strategy = stratMatch[1];
    }
  }

  // ── Node Management ───────────────────────────────────────────────

  private addNode(id: string, label: string, status: AgentNode['status']): void {
    if (this.nodes.has(id)) {
      this.updateNodeStatus(id, status);
      return;
    }
    const depth = this.nodes.size === 0 ? 0 : 1; // simplified depth
    const node: AgentNode = {
      id,
      label,
      status,
      parentId: null,
      children: [],
      depth,
      isOnCriticalPath: this.nodes.size === 0, // first node is critical
    };
    this.nodes.set(id, node);

    // Evict completed/failed nodes when over cap
    if (this.nodes.size > 500) {
      for (const [nid, n] of this.nodes) {
        if (n.status === 'completed' || n.status === 'failed') {
          this.nodes.delete(nid);
          if (this.nodes.size <= 400) break;
        }
      }
    }

    // Link to the most recent running node as parent
    const running = Array.from(this.nodes.values()).filter(
      (n) => n.status === 'running' && n.id !== id,
    );
    if (running.length > 0) {
      const parent = running[running.length - 1];
      node.parentId = parent.id;
      parent.children.push(id);
      node.depth = parent.depth + 1;
    }
  }

  private updateNodeStatus(id: string, status: AgentNode['status']): void {
    const node = this.nodes.get(id);
    if (node) {
      node.status = status;
      if (status === 'completed' || status === 'failed') {
        node.durationMs = Date.now() - this.startTime;
      }
    }
  }

  // ── Event Log ─────────────────────────────────────────────────────

  private addEvent(timestamp: string, topic: string, detail: string, icon: string): void {
    this.events.push({ timestamp, topic, detail, icon, source: '' });
    // Keep last 200 events
    if (this.events.length > 200) this.events.shift();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  private render(): void {
    if (!this.isRunning) return;

    this.stats.elapsedMs = Date.now() - this.startTime;

    this.renderHeader();
    this.renderDAG();
    this.renderEvents();
    this.renderStats();
    this.renderStatusBar();

    this.screen.render();
  }

  private renderHeader(): void {
    const elapsed = (this.stats.elapsedMs / 1000).toFixed(1);
    const nodeArr = Array.from(this.nodes.values());
    const running = nodeArr.filter((n) => n.status === 'running').length;
    const completed = nodeArr.filter((n) => n.status === 'completed').length;
    const total = nodeArr.length;

    this.headerBox.setContent(
      ` {bold}Commander{/bold} — Watch Mode ` +
        `│ Agents: ${running > 0 ? `{cyan-fg}${running} running{/cyan-fg}` : '0 running'} ` +
        `${completed}/${total} done ` +
        `│ Topology: {cyan-fg}${this.stats.topology}{/cyan-fg} ` +
        `│ ${elapsed}s`,
    );
  }

  private renderDAG(): void {
    const lines: string[] = [];
    const nodeArr = Array.from(this.nodes.values());

    if (nodeArr.length === 0) {
      lines.push('');
      lines.push('  {gray-fg}Waiting for agents to start...{/gray-fg}');
      lines.push('');
      lines.push('  Task graph will appear here as agents spawn.');
    } else {
      lines.push('');
      lines.push(`  {bold}Task Graph{/bold} (${nodeArr.length} nodes)`);
      lines.push('');

      // Build tree view
      const roots = nodeArr.filter((n) => n.parentId === null);
      for (const root of roots) {
        this.renderNode(root, nodeArr, lines, '', true);
      }

      lines.push('');

      // Legend
      lines.push(
        '  {cyan-fg}●{/cyan-fg} running  {green-fg}✓{/green-fg} completed  {red-fg}✗{/red-fg} failed  {gray-fg}○{/gray-fg} pending',
      );

      // Critical path summary
      const critPath = nodeArr.filter((n) => n.isOnCriticalPath);
      if (critPath.length > 0) {
        lines.push(
          `  {yellow-fg}Critical path:{/yellow-fg} ${critPath.map((n) => this.truncate(n.label, 20)).join(' → ')}`,
        );
      }
    }

    this.dagBox.setContent(lines.join('\n'));
  }

  private renderNode(
    node: AgentNode,
    all: AgentNode[],
    lines: string[],
    prefix: string,
    isLast: boolean,
  ): void {
    const connector = isLast ? '└── ' : '├── ';
    const color = STATUS_COLORS[node.status] || 'white';
    const icon = STATUS_ICONS[node.status] || '○';
    const critMark = node.isOnCriticalPath ? ' {yellow-fg}★{/yellow-fg}' : '';
    const duration = node.durationMs ? ` {dim}(${(node.durationMs / 1000).toFixed(1)}s){/dim}` : '';
    const tokens = node.tokens ? ` {dim}[${node.tokens}t]{/dim}` : '';

    lines.push(
      `  ${prefix}${connector}{${color}-fg}${icon}{/${color}-fg} ` +
        `{bold}{${color}-fg}${node.label}{/${color}-fg}{/bold}` +
        critMark +
        duration +
        tokens,
    );

    // Render children
    const children = all.filter((n) => n.parentId === node.id);
    for (let i = 0; i < children.length; i++) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      this.renderNode(children[i], all, lines, childPrefix, i === children.length - 1);
    }
  }

  private renderEvents(): void {
    const visible = this.events.slice(-50); // Show last 50 events
    const items = visible.map((e) => {
      const color = this.topicColor(e.topic);
      return ` {dim}${e.timestamp}{/dim} {${color}-fg}${e.icon}{/${color}-fg} {${color}-fg}${this.truncate(e.detail, 45)}{/${color}-fg}`;
    });
    this.eventList.setItems(items);
    this.eventList.setScrollPerc(100);
  }

  private renderStats(): void {
    const s = this.stats;
    const elapsed = (s.elapsedMs / 1000).toFixed(1);
    const tokensK =
      s.totalTokens > 1000 ? `${(s.totalTokens / 1000).toFixed(1)}K` : String(s.totalTokens);

    const lines = [
      '',
      `  {bold}Topology{/bold}     {cyan-fg}${s.topology}{/cyan-fg}`,
      `  {bold}Strategy{/bold}     {cyan-fg}${s.strategy}{/cyan-fg}`,
      '',
      `  {bold}Agents{/bold}       ${s.agentsSpawned} spawned`,
      `               {green-fg}${s.agentsCompleted} completed{/green-fg}`,
      s.agentsFailed > 0 ? `               {red-fg}${s.agentsFailed} failed{/red-fg}` : '',
      '',
      `  {bold}Tools{/bold}        ${s.toolsCalled} calls`,
      `  {bold}Tokens{/bold}       ${tokensK}`,
      `  {bold}Cost{/bold}         $${s.totalCostUsd.toFixed(4)}`,
      `  {bold}Elapsed{/bold}      ${elapsed}s`,
    ].filter(Boolean);

    this.statsBox.setContent(lines.join('\n'));
  }

  private renderStatusBar(): void {
    const focusName =
      this.screen.focused === this.dagBox
        ? 'Graph'
        : this.screen.focused === this.eventList
          ? 'Events'
          : this.screen.focused === this.statsBox
            ? 'Stats'
            : '';

    this.statusBar.setContent(
      ` {bold}q{/bold} quit  {bold}Tab{/bold} focus [${focusName}]  ` +
        `{bold}↑↓{/bold} scroll  ` +
        `│ {dim}Commander Watch Mode{/dim}`,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private topicColor(topic: string): string {
    if (topic.startsWith('agent.')) return 'cyan';
    if (topic.startsWith('tool.')) return 'yellow';
    if (topic.startsWith('goal.')) return 'green';
    if (topic.startsWith('system.')) return 'red';
    if (topic.startsWith('mission.')) return 'magenta';
    return 'white';
  }

  private truncate(s: string, max: number): string {
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
}

// ============================================================================
// Entry Point
// ============================================================================

/**
 * Start the watch renderer and subscribe to all relevant bus topics.
 * Returns the renderer instance so the caller can clean up after execution.
 */
export function startWatchRenderer(): WatchRenderer {
  const logFilePath = process.env.COMMANDER_LOG_FILE;
  const renderer = new WatchRenderer(logFilePath);
  const topics: MessageBusTopic[] = [
    'agent.started',
    'agent.completed',
    'agent.failed',
    'agent.message',
    'tool.started',
    'tool.completed',
    'tool.executed',
    'tool.timeout',
    'tool.retry',
    'tool.blocked',
    'system.alert',
    'mission.updated',
    'mission.completed',
    'goal.started',
    'goal.decomposed',
    'goal.round_started',
    'goal.round_completed',
    'goal.worker_started',
    'goal.worker_completed',
    'goal.worker_failed',
    'goal.completed',
  ];
  renderer.subscribe(topics);
  renderer.start();
  return renderer;
}
