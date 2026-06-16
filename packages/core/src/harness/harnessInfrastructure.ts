/**
 * Harness Infrastructure — Concrete implementations of new HarnessServices methods.
 *
 * Provides:
 * - EventBus (Oh My Pi AgentEvent pub/sub)
 * - SkillsBridge (Oh My Pi SKILL.md discovery)
 * - SubAgentBridge (Oh My Pi TaskExecutor)
 * - FileWatcher (Codex notify crate)
 * - SessionStore (Codex JSONL sessions)
 * - NetworkPolicyEnforcer (Codex MITM proxy)
 * - CommandClassifier (Codex is_known_safe_command)
 * - SteerQueue (Oh My Pi Agent.steer)
 * - PatchEngine (Codex apply_patch)
 * - PlanTracker (Codex plan mode)
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { safePath } from '../tools/fileSystemTool';
import type {
  HarnessEvent,
  HarnessEventHandler,
  Unsubscribe,
  SkillRef,
  SubAgentHandle,
  SubAgentSpawnParams,
  SteerMessage,
  FileChangeEvent,
  SessionInfo,
  CommandClassification,
  CommandSafetyLevel,
  NetworkCheckResult,
  NetworkPolicy,
  PatchRequest,
  PatchResult,
  PlanItem,
  HarnessServices,
} from './harnessTypes';
import type { AgentExecutionResult } from '../runtime/types';
import { getGlobalLogger } from '../logging';

type SubAgentExecutor = (
  params: SubAgentSpawnParams,
  parentRunId: string,
  tenantId?: string,
) => Promise<AgentExecutionResult>;

// ============================================================================
// EventBus
// ============================================================================

export class EventBus {
  private handlers: Set<HarnessEventHandler> = new Set();
  private history: HarnessEvent[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = 1000) {
    this.maxHistory = maxHistory;
  }

  publish(event: HarnessEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    for (const handler of this.handlers) {
      try {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            getGlobalLogger().error('EventBus', 'Async handler error', err as Error);
          });
        }
      } catch (err) {
        getGlobalLogger().error('EventBus', 'Handler error', err as Error);
      }
    }
  }

  subscribe(handler: HarnessEventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getHistory(): HarnessEvent[] {
    return [...this.history];
  }

  clear(): void {
    this.history = [];
  }
}

// ============================================================================
// SkillsBridge
// ============================================================================

interface SkillLike {
  id: string;
  name: string;
  description: string;
  content: string;
  metadata: {
    tags: string[];
    source: 'builtin' | 'learned' | 'community' | 'user';
  };
}

interface SkillManagerLike {
  searchSkills?(query: { text?: string; tags?: string[]; limit?: number }): Promise<{ skills: SkillLike[] }>;
  getSkill?(id: string): Promise<SkillLike | null>;
  list?(query?: { tags?: string[]; limit?: number }): Promise<SkillLike[]>;
}

export class SkillsBridge {
  private manager: SkillManagerLike | undefined;

  constructor(manager?: SkillManagerLike) {
    this.manager = manager;
  }

  async load(query?: { tags?: string[]; name?: string; limit?: number }): Promise<SkillRef[]> {
    if (!this.manager) return [];
    try {
      let skills: SkillLike[] = [];
      if (this.manager.searchSkills) {
        const result = await this.manager.searchSkills({
          text: query?.name,
          tags: query?.tags,
          limit: query?.limit ?? 20,
        });
        skills = result.skills;
      } else if (this.manager.list) {
        skills = await this.manager.list({
          tags: query?.tags,
          limit: query?.limit ?? 20,
        });
      }
      return skills
        .filter((s) => !query?.name || s.name.includes(query.name) || s.id.includes(query.name))
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.metadata?.tags ?? [],
          source: (s.metadata?.source ?? 'user') as 'builtin' | 'user' | 'community' | 'learned',
          disclosure: 1 as 0 | 1 | 2,
          content: s.content,
        }));
    } catch (err) {
      getGlobalLogger().warn('SkillsBridge', 'load failed', { error: (err as Error).message });
      return [];
    }
  }

  async inject(skillId: string, currentSystemPrompt: string): Promise<string> {
    if (!this.manager?.getSkill) return currentSystemPrompt;
    try {
      const skill = await this.manager.getSkill(skillId);
      if (!skill) return currentSystemPrompt;
      return `${currentSystemPrompt}\n\n<skill id="${skillId}" name="${skill.name}">\n${skill.content}\n</skill>`;
    } catch (err) {
      getGlobalLogger().warn('SkillsBridge', 'inject failed', { error: (err as Error).message });
      return currentSystemPrompt;
    }
  }
}

// ============================================================================
// SubAgentBridge
// ============================================================================

export class SubAgentBridge {
  private executor: SubAgentExecutor | undefined;
  private handles: Map<string, SubAgentHandle> = new Map();

  setExecutor(executor: SubAgentExecutor): void {
    this.executor = executor;
  }

  async spawn(
    params: SubAgentSpawnParams,
    parentRunId: string,
    tenantId?: string,
  ): Promise<SubAgentHandle> {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const handle: SubAgentHandle = {
      id,
      goal: params.goal,
      parentRunId,
      status: 'pending',
      startedAt: Date.now(),
      allowedTools: params.allowedTools,
    };
    this.handles.set(id, handle);

    if (!this.executor) {
      handle.status = 'failed';
      handle.completedAt = Date.now();
      handle.result = {
        runId: id,
        agentId: `sub-agent-${id}`,
        status: 'failed',
        summary: 'Sub-agent executor not configured',
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: 'Sub-agent executor not configured on HarnessInfrastructure',
      };
      return handle;
    }

    handle.status = 'running';
    const runPromise = this.executor(params, parentRunId, tenantId)
      .then((result) => {
        handle.status = result.status === 'success' ? 'completed' : 'failed';
        handle.completedAt = Date.now();
        handle.result = result;
        return result;
      })
      .catch((err: Error) => {
        handle.status = 'failed';
        handle.completedAt = Date.now();
        handle.result = {
          runId: id,
          agentId: `sub-agent-${id}`,
          status: 'failed',
          summary: err.message,
          steps: [],
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: Date.now() - handle.startedAt,
          error: err.message,
        };
        throw err;
      });

    if (!params.parallel) {
      try {
        await runPromise;
      } catch {
        // ignore
      }
    } else {
      runPromise.catch(() => {
        // ignore
      });
    }

    return handle;
  }

  async wait(handle: SubAgentHandle, signal?: AbortSignal): Promise<AgentExecutionResult> {
    if (handle.status === 'completed' || handle.status === 'failed') {
      if (!handle.result) {
        return {
          runId: handle.id,
          agentId: `sub-agent-${handle.id}`,
          status: 'failed',
          summary: 'Sub-agent completed without result',
          steps: [],
          totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          totalDurationMs: 0,
        };
      }
      return handle.result;
    }
    return new Promise<AgentExecutionResult>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (handle.status === 'completed' || handle.status === 'failed') {
          clearInterval(checkInterval);
          if (handle.result) {
            resolve(handle.result);
          } else {
            reject(new Error('Sub-agent completed without result'));
          }
        }
      }, 50);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearInterval(checkInterval);
          handle.status = 'cancelled';
          handle.completedAt = Date.now();
          reject(new Error('Sub-agent wait cancelled'));
        });
      }
    });
  }

  getHandle(id: string): SubAgentHandle | undefined {
    return this.handles.get(id);
  }
}

// ============================================================================
// FileWatcher
// ============================================================================

interface WatcherEntry {
  path: string;
  handlers: Set<(event: FileChangeEvent) => void>;
  watcher: fs.FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
}

export class FileWatcher {
  private watchers: Map<string, WatcherEntry> = new Map();
  private debounceMs: number;

  constructor(debounceMs: number = 100) {
    this.debounceMs = debounceMs;
  }

  watch(filePath: string, handler: (event: FileChangeEvent) => void): Unsubscribe {
    let absolutePath: string;
    try {
      absolutePath = safePath(filePath);
    } catch {
      getGlobalLogger().warn('FileWatcher', `Cannot watch path outside workspace: ${filePath}`);
      // Return no-op unsubscribe for safety
      const noop: Unsubscribe = () => {};
      return noop;
    }
    let entry = this.watchers.get(absolutePath);
    if (!entry) {
      entry = {
        path: absolutePath,
        handlers: new Set(),
        watcher: null,
        debounceTimer: null,
      };
      this.watchers.set(absolutePath, entry);
      this.startWatching(entry);
    }
    entry.handlers.add(handler);
    return () => {
      const current = this.watchers.get(absolutePath);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.stopWatching(current);
        this.watchers.delete(absolutePath);
      }
    };
  }

  private startWatching(entry: WatcherEntry): void {
    try {
      const dir = path.dirname(entry.path);
      const filename = path.basename(entry.path);
      const watcher = fs.watch(dir, { persistent: false }, (_eventType, changedFilename) => {
        if (changedFilename !== filename) return;
        this.scheduleEvent(entry, 'modified');
      });
      watcher.on('error', (err) => {
        getGlobalLogger().warn('FileWatcher', `Watch error for ${entry.path}`, { error: err.message });
      });
      entry.watcher = watcher;
    } catch (err) {
      getGlobalLogger().warn('FileWatcher', `Failed to start watcher for ${entry.path}`, { error: (err as Error).message });
    }
  }

  private stopWatching(entry: WatcherEntry): void {
    if (entry.watcher) {
      entry.watcher.close();
      entry.watcher = null;
    }
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
  }

  private scheduleEvent(entry: WatcherEntry, type: FileChangeEvent['type']): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = setTimeout(() => {
      const event: FileChangeEvent = {
        type,
        path: entry.path,
        timestamp: Date.now(),
      };
      for (const handler of entry.handlers) {
        try {
          handler(event);
        } catch (err) {
          getGlobalLogger().error('FileWatcher', 'Handler error', err as Error);
        }
      }
      entry.debounceTimer = null;
    }, this.debounceMs);
  }

  closeAll(): void {
    for (const entry of this.watchers.values()) {
      this.stopWatching(entry);
    }
    this.watchers.clear();
  }
}

// ============================================================================
// SessionStore
// ============================================================================

const SESSION_SCHEMA_VERSION = 1;

export class SessionStore {
  private sessionDir: string;

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir ?? path.join(os.homedir(), '.commander', 'sessions');
  }

  private ensureDir(): Promise<void> {
    return fsp.mkdir(this.sessionDir, { recursive: true }).then(() => undefined);
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.json`);
  }

  async save(info: SessionInfo): Promise<void> {
    try {
      await this.ensureDir();
      const enriched: SessionInfo = { ...info, schemaVersion: SESSION_SCHEMA_VERSION };
      const tmp = `${this.filePath(info.id)}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(enriched, null, 2), 'utf-8');
      await fsp.rename(tmp, this.filePath(info.id));
    } catch (err) {
      getGlobalLogger().warn('SessionStore', 'save failed', { error: (err as Error).message });
      throw err;
    }
  }

  async load(sessionId: string): Promise<SessionInfo | null> {
    try {
      const fp = this.filePath(sessionId);
      if (!fs.existsSync(fp)) return null;
      const content = await fsp.readFile(fp, 'utf-8');
      return JSON.parse(content) as SessionInfo;
    } catch (err) {
      getGlobalLogger().warn('SessionStore', 'load failed', { sessionId, error: (err as Error).message });
      return null;
    }
  }

  async list(limit?: number): Promise<SessionInfo[]> {
    try {
      await this.ensureDir();
      const files = await fsp.readdir(this.sessionDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
      const sessions: SessionInfo[] = [];
      for (const f of jsonFiles) {
        try {
          const content = await fsp.readFile(path.join(this.sessionDir, f), 'utf-8');
          sessions.push(JSON.parse(content) as SessionInfo);
        } catch {
          // skip
        }
      }
      sessions.sort((a, b) => b.startedAt - a.startedAt);
      return limit ? sessions.slice(0, limit) : sessions;
    } catch (err) {
      getGlobalLogger().warn('SessionStore', 'list failed', { error: (err as Error).message });
      return [];
    }
  }
}

// ============================================================================
// NetworkPolicyEnforcer
// ============================================================================

export class NetworkPolicyEnforcer {
  private defaultPolicy: NetworkPolicy;

  constructor(defaultPolicy?: NetworkPolicy) {
    this.defaultPolicy = defaultPolicy ?? {
      allowedDomains: [],
      blockedDomains: [],
      allowPrivateNetworks: false,
      allowLocalProtocols: false,
    };
  }

  check(url: string, policy?: NetworkPolicy): NetworkCheckResult {
    const p = policy ?? this.defaultPolicy;
    let hostname = '';
    let protocol = '';
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname.toLowerCase();
      protocol = parsed.protocol.toLowerCase();
    } catch {
      return {
        allowed: false,
        reason: `Invalid URL: ${url}`,
        policy: 'deny',
      };
    }

    if (p.blockedDomains.some((d) => hostname.endsWith(d.toLowerCase()))) {
      return {
        allowed: false,
        reason: `Domain "${hostname}" is in blocked list`,
        policy: 'deny',
        matchedPattern: p.blockedDomains.find((d) => hostname.endsWith(d.toLowerCase())),
      };
    }

    if (p.allowedDomains.length > 0 && !p.allowedDomains.some((d) => hostname.endsWith(d.toLowerCase()))) {
      return {
        allowed: false,
        reason: `Domain "${hostname}" is not in allowed list`,
        policy: 'deny',
        matchedPattern: p.allowedDomains.find((d) => hostname.endsWith(d.toLowerCase())),
      };
    }

    if (!p.allowPrivateNetworks && this.isPrivateNetwork(hostname)) {
      return {
        allowed: false,
        reason: `Private network access disabled: ${hostname}`,
        policy: 'deny',
        matchedPattern: 'private-network',
      };
    }

    if (!p.allowLocalProtocols && (protocol === 'file:' || protocol === 'ftp:')) {
      return {
        allowed: false,
        reason: `Local protocol "${protocol}" not allowed`,
        policy: 'deny',
        matchedPattern: protocol,
      };
    }

    return {
      allowed: true,
      reason: `Allowed: ${hostname}`,
      policy: 'allow',
    };
  }

  private isPrivateNetwork(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '::1') return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  }
}

// ============================================================================
// CommandClassifier
// ============================================================================

interface CommandRule {
  pattern: RegExp;
  level: CommandSafetyLevel;
  description: string;
  autoExecuteAllowed: boolean;
  recommendation: 'allow' | 'warn' | 'block';
}

const COMMAND_RULES: CommandRule[] = [
  { pattern: /^(ls|cat|head|tail|grep|find|echo|pwd|which|wc|sort|uniq|diff|file|stat|tree|less|more)\b/, level: 'safe', description: 'Read-only file/listing command', autoExecuteAllowed: true, recommendation: 'allow' },
  { pattern: /^(git\s+(status|log|diff|show|branch|remote|tag|blame|reflog))\b/, level: 'safe', description: 'Git read operation', autoExecuteAllowed: true, recommendation: 'allow' },
  { pattern: /^(npm|pnpm|yarn)\s+(list|ls|view|info|search|outdated)\b/, level: 'safe', description: 'Package manager read', autoExecuteAllowed: true, recommendation: 'allow' },
  { pattern: /^(node|python|python3|ruby|go|rustc)\s+--?version\b/, level: 'safe', description: 'Version check', autoExecuteAllowed: true, recommendation: 'allow' },

  { pattern: /^(git\s+(add|commit|push|pull|fetch|merge|rebase|stash|cherry-pick|reset|checkout))\b/, level: 'caution', description: 'Git state-modifying command', autoExecuteAllowed: true, recommendation: 'warn' },
  { pattern: /^(npm|pnpm|yarn)\s+(install|i|add|update|upgrade|remove|rm|uninstall|run|exec)\b/, level: 'caution', description: 'Package manager write', autoExecuteAllowed: true, recommendation: 'warn' },
  { pattern: /^(mkdir|touch|cp|mv)\b/, level: 'caution', description: 'File system modification', autoExecuteAllowed: true, recommendation: 'warn' },
  { pattern: /^(chmod|chown)\b/, level: 'caution', description: 'Permission modification', autoExecuteAllowed: false, recommendation: 'warn' },

  { pattern: /^(rm|rmdir)\b/, level: 'risky', description: 'File deletion', autoExecuteAllowed: false, recommendation: 'warn' },
  { pattern: /^(curl|wget)\b/, level: 'risky', description: 'Network request', autoExecuteAllowed: false, recommendation: 'warn' },
  { pattern: /^(ssh|scp|rsync)\b/, level: 'risky', description: 'Remote file access', autoExecuteAllowed: false, recommendation: 'warn' },
  { pattern: /^(kill|pkill|killall)\b/, level: 'risky', description: 'Process termination', autoExecuteAllowed: false, recommendation: 'warn' },
  { pattern: /^(systemctl|service|launchctl)\b/, level: 'risky', description: 'System service control', autoExecuteAllowed: false, recommendation: 'warn' },

  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\b/, level: 'dangerous', description: 'Recursive force delete', autoExecuteAllowed: false, recommendation: 'block' },
  { pattern: /^(dd|mkfs|fdisk|parted)\b/, level: 'dangerous', description: 'Disk operations', autoExecuteAllowed: false, recommendation: 'block' },
  { pattern: /^(sudo|su)\b/, level: 'dangerous', description: 'Privilege escalation', autoExecuteAllowed: false, recommendation: 'block' },
  { pattern: /^(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/, level: 'dangerous', description: 'System shutdown', autoExecuteAllowed: false, recommendation: 'block' },
  { pattern: /:\(\)\s*\{.*:\|:.*\}/, level: 'dangerous', description: 'Fork bomb pattern', autoExecuteAllowed: false, recommendation: 'block' },
];

export class CommandClassifier {
  classify(command: string): CommandClassification {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        level: 'unknown',
        description: 'Empty command',
        triggers: [],
        autoExecuteAllowed: false,
        recommendation: 'warn',
      };
    }
    for (const rule of COMMAND_RULES) {
      if (rule.pattern.test(trimmed)) {
        return {
          level: rule.level,
          description: rule.description,
          triggers: [rule.pattern.source],
          autoExecuteAllowed: rule.autoExecuteAllowed,
          recommendation: rule.recommendation,
        };
      }
    }
    return {
      level: 'unknown',
      description: 'Unrecognized command',
      triggers: [],
      autoExecuteAllowed: false,
      recommendation: 'warn',
    };
  }
}

// ============================================================================
// SteerQueueImpl
// ============================================================================

export class SteerQueueImpl {
  private messages: SteerMessage[] = [];

  push(message: string, priority: number = 0, abortCurrent: boolean = false): void {
    const id = `steer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.messages.push({
      id,
      message,
      priority,
      abortCurrent,
      timestamp: Date.now(),
    });
  }

  pop(): SteerMessage | null {
    if (this.messages.length === 0) return null;
    this.messages.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.timestamp - b.timestamp);
    return this.messages.shift() ?? null;
  }

  drain(): SteerMessage[] {
    const sorted = [...this.messages].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.timestamp - b.timestamp,
    );
    this.messages = [];
    return sorted;
  }

  size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
  }
}

// ============================================================================
// PatchEngine
// ============================================================================

export class PatchEngine {
  apply(request: PatchRequest): PatchResult {
    try {
      let filePath: string;
      try {
        filePath = safePath(request.filePath);
      } catch {
        return {
          success: false,
          error: `Access denied: filePath "${request.filePath}" is outside workspace`,
          added: 0,
          removed: 0,
        };
      }
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: `File not found: ${filePath}`,
          added: 0,
          removed: 0,
        };
      }
      const original = fs.readFileSync(filePath, 'utf-8');
      const originalLines = original.split('\n');
      const hunks = [...request.hunks].sort((a, b) => b.oldStart - a.oldStart);
      const patched = [...originalLines];
      let added = 0;
      let removed = 0;

      for (const hunk of hunks) {
        const startIdx = hunk.oldStart - 1;
        if (startIdx < 0 || startIdx + hunk.oldCount > patched.length) {
          return {
            success: false,
            error: `Hunk out of bounds: oldStart=${hunk.oldStart}, oldCount=${hunk.oldCount}, file length=${patched.length}`,
            added,
            removed,
          };
        }
        const oldSlice = patched.slice(startIdx, startIdx + hunk.oldCount);
        const expectedOld = hunk.oldLines.map((l) => l.replace(/^-/, '')).join('\n');
        const actualOld = oldSlice.join('\n');
        if (expectedOld && expectedOld !== actualOld) {
          return {
            success: false,
            error: `Hunk context mismatch at line ${hunk.oldStart}`,
            added,
            removed,
          };
        }
        const newContent = hunk.newLines.map((l) => l.replace(/^\+/, ''));
        patched.splice(startIdx, hunk.oldCount, ...newContent);
        added += newContent.length;
        removed += hunk.oldCount;
      }

      const newContent = patched.join('\n');
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, newContent, 'utf-8');
      fs.renameSync(tmp, filePath);

      return {
        success: true,
        diff: this.generateDiff(original, newContent),
        added,
        removed,
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        added: 0,
        removed: 0,
      };
    }
  }

  private generateDiff(oldStr: string, newStr: string): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const lines: string[] = [];
    let i = 0;
    let j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        lines.push(` ${oldLines[i]}`);
        i++;
        j++;
      } else {
        if (i < oldLines.length) {
          lines.push(`-${oldLines[i]}`);
          i++;
        }
        if (j < newLines.length) {
          lines.push(`+${newLines[j]}`);
          j++;
        }
      }
    }
    return lines.join('\n');
  }
}

// ============================================================================
// PlanTracker
// ============================================================================

export class PlanTracker {
  private items: Map<string, PlanItem> = new Map();

  update(itemId: string, update: Partial<PlanItem>): void {
    const existing = this.items.get(itemId);
    if (!existing) {
      this.items.set(itemId, { id: itemId, title: itemId, status: 'pending', ...update });
    } else {
      this.items.set(itemId, { ...existing, ...update });
    }
  }

  getAll(): PlanItem[] {
    return Array.from(this.items.values());
  }

  get(itemId: string): PlanItem | undefined {
    return this.items.get(itemId);
  }

  clear(): void {
    this.items.clear();
  }
}

// ============================================================================
// HarnessInfrastructure — Composes all subsystems
// ============================================================================

export interface HarnessInfrastructureOptions {
  skillsManager?: SkillManagerLike;
  sessionDir?: string;
  networkPolicy?: NetworkPolicy;
  eventsBufferSize?: number;
  fileWatcherDebounceMs?: number;
}

export class HarnessInfrastructure {
  private eventBus: EventBus;
  private skillsBridge: SkillsBridge;
  private subAgentBridge: SubAgentBridge;
  private fileWatcher: FileWatcher;
  private sessionStore: SessionStore;
  private networkPolicyEnforcer: NetworkPolicyEnforcer;
  private commandClassifier: CommandClassifier;
  private steerQueue: SteerQueueImpl;
  private patchEngine: PatchEngine;
  private planTracker: PlanTracker;

  constructor(options: HarnessInfrastructureOptions = {}) {
    this.eventBus = new EventBus(options.eventsBufferSize ?? 1000);
    this.skillsBridge = new SkillsBridge(options.skillsManager);
    this.subAgentBridge = new SubAgentBridge();
    this.fileWatcher = new FileWatcher(options.fileWatcherDebounceMs ?? 100);
    this.sessionStore = new SessionStore(options.sessionDir);
    this.networkPolicyEnforcer = new NetworkPolicyEnforcer(options.networkPolicy);
    this.commandClassifier = new CommandClassifier();
    this.steerQueue = new SteerQueueImpl();
    this.patchEngine = new PatchEngine();
    this.planTracker = new PlanTracker();
  }

  setSubAgentExecutor(executor: SubAgentExecutor): void {
    this.subAgentBridge.setExecutor(executor);
  }

  buildServices(): Partial<HarnessServices> {
    return {
      publishEvent: (event: HarnessEvent) => this.eventBus.publish(event),
      subscribeEvents: (handler: HarnessEventHandler) => this.eventBus.subscribe(handler),

      loadSkills: (query?: { tags?: string[]; name?: string; limit?: number }) =>
        this.skillsBridge.load(query),
      injectSkill: (skillId: string, currentSystemPrompt: string) =>
        this.skillsBridge.inject(skillId, currentSystemPrompt),

      spawnSubAgent: (params: SubAgentSpawnParams, parentRunId: string, tenantId?: string) =>
        this.subAgentBridge.spawn(params, parentRunId, tenantId),
      waitForSubAgent: (handle: SubAgentHandle, signal?: AbortSignal) =>
        this.subAgentBridge.wait(handle, signal),

      watchFile: (filePath: string, handler: (event: FileChangeEvent) => void) =>
        this.fileWatcher.watch(filePath, handler),

      saveSession: (info: SessionInfo) => this.sessionStore.save(info),
      loadSession: (sessionId: string) => this.sessionStore.load(sessionId),
      listSessions: (limit?: number) => this.sessionStore.list(limit),

      checkNetworkPolicy: (url: string, policy?: NetworkPolicy) =>
        this.networkPolicyEnforcer.check(url, policy),
      classifyCommand: (command: string) => this.commandClassifier.classify(command),

      pushSteer: (message: string, priority?: number, abortCurrent?: boolean) =>
        this.steerQueue.push(message, priority, abortCurrent),
      popSteer: () => this.steerQueue.pop(),
      drainSteerQueue: () => this.steerQueue.drain(),

      applyPatch: (request: PatchRequest) => this.patchEngine.apply(request),

      updatePlanItem: (itemId: string, update: Partial<PlanItem>) => this.planTracker.update(itemId, update),
      getPlanItems: () => this.planTracker.getAll(),
    };
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getSubAgentBridge(): SubAgentBridge {
    return this.subAgentBridge;
  }

  getSteerQueue(): SteerQueueImpl {
    return this.steerQueue;
  }

  getPlanTracker(): PlanTracker {
    return this.planTracker;
  }

  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  getFileWatcher(): FileWatcher {
    return this.fileWatcher;
  }

  getCommandClassifier(): CommandClassifier {
    return this.commandClassifier;
  }

  getNetworkPolicyEnforcer(): NetworkPolicyEnforcer {
    return this.networkPolicyEnforcer;
  }

  getSkillsBridge(): SkillsBridge {
    return this.skillsBridge;
  }

  getPatchEngine(): PatchEngine {
    return this.patchEngine;
  }
}
