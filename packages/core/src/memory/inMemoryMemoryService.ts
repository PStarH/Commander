import { randomUUID } from 'node:crypto';
import type {
  ForgetMemoryInput,
  ListMemoryInput,
  MemoryAuditEvent,
  MemoryAuditPage,
  MemoryPage,
  MemoryRecord,
  MemoryRetentionPolicy,
  MemoryScope,
  MemorySearchResult,
  MemoryService,
  MemoryServiceAudit,
  QueryMemoryAuditInput,
  RetrieveMemoryInput,
  SearchMemoryInput,
  StoreMemoryInput,
} from './memoryService';
import { assertForgetTarget, assertLimit, assertMemoryScope } from './memoryService';

const AUDIT_RING_MAX = 1_000;

export interface InMemoryMemoryServiceOptions {
  now?: () => Date;
  retention?: MemoryRetentionPolicy;
}

function keyFor(scope: MemoryScope, id: string): string {
  return `${scope.tenantId}\u0000${scope.projectId}\u0000${id}`;
}

function isInScope(record: MemoryRecord, scope: MemoryScope): boolean {
  return record.tenantId === scope.tenantId && record.projectId === scope.projectId;
}

function isLive(record: MemoryRecord, now: Date): boolean {
  return !record.expiresAt || new Date(record.expiresAt).getTime() > now.getTime();
}

function sortRecords(left: MemoryRecord, right: MemoryRecord): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt);
  return left.id.localeCompare(right.id);
}

function matchesFilters(record: MemoryRecord, input: SearchMemoryInput | ListMemoryInput): boolean {
  if (input.kind && record.kind !== input.kind) return false;
  if (input.missionId && record.missionId !== input.missionId) return false;
  if (input.agentId && record.agentId !== input.agentId) return false;
  if (input.tags && !input.tags.every((tag) => record.tags.includes(tag))) return false;
  if (
    'minPriority' in input &&
    input.minPriority !== undefined &&
    record.priority < input.minPriority
  ) {
    return false;
  }
  if (
    'minConfidence' in input &&
    input.minConfidence !== undefined &&
    record.confidence < input.minConfidence
  ) {
    return false;
  }
  return true;
}

export class InMemoryMemoryService implements MemoryService, MemoryServiceAudit {
  private readonly items = new Map<string, MemoryRecord>();
  private readonly auditLog: MemoryAuditEvent[] = [];
  private readonly now: () => Date;
  private readonly retention: MemoryRetentionPolicy;

  constructor(options: InMemoryMemoryServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.retention = options.retention ?? {};
  }

  async store(input: StoreMemoryInput): Promise<MemoryRecord> {
    assertMemoryScope(input.scope);
    if (!input.title.trim() || !input.content.trim()) {
      throw new Error('title and content must be non-empty');
    }

    const now = this.now();
    const id = input.id ?? randomUUID();
    const existing = this.items.get(keyFor(input.scope, id));
    const createdAt = existing?.createdAt ?? now.toISOString();
    const expiresAt =
      input.expiresAt ??
      (this.retention.defaultTtlMs != null
        ? new Date(now.getTime() + this.retention.defaultTtlMs).toISOString()
        : undefined);
    const record: MemoryRecord = {
      id,
      tenantId: input.scope.tenantId,
      projectId: input.scope.projectId,
      missionId: input.missionId,
      agentId: input.agentId ?? input.scope.agentId,
      kind: input.kind,
      duration: input.duration ?? 'EPISODIC',
      title: input.title,
      content: input.content,
      tags: [...new Set(input.tags ?? [])],
      priority: input.priority ?? 50,
      confidence: input.confidence ?? 0.8,
      createdAt,
      lastAccessedAt: input.lastAccessedAt ?? now.toISOString(),
      expiresAt,
      evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : undefined,
      meta: input.meta ? { ...input.meta } : undefined,
      embedding: input.embedding ? [...input.embedding] : undefined,
    };

    this.items.set(keyFor(input.scope, id), record);
    this.enforceMaximum(input.scope);
    this.recordAudit({
      scope: input.scope,
      action: 'store',
      memoryId: id,
      actorId: record.agentId,
      success: true,
      tags: record.tags,
    });
    return {
      ...record,
      tags: [...record.tags],
      meta: record.meta ? { ...record.meta } : undefined,
    };
  }

  async retrieve(input: RetrieveMemoryInput): Promise<MemoryRecord | null> {
    assertMemoryScope(input.scope);
    const record = this.items.get(keyFor(input.scope, input.id));
    if (!record || !isLive(record, this.now())) return null;
    const updated = { ...record, lastAccessedAt: this.now().toISOString() };
    this.items.set(keyFor(input.scope, input.id), updated);
    this.recordAudit({
      scope: input.scope,
      action: 'retrieve',
      memoryId: input.id,
      success: true,
      tags: updated.tags,
    });
    return {
      ...updated,
      tags: [...updated.tags],
      meta: updated.meta ? { ...updated.meta } : undefined,
    };
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult> {
    assertMemoryScope(input.scope);
    const limit = assertLimit(input.limit);
    const queryTokens = (input.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const items = this.scopedLiveRecords(input.scope)
      .filter((record) => matchesFilters(record, input))
      .filter((record) => {
        if (queryTokens.length === 0) return true;
        const haystack = `${record.title} ${record.content} ${record.tags.join(' ')}`.toLowerCase();
        return queryTokens.every((token) => haystack.includes(token));
      })
      .sort(sortRecords);
    this.recordAudit({
      scope: input.scope,
      action: 'search',
      actorId: input.scope.agentId,
      success: true,
      tags: input.tags,
    });
    return { items: items.slice(0, limit).map((record) => ({ ...record })), total: items.length };
  }

  async forget(input: ForgetMemoryInput): Promise<boolean> {
    assertForgetTarget(input);
    if (input.id) {
      const existing = this.items.get(keyFor(input.scope, input.id));
      const deleted = this.items.delete(keyFor(input.scope, input.id));
      this.recordAudit({
        scope: input.scope,
        action: 'forget',
        memoryId: input.id,
        actorId: input.scope.agentId,
        success: deleted,
        tags: existing?.tags,
      });
      return deleted;
    }

    let deleted = false;
    const tagsSnapshot: string[] = [];
    for (const [key, record] of this.items) {
      if (isInScope(record, input.scope) && record.missionId === input.missionId) {
        tagsSnapshot.push(...record.tags);
        deleted = this.items.delete(key) || deleted;
      }
    }
    this.recordAudit({
      scope: input.scope,
      action: 'forget',
      actorId: input.scope.agentId,
      success: deleted,
      tags: tagsSnapshot.length > 0 ? [...new Set(tagsSnapshot)] : undefined,
    });
    return deleted;
  }

  async queryAudit(input: QueryMemoryAuditInput): Promise<MemoryAuditPage> {
    assertMemoryScope(input.scope);
    const limit = assertLimit(input.limit, 50, 500);
    const nsTag = input.namespace ? `namespace:${input.namespace}` : undefined;
    const entries = this.auditLog
      .filter(
        (e) =>
          e.tenantId === input.scope.tenantId &&
          e.projectId === input.scope.projectId &&
          (!nsTag || e.tags?.includes(nsTag)),
      )
      .slice(-limit)
      .reverse();
    return { entries, count: entries.length };
  }

  async list(input: ListMemoryInput): Promise<MemoryPage> {
    assertMemoryScope(input.scope);
    const limit = assertLimit(input.limit);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error('cursor must be a non-negative integer');
    const items = this.scopedLiveRecords(input.scope).filter((record) =>
      matchesFilters(record, input),
    );
    const page = items.slice(offset, offset + limit).map((record) => ({ ...record }));
    return {
      items: page,
      total: items.length,
      nextCursor: offset + limit < items.length ? String(offset + limit) : undefined,
    };
  }

  async purgeExpired(scope?: MemoryScope): Promise<number> {
    if (scope) assertMemoryScope(scope);
    const now = this.now();
    let deleted = 0;
    for (const [key, record] of this.items) {
      if ((!scope || isInScope(record, scope)) && !isLive(record, now)) {
        if (this.items.delete(key)) deleted++;
      }
    }
    return deleted;
  }

  async close(): Promise<void> {
    this.items.clear();
    this.auditLog.length = 0;
  }

  private recordAudit(input: {
    scope: MemoryScope;
    action: string;
    memoryId?: string;
    actorId?: string;
    success: boolean;
    tags?: string[];
  }): void {
    this.auditLog.push({
      id: randomUUID(),
      tenantId: input.scope.tenantId,
      projectId: input.scope.projectId,
      memoryId: input.memoryId,
      action: input.action,
      actorId: input.actorId,
      success: input.success,
      createdAt: this.now().toISOString(),
      tags: input.tags ? [...input.tags] : undefined,
    });
    if (this.auditLog.length > AUDIT_RING_MAX) {
      this.auditLog.splice(0, this.auditLog.length - AUDIT_RING_MAX);
    }
  }

  private scopedLiveRecords(scope: MemoryScope): MemoryRecord[] {
    const now = this.now();
    return [...this.items.values()]
      .filter((record) => isInScope(record, scope) && isLive(record, now))
      .sort(sortRecords);
  }

  private enforceMaximum(scope: MemoryScope): void {
    const maximum = this.retention.maxEntriesPerTenantProject;
    if (maximum == null) return;
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error('maxEntriesPerTenantProject must be a positive integer');
    }
    const records = this.scopedLiveRecords(scope).sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
      return left.id.localeCompare(right.id);
    });
    while (records.length > maximum) {
      const record = records.shift();
      if (record) this.items.delete(keyFor(scope, record.id));
    }
  }
}
