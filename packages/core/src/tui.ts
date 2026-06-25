/**
 * Commander TUI — Terminal Dashboard
 *
 * Interactive terminal UI for monitoring agent execution, browsing session history,
 * and viewing system status in real-time.
 *
 * Usage:
 *   commander tui
 *
 * Keyboard shortcuts:
 *   q / Ctrl+C    — Quit
 *   Tab           — Cycle panel focus
 *   r             — Refresh sessions
 *   c             — Clear event log
 *   /             — Filter events
 *   1-4           — Switch tab in event panel
 *   ?             — Show help
 *   s             — Toggle session detail
 *   Enter         — Apply filter (when filter input focused)
 */

import * as blessed from 'blessed';
import type { Widgets } from 'blessed';
import { getMessageBus } from './runtime/messageBus';
import type { MessageBusTopic, BusMessage } from './runtime/types';
import { StateCheckpointer } from './runtime/stateCheckpointer';
import { getGlobalLogger } from './logging';
import { detectProvider, getEffectiveModel } from './config/commanderConfig';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Types
// ============================================================================

interface TUIOptions {
  /** Path to state checkpointer directory (default: ~/.commander/state) */
  stateDir?: string;
}

interface LogEntry {
  timestamp: string;
  topic: string;
  source: string;
  payload: string;
  priority: string;
}

// ============================================================================
// TUI Application
// ============================================================================

export class CommanderTUI {
  private screen: Widgets.Screen;
  private eventLogBox: Widgets.BoxElement;
  private eventList: Widgets.ListElement;
  private sessionBox: Widgets.BoxElement;
  private sessionList: Widgets.ListElement;
  private metricsBox: Widgets.BoxElement;
  private filterInput: Widgets.TextboxElement;
  private statusBar: Widgets.BoxElement;
  private headerBox: Widgets.BoxElement;
  private tabBar: Widgets.BoxElement;
  private helpOverlay: Widgets.BoxElement | null = null;

  private logs: LogEntry[] = [];
  private filteredLogs: LogEntry[] = [];
  private filterText = '';
  private activeTab = 0;
  private sessions: Array<{ runId: string; task: string; status: string; timestamp: string }> = [];
  private isRunning = true;
  private stateDir: string;
  private checkpointer: StateCheckpointer;
  private unsubBus: (() => void) | null = null;
  private startTime = Date.now();

  // Live metrics
  private metrics = {
    agentsStarted: 0,
    agentsCompleted: 0,
    agentsFailed: 0,
    toolCalls: 0,
    totalTokens: 0,
    alerts: 0,
  };

  // Labels for the event tabs
  private readonly TAB_LABELS = ['All', 'Agents', 'Tools', 'System'];

  constructor(options: TUIOptions = {}) {
    this.stateDir = options.stateDir ?? path.join(os.homedir(), '.commander', 'state');
    this.checkpointer = new StateCheckpointer(this.stateDir);

    // ── Screen ──────────────────────────────────────────────────────
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Commander TUI — Agent Dashboard',
      cursor: { artificial: true, blink: true, shape: 'block' as const, color: 'white' },
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

    // ── Tab Bar ─────────────────────────────────────────────────────
    this.tabBar = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: '100%',
      height: 1,
      content: '',
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    // ── Event Log Panel (left + center) ─────────────────────────────
    this.eventLogBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: '65%',
      height: '100%-7',
      label: ' Event Log ',
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        label: { fg: 'cyan', bold: true },
      },
      scrollable: false,
    });

    this.eventList = blessed.list({
      parent: this.eventLogBox,
      top: 0,
      left: 1,
      width: '100%-2',
      height: '100%-1',
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '│',
        track: { bg: 'black' },
        style: { bg: 'cyan' },
      },
      style: {
        fg: 'white',
        bg: 'black',
        selected: { bg: 'blue' },
        scrollbar: { bg: 'cyan' },
      },
      items: [' Waiting for events...'],
    });

    // ── Session History Panel (right) ───────────────────────────────
    this.sessionBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: '65%',
      width: '35%',
      height: '100%-7',
      label: ' Sessions ',
      border: { type: 'line' },
      style: {
        border: { fg: 'green' },
        label: { fg: 'green', bold: true },
      },
    });

    this.sessionList = blessed.list({
      parent: this.sessionBox,
      top: 0,
      left: 1,
      width: '100%-2',
      height: '100%-1',
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '│',
        track: { bg: 'black' },
        style: { bg: 'green' },
      },
      style: {
        fg: 'white',
        bg: 'black',
        selected: { bg: 'green' },
        scrollbar: { bg: 'green' },
      },
      items: [' Loading sessions...'],
    });

    // ── Metrics Panel (bottom-left) ──────────────────────────────────
    this.metricsBox = blessed.box({
      parent: this.screen,
      bottom: 1,
      left: 0,
      width: '65%',
      height: 3,
      label: ' Metrics ',
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'yellow' },
        label: { fg: 'yellow', bold: true },
        fg: 'white',
        bg: 'black',
      },
    });

    // ── Filter input ────────────────────────────────────────────────
    this.filterInput = blessed.textbox({
      parent: this.screen,
      top: '100%-4',
      left: 0,
      width: '100%',
      height: 1,
      label: ' Filter ',
      inputOnFocus: true,
      style: {
        fg: 'white',
        bg: 'black',
        focus: { bg: 'blue' },
      },
      border: { type: 'line' },
      hidden: true,
    });

    // ── Status Bar ──────────────────────────────────────────────────
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: '',
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    // ── Key bindings ────────────────────────────────────────────────
    this.screen.key(['q', 'C-c'], () => this.stop());
    this.screen.key(['tab'], () => this.cycleFocus());
    this.screen.key(['r'], () => this.refreshSessions());
    this.screen.key(['c'], () => this.clearLogs());
    this.screen.key(['/'], () => this.toggleFilter());
    this.screen.key(['1'], () => this.switchTab(0));
    this.screen.key(['2'], () => this.switchTab(1));
    this.screen.key(['3'], () => this.switchTab(2));
    this.screen.key(['4'], () => this.switchTab(3));
    this.screen.key(['?'], () => this.toggleHelp());
    this.screen.key(['escape'], () => {
      if (this.helpOverlay) {
        this.hideHelp();
      } else if (this.filterInput.hidden === false) {
        this.hideFilter();
      }
    });

    // ── Resize ───────────────────────────────────────────────────────
    this.screen.on('resize', () => {
      this.renderHeader();
      this.renderTabs();
      this.renderEvents();
      this.renderSessions();
      this.renderMetrics();
      this.renderStatus();
      this.screen.render();
    });
  }

  // ======================================================================
  // Public API
  // ======================================================================

  /** Start the TUI — subscribes to events, renders, and enters event loop. */
  start(): void {
    this.renderHeader();
    this.renderTabs();
    this.renderMetrics();
    this.renderStatus();
    this.screen.render();

    // Subscribe to message bus
    const bus = getMessageBus();
    const topics: MessageBusTopic[] = [
      'agent.started',
      'agent.completed',
      'agent.failed',
      'agent.message',
      'mission.updated',
      'mission.blocked',
      'mission.completed',
      'system.alert',
      'tool.executed',
    ];
    this.unsubBus = bus.subscribeMany(topics, (msg: BusMessage) => {
      this.onBusMessage(msg);
    });

    // Load sessions
    this.refreshSessions();

    // Periodic refresh
    const refreshInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(refreshInterval);
        return;
      }
      this.renderMetrics();
      this.renderStatus();
      this.screen.render();
    }, 5000);
    refreshInterval.unref();

    // Focus the event list by default
    this.eventList.focus();

    // Render loop
    this.screen.render();
  }

  /** Stop the TUI and clean up. */
  stop(): void {
    this.isRunning = false;
    if (this.unsubBus) {
      this.unsubBus();
      this.unsubBus = null;
    }
    this.screen.destroy();
    process.exit(0);
  }

  // ======================================================================
  // Event Handlers
  // ======================================================================

  private onBusMessage(msg: BusMessage): void {
    const payloadStr =
      typeof msg.payload === 'object'
        ? JSON.stringify(msg.payload).slice(0, 120)
        : String(msg.payload ?? '').slice(0, 120);

    const entry: LogEntry = {
      timestamp: new Date(msg.timestamp || Date.now()).toLocaleTimeString(),
      topic: msg.topic,
      source: msg.source,
      payload: payloadStr,
      priority: msg.priority ?? 'normal',
    };

    // Track metrics
    switch (msg.topic) {
      case 'agent.started':
        this.metrics.agentsStarted++;
        break;
      case 'agent.completed':
        this.metrics.agentsCompleted++;
        break;
      case 'agent.failed':
        this.metrics.agentsFailed++;
        break;
      case 'tool.executed':
        this.metrics.toolCalls++;
        break;
      case 'system.alert':
        this.metrics.alerts++;
        break;
    }
    if (msg.payload && typeof msg.payload === 'object' && 'totalTokens' in msg.payload) {
      this.metrics.totalTokens += (msg.payload as { totalTokens?: number }).totalTokens ?? 0;
    }

    this.logs.push(entry);
    if (this.logs.length > 500) {
      this.logs.splice(0, this.logs.length - 300);
    }

    this.renderEvents();
    this.renderMetrics();
    this.renderStatus();
    this.screen.render();
  }

  // ======================================================================
  // Rendering
  // ======================================================================

  private renderHeader(): void {
    const width = Number(this.screen.width) || 120;
    const title = ' Commander TUI — Agent Dashboard ';
    const stats = ` ${this.logs.length} events  |  ${this.sessions.length} sessions `;
    const padding = Math.max(0, width - title.length - stats.length - 2);
    this.headerBox.setContent(`{bold}${title}{/bold}${' '.repeat(padding)}${stats}`);
  }

  private renderTabs(): void {
    const parts = this.TAB_LABELS.map((label, i) => {
      const active = i === this.activeTab;
      return active
        ? `{bold}{cyan-fg} [${label}] {/cyan-fg}{/bold}`
        : ` {white-fg}[${label}]{/white-fg} `;
    });
    const filterHint = this.filterText
      ? ` {yellow-fg}(filter: ${this.filterText}){/yellow-fg}`
      : '';
    this.tabBar.setContent(parts.join('│') + filterHint);
  }

  private renderEvents(): void {
    // Apply filter
    this.filteredLogs = this.filterText
      ? this.logs.filter(
          (e) =>
            e.topic.toLowerCase().includes(this.filterText.toLowerCase()) ||
            e.source.toLowerCase().includes(this.filterText.toLowerCase()) ||
            e.payload.toLowerCase().includes(this.filterText.toLowerCase()),
        )
      : this.logs;

    // Apply tab filter
    const tabFiltered = this.filterByTab(this.filteredLogs);

    if (tabFiltered.length === 0) {
      const welcomeLine =
        this.logs.length === 0
          ? ' {bold}Welcome to Commander TUI{/bold}  —  waiting for agent events...'
          : ' (no events)';
      this.eventList.setItems([welcomeLine]);
      return;
    }

    const items = tabFiltered.map((e) => {
      const icon = this.iconForTopic(e.topic);
      const priorityColor = e.priority === 'high' ? '{red-fg}' : '';
      return `${priorityColor}{${this.colorForTopic(e.topic)}-fg}${e.timestamp}{/} ${icon} {bold}${e.topic}{/bold} {black-fg}${e.source}{/} ${e.payload.slice(0, 80)}`;
    });

    // Keep scroll position
    const scrollY = this.eventList.childBase ?? 0;
    this.eventList.setItems(items);
    if (items.length > 0) {
      this.eventList.setScrollPerc(Math.min(100, (scrollY / Math.max(1, items.length)) * 100));
    }
  }

  private renderSessions(): void {
    if (this.sessions.length === 0) {
      this.sessionList.setItems([' (no sessions)']);
      return;
    }

    const items = this.sessions.slice(0, 30).map((s) => {
      const statusColor =
        s.status === 'completed' || s.status === 'SUCCESS'
          ? 'green'
          : s.status === 'failed' || s.status === 'FAILED'
            ? 'red'
            : 'yellow';
      const time = new Date(s.timestamp).toLocaleString();
      return `${time.slice(0, 10)} {${statusColor}-fg}${s.status.padEnd(10)}{/} {bold}${s.task.slice(0, 35)}{/bold}`;
    });

    this.sessionList.setItems(items);
  }

  private renderMetrics(): void {
    const m = this.metrics;
    const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
    const agents =
      `{green-fg}${m.agentsCompleted}{/green-fg}/{cyan-fg}${m.agentsStarted}{/cyan-fg}` +
      (m.agentsFailed > 0 ? ` {red-fg}${m.agentsFailed}✗{/red-fg}` : '');
    const line1 = ` Agents: ${agents}  |  Tools: {yellow-fg}${m.toolCalls}{/yellow-fg}  |  Tokens: {yellow-fg}${m.totalTokens.toLocaleString()}{/yellow-fg}`;
    const line2 = ` Alerts: ${m.alerts > 0 ? `{red-fg}${m.alerts}{/red-fg}` : '0'}  |  Uptime: ${uptime}s`;
    this.metricsBox.setContent(line1 + '\n' + line2);
  }

  private renderStatus(): void {
    const now = new Date();
    const content = ` {bold}Keys:{/bold} [q]uit [1-4]tabs [r]efresh [c]lear [/]filter [?]help  |  {bold}Events:{/bold} ${this.logs.length}  |  {bold}Sessions:{/bold} ${this.sessions.length}  |  ${now.toLocaleTimeString()}`;
    this.statusBar.setContent(content);
  }

  private toggleHelp(): void {
    if (this.helpOverlay) {
      this.hideHelp();
      return;
    }
    const provider = detectProvider();
    const model = getEffectiveModel();
    this.helpOverlay = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 56,
      height: 18,
      label: ' Help ',
      border: { type: 'line' },
      tags: true,
      style: {
        border: { fg: 'cyan' },
        label: { fg: 'cyan', bold: true },
        fg: 'white',
        bg: 'black',
      },
      content: [
        '',
        '  {bold}Commander TUI — Keyboard Shortcuts{/bold}',
        '',
        '  {cyan-fg}q / Ctrl+C{/cyan-fg}    Quit',
        '  {cyan-fg}Tab{/cyan-fg}           Cycle panel focus',
        '  {cyan-fg}1-4{/cyan-fg}           Switch event tab',
        '  {cyan-fg}r{/cyan-fg}             Refresh sessions',
        '  {cyan-fg}c{/cyan-fg}             Clear event log',
        '  {cyan-fg}/{/cyan-fg}              Filter events',
        '  {cyan-fg}?{/cyan-fg}              Toggle this help',
        '  {cyan-fg}Escape{/cyan-fg}        Close overlay / filter',
        '',
        `  {bold}Provider:{/bold} ${provider?.type ?? 'none'} · ${model}`,
        `  {bold}Events:{/bold} ${this.logs.length}  {bold}Sessions:{/bold} ${this.sessions.length}`,
        '',
        '  {dim}Press ? or Escape to close{/dim}',
      ].join('\n'),
    });
    this.helpOverlay.focus();
    this.screen.render();
  }

  private hideHelp(): void {
    if (this.helpOverlay) {
      this.helpOverlay.destroy();
      this.helpOverlay = null;
      this.eventList.focus();
      this.screen.render();
    }
  }

  // ======================================================================
  // Actions
  // ======================================================================

  private refreshSessions(): void {
    try {
      const checkpoints = this.checkpointer.listCheckpoints();
      if (checkpoints && checkpoints.length > 0) {
        this.sessions = checkpoints
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .map((c) => ({
            runId: c.runId,
            task: c.phase ?? 'unknown',
            status: c.phase ?? 'unknown',
            timestamp: c.timestamp,
          }));
      }
    } catch (err) {
      getGlobalLogger().warn('TUI', 'Failed to load sessions', { error: (err as Error)?.message });
      this.sessions = [];
    }
    this.renderHeader();
    this.renderSessions();
    this.screen.render();
  }

  private clearLogs(): void {
    this.logs = [];
    this.filteredLogs = [];
    this.metrics = {
      agentsStarted: 0,
      agentsCompleted: 0,
      agentsFailed: 0,
      toolCalls: 0,
      totalTokens: 0,
      alerts: 0,
    };
    this.renderEvents();
    this.renderMetrics();
    this.renderHeader();
    this.renderStatus();
    this.screen.render();
  }

  private toggleFilter(): void {
    if (this.filterInput.hidden) {
      this.filterInput.show();
      this.filterInput.focus();
      this.screen.render();
    } else {
      this.hideFilter();
    }
  }

  private hideFilter(): void {
    this.filterInput.hide();
    this.filterInput.setContent('');
    this.filterText = '';
    this.eventList.focus();
    this.renderTabs();
    this.renderEvents();
    this.screen.render();
  }

  private switchTab(index: number): void {
    if (index >= 0 && index < this.TAB_LABELS.length) {
      this.activeTab = index;
      this.renderTabs();
      this.renderEvents();
      this.screen.render();
    }
  }

  private cycleFocus(): void {
    const focusable = [this.eventList, this.sessionList, this.filterInput];
    const currentIdx = focusable.findIndex((el) => el === this.screen.focused);
    const nextIdx = (currentIdx + 1) % focusable.length;
    focusable[nextIdx].focus();
    this.screen.render();
  }

  // ======================================================================
  // Helpers
  // ======================================================================

  private filterByTab(entries: LogEntry[]): LogEntry[] {
    switch (this.activeTab) {
      case 1: // Agents
        return entries.filter((e) => e.topic.startsWith('agent.'));
      case 2: // Tools
        return entries.filter((e) => e.topic === 'tool.executed');
      case 3: // System
        return entries.filter(
          (e) => e.topic.startsWith('system.') || e.topic.startsWith('mission.'),
        );
      default:
        return entries;
    }
  }

  private iconForTopic(topic: string): string {
    switch (topic) {
      case 'agent.started':
        return '▶';
      case 'agent.completed':
        return '✓';
      case 'agent.failed':
        return '✗';
      case 'agent.message':
        return '◆';
      case 'system.alert':
        return '▲';
      case 'tool.executed':
        return '⚙';
      case 'mission.updated':
        return '◈';
      case 'mission.blocked':
        return '⊘';
      case 'mission.completed':
        return '●';
      default:
        return '·';
    }
  }

  private colorForTopic(topic: string): string {
    if (topic.startsWith('agent.')) return 'cyan';
    if (topic.startsWith('tool.')) return 'yellow';
    if (topic.startsWith('system.')) return 'red';
    if (topic.startsWith('mission.')) return 'green';
    return 'white';
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * Start the Commander TUI dashboard.
 * Call this from the CLI `tui` command handler.
 */
export function startTUI(options?: TUIOptions): void {
  const tui = new CommanderTUI(options);
  tui.start();
}
