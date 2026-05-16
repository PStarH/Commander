import * as fs from 'fs';
import * as path from 'path';

export type MessageStatus = 'unread' | 'read' | 'acknowledged';

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: MessageStatus;
  timestamp: string;
  readAt?: string;
  acknowledgedAt?: string;
  /** Optional payload for structured data (handoff, tool result, etc.) */
  payload?: Record<string, unknown>;
  /** Time-to-live in ms from timestamp. After expiry, message is auto-purged. */
  ttlMs?: number;
  /** Tags for filtering */
  tags: string[];
}

export class AgentInbox {
  private baseDir: string;
  private inboxes = new Map<string, InboxMessage[]>();
  private dirtyAgents = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(baseDir?: string, flushIntervalMs = 5_000) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_inboxes');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.flushTimer = setInterval(() => this.flushDirty(), flushIntervalMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  dispose(): void {
    clearInterval(this.flushTimer);
    this.flushDirty();
  }

  /** Send a message to an agent's inbox */
  send(msg: Omit<InboxMessage, 'status' | 'timestamp'>): void {
    const full: InboxMessage = {
      ...msg,
      status: 'unread',
      timestamp: new Date().toISOString(),
    };
    const inbox = this.getOrCreateInbox(msg.to);
    inbox.push(full);
    this.dirtyAgents.add(msg.to);
  }

  /** Get all messages for an agent, optionally filtered by status */
  getMessages(agentId: string, status?: MessageStatus): InboxMessage[] {
    const inbox = this.getOrCreateInbox(agentId);
    let msgs = [...inbox];
    if (status) msgs = msgs.filter(m => m.status === status);
    return msgs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Get unread messages for an agent */
  pollInbox(agentId: string): InboxMessage[] {
    const inbox = this.getOrCreateInbox(agentId);
    const unread: InboxMessage[] = [];
    for (const msg of inbox) {
      if (msg.status === 'unread') {
        msg.status = 'read';
        msg.readAt = new Date().toISOString();
        unread.push(msg);
        this.dirtyAgents.add(agentId);
      }
    }
    return unread;
  }

  /** Mark a message as acknowledged (fully processed) */
  acknowledge(agentId: string, messageId: string): boolean {
    const inbox = this.getOrCreateInbox(agentId);
    const msg = inbox.find(m => m.id === messageId);
    if (!msg) return false;
    msg.status = 'acknowledged';
    msg.acknowledgedAt = new Date().toISOString();
    this.dirtyAgents.add(agentId);
    return true;
  }

  /** Delete a message from an agent's inbox */
  deleteMessage(agentId: string, messageId: string): boolean {
    const inbox = this.getOrCreateInbox(agentId);
    const idx = inbox.findIndex(m => m.id === messageId);
    if (idx === -1) return false;
    inbox.splice(idx, 1);
    this.dirtyAgents.add(agentId);
    return true;
  }

  /** Get inbox size for an agent */
  getInboxSize(agentId: string): number {
    return this.getOrCreateInbox(agentId).length;
  }

  /** Prune expired and acknowledged messages */
  prune(agentId?: string): number {
    const agents = agentId ? [agentId] : this.listAgents();
    let pruned = 0;
    for (const id of agents) {
      const inbox = this.getOrCreateInbox(id);
      const before = inbox.length;
      const now = Date.now();
      this.inboxes.set(
        id,
        inbox.filter(m => {
          if (m.status === 'acknowledged') return false;
          if (m.ttlMs) {
            const age = now - new Date(m.timestamp).getTime();
            if (age > m.ttlMs) return false;
          }
          return true;
        }),
      );
      const removed = before - (this.inboxes.get(id)?.length ?? 0);
      if (removed > 0) this.dirtyAgents.add(id);
      pruned += removed;
    }
    return pruned;
  }

  /** List all agents that have inboxes */
  listAgents(): string[] {
    const fromDisk = fs.readdirSync(this.baseDir)
      .filter(f => f.endsWith('.ndjson'))
      .map(f => f.replace('.ndjson', ''));
    const fromMem = Array.from(this.inboxes.keys());
    return Array.from(new Set([...fromDisk, ...fromMem]));
  }

  // ── Persistence ──

  private getOrCreateInbox(agentId: string): InboxMessage[] {
    let inbox = this.inboxes.get(agentId);
    if (inbox) return inbox;
    inbox = this.loadFromDisk(agentId);
    this.inboxes.set(agentId, inbox);
    return inbox;
  }

  private loadFromDisk(agentId: string): InboxMessage[] {
    const filePath = path.join(this.baseDir, `${agentId}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      return raw.split('\n').map(line => JSON.parse(line) as InboxMessage);
    } catch {
      return [];
    }
  }

  private flushDirty(): void {
    for (const agentId of this.dirtyAgents) {
      const inbox = this.inboxes.get(agentId);
      if (!inbox) continue;
      this.flushAgent(agentId, inbox);
    }
    this.dirtyAgents.clear();
  }

  private flushAgent(agentId: string, inbox: InboxMessage[]): void {
    const filePath = path.join(this.baseDir, `${agentId}.ndjson`);
    const tmpPath = filePath + '.tmp';
    try {
      const content = inbox.map(m => JSON.stringify(m)).join('\n') + '\n';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch { /* ok — non-critical I/O */ }
  }
}
