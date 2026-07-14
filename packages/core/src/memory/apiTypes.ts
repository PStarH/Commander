import type { MemoryKind, MemoryDuration } from '../episodicMemory';

/**
 * Canonical Project Memory DTO.
 *
 * This type is the stable public-facing representation of a memory item across
 * the core library and the API layer. It is intentionally a strict subset of
 * the internal storage schema so that API consumers are insulated from storage
 * details (meta, embedding vectors, activation scores, etc.).
 */
export interface ProjectMemoryItem {
  id: string;
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
}

/** Overview statistics for a project's memory corpus. */
export interface ProjectMemoryOverview {
  totalItems: number;
  kindCounts: Record<MemoryKind, number>;
  topTags: Array<{ tag: string; count: number }>;
  missionLinkedCount: number;
  agentLinkedCount: number;
  latestCreatedAt?: string;
}

/** Search options accepted by project-level memory APIs. */
export interface ProjectMemorySearchOptions {
  kind?: MemoryKind;
  tags?: string[];
  query?: string;
  limit?: number;
  minPriority?: number;
  minConfidence?: number;
}
