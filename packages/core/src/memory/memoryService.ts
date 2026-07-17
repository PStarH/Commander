import type { MemoryDuration, MemoryKind } from '../episodicMemory';

export interface MemoryScope {
  tenantId: string;
  projectId: string;
  agentId?: string;
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
  projectId: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  duration: MemoryDuration;
  title: string;
  content: string;
  tags: string[];
  priority: number;
  confidence: number;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt?: string;
  evidenceRefs?: string[];
  meta?: Record<string, unknown>;
  embedding?: number[];
}

export interface StoreMemoryInput {
  scope: MemoryScope;
  id?: string;
  missionId?: string;
  agentId?: string;
  kind: MemoryKind;
  duration?: MemoryDuration;
  title: string;
  content: string;
  tags?: string[];
  priority?: number;
  confidence?: number;
  lastAccessedAt?: string;
  expiresAt?: string;
  evidenceRefs?: string[];
  meta?: Record<string, unknown>;
  embedding?: number[];
}

export interface RetrieveMemoryInput {
  scope: MemoryScope;
  id: string;
}

export interface SearchMemoryInput {
  scope: MemoryScope;
  query?: string;
  mode?: 'text' | 'semantic';
  kind?: MemoryKind;
  missionId?: string;
  agentId?: string;
  tags?: string[];
  minPriority?: number;
  minConfidence?: number;
  limit?: number;
  embedding?: number[];
}

export interface ForgetMemoryInput {
  scope: MemoryScope;
  id?: string;
  missionId?: string;
}

export interface ListMemoryInput {
  scope: MemoryScope;
  cursor?: string;
  limit?: number;
  kind?: MemoryKind;
  missionId?: string;
  agentId?: string;
  tags?: string[];
}

export interface MemorySearchResult {
  items: MemoryRecord[];
  total: number;
}

export interface MemoryPage {
  items: MemoryRecord[];
  total: number;
  nextCursor?: string;
}

export interface MemoryRetentionPolicy {
  defaultTtlMs?: number | null;
  maxEntriesPerTenantProject?: number | null;
  purgeIntervalMs?: number;
}

export interface MemoryService {
  store(input: StoreMemoryInput): Promise<MemoryRecord>;
  retrieve(input: RetrieveMemoryInput): Promise<MemoryRecord | null>;
  search(input: SearchMemoryInput): Promise<MemorySearchResult>;
  forget(input: ForgetMemoryInput): Promise<boolean>;
  list(input: ListMemoryInput): Promise<MemoryPage>;
  close(): Promise<void>;
}

export interface MemoryServiceMaintenance {
  purgeExpired(scope?: MemoryScope): Promise<number>;
}

/** Audit row for memory operations (WS6 public query surface). */
export interface MemoryAuditEvent {
  id: string;
  tenantId: string;
  projectId: string;
  memoryId?: string;
  action: string;
  actorId?: string;
  success: boolean;
  createdAt: string;
  /** Tags snapshot at write time — used for namespace filtering. */
  tags?: string[];
}

export interface QueryMemoryAuditInput {
  scope: MemoryScope;
  /** When set, only events whose tags include `namespace:<name>`. */
  namespace?: string;
  limit?: number;
}

export interface MemoryAuditPage {
  entries: MemoryAuditEvent[];
  count: number;
}

/**
 * Optional audit query capability. Not all MemoryService backends persist
 * audit (Postgres does; InMemory keeps a bounded ring for tests/local).
 */
export interface MemoryServiceAudit {
  queryAudit(input: QueryMemoryAuditInput): Promise<MemoryAuditPage>;
}

export class MemoryServiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryServiceValidationError';
  }
}

const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

function assertNonEmptyId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new MemoryServiceValidationError(`${field} must be a non-empty identifier`);
  }
}

export function assertMemoryScope(scope: MemoryScope): void {
  assertNonEmptyId(scope?.tenantId, 'tenantId');
  if (!TENANT_ID_RE.test(scope.tenantId)) {
    throw new MemoryServiceValidationError('tenantId has an invalid format');
  }
  assertNonEmptyId(scope?.projectId, 'projectId');
}

export function assertForgetTarget(input: ForgetMemoryInput): void {
  assertMemoryScope(input.scope);
  const hasId = typeof input.id === 'string' && input.id.length > 0;
  const hasMissionId = typeof input.missionId === 'string' && input.missionId.length > 0;
  if (!hasId && !hasMissionId) {
    throw new MemoryServiceValidationError('forget requires id or missionId');
  }
}

export function assertLimit(limit: number | undefined, defaultLimit = 50, maxLimit = 10_000): number {
  const resolved = limit ?? defaultLimit;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maxLimit) {
    throw new MemoryServiceValidationError(`limit must be an integer between 1 and ${maxLimit}`);
  }
  return resolved;
}
