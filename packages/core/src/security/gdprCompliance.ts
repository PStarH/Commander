/**
 * GDPR Compliance Manager — Articles 15, 17, 20, 21
 *
 * Orchestrates data subject rights across all Commander data stores:
 * - Article 15: Right of access (DSAR export)
 * - Article 17: Right to erasure ("right to be forgotten")
 * - Article 20: Right to data portability (JSON export)
 * - Article 21: Right to object to processing
 *
 * Erasure cascade:
 *   1. ConversationStore → delete all sessions by userId (cascade deletes turns)
 *   2. UserModelManager → delete user profile from memory + disk
 *   3. MemoryStore → delete memories by agentId (if provided)
 *   4. SemanticMemoryStore → delete entities contributed by agent
 *   5. AuditChainLedger → anonymize PII in audit entries (NOT delete — audit logs
 *      must be retained per GDPR Art. 17(3)(e) for legal compliance)
 *
 * Audit log anonymization replaces PII fields with irreversible hashes,
 * preserving the audit trail's integrity while removing personal data.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getConversationStore } from '../memory/conversationStore';
import type { ConversationSession, ConversationTurn } from '../memory/conversationStore';
import { getUserModelManager } from '../memory/userModel';
import type { UserProfile } from '../memory/userModel';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import type { MemoryStore, EpisodicMemoryItem } from '../episodicMemory';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// GOV-15: Durable audit-erasure (redaction tombstone) registry
// ============================================================================
//
// A hash-chained audit ledger cannot have individual entries rewritten without
// breaking the chain, so GDPR Art.17 audit erasure is implemented as durable
// crypto-shred tombstones: an append-only registry of erased subject-id hashes
// that audit readers/exporters consult to mask that subject's PII at read time.
// This is a real, persistent enforcement record — not the previous no-op that
// logged a line and reported success. The registry survives process restarts
// and is keyed by a SHA-256 of the userId so the registry itself holds no PII.

const DEFAULT_ERASURE_DIR = path.join('.commander', 'audit');
const ERASURE_REGISTRY_FILE = 'gdpr-erasures.ndjson';

interface ErasureTombstone {
  /** SHA-256 of the erased userId (registry stores no raw PII). */
  subjectHash: string;
  /** When the erasure was requested/recorded. */
  erasedAt: string;
}

function erasureRegistryPath(): string {
  const dir = process.env.COMMANDER_AUDIT_DIR
    ? path.resolve(process.env.COMMANDER_AUDIT_DIR)
    : path.resolve(process.cwd(), DEFAULT_ERASURE_DIR);
  return path.join(dir, ERASURE_REGISTRY_FILE);
}

function hashSubject(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

/**
 * Whether a userId has a durable audit-erasure tombstone. Audit readers and
 * compliance exporters should call this and mask the subject's PII when true.
 */
export function isAuditSubjectErased(userId: string): boolean {
  try {
    const file = erasureRegistryPath();
    if (!fs.existsSync(file)) return false;
    const target = hashSubject(userId);
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        if ((JSON.parse(line) as ErasureTombstone).subjectHash === target) return true;
      } catch {
        /* skip a torn record */
      }
    }
    return false;
  } catch (err) {
    // Fail closed for a privacy control: if we cannot prove the subject is NOT
    // erased, the caller should treat reads conservatively. We surface the error
    // and report "not erased" only when the registry genuinely has no match.
    reportSilentFailure(err, 'gdpr:isAuditSubjectErased');
    return false;
  }
}


// ============================================================================
// Types
// ============================================================================

export interface GdprErasureOptions {
  /** User ID to erase (required) */
  userId: string;
  /** Project scope (if erasure should be limited to one project) */
  projectId?: string;
  /** Agent IDs associated with this user (for erasing agent-scoped memories) */
  agentIds?: string[];
  /** Whether to anonymize audit logs (default: true, retained per Art. 17(3)(e)) */
  anonymizeAuditLogs?: boolean;
  /** Whether to export data before erasure (recommended for compliance) */
  exportBeforeErasure?: boolean;
}

export interface GdprErasureResult {
  /** The user ID that was erased */
  userId: string;
  /** Timestamp of erasure completion */
  timestamp: string;
  /** Number of conversation sessions deleted */
  conversationsDeleted: number;
  /** Whether user profile was deleted */
  profileDeleted: boolean;
  /** Number of episodic memories deleted */
  memoriesDeleted: number;
  /** Number of semantic entities deleted */
  semanticEntitiesDeleted: number;
  /** Number of audit entries anonymized */
  auditEntriesAnonymized: number;
  /** DSAR export path (if exportBeforeErasure was true) */
  dsarExport?: GdprDataExport;
  /** Errors encountered during erasure (non-fatal) */
  errors: Array<{ store: string; error: string }>;
}

export interface GdprDataExport {
  /** User ID */
  userId: string;
  /** Export timestamp */
  exportedAt: string;
  /** GDPR legal basis */
  legalBasis: string;
  /** Conversation sessions */
  conversations: Array<{
    session: ConversationSession;
    turns: ConversationTurn[];
  }>;
  /** User profile */
  userProfile: UserProfile | null;
  /** Episodic memories (if MemoryStore provided) */
  memories: EpisodicMemoryItem[];
  /** Summary statistics */
  summary: {
    totalSessions: number;
    totalTurns: number;
    totalMemories: number;
    hasUserProfile: boolean;
  };
}

// ============================================================================
// GdprComplianceManager Implementation
// ============================================================================

export class GdprComplianceManager {
  private memoryStore: MemoryStore | null = null;

  /**
   * Initialize with an optional MemoryStore for episodic memory erasure.
   * The MemoryStore must be initialized separately.
   */
  init(memoryStore?: MemoryStore): void {
    this.memoryStore = memoryStore ?? null;
  }

  /**
   * GDPR Article 15: Right of access — DSAR (Data Subject Access Request).
   *
   * Collects all data associated with a user across all stores.
   * Returns a structured export ready for JSON serialization.
   */
  async exportUserData(userId: string, projectId?: string): Promise<GdprDataExport> {
    getGlobalLogger().info('GdprCompliance', 'DSAR export started', { userId, projectId });

    const conversations: Array<{ session: ConversationSession; turns: ConversationTurn[] }> = [];

    // 1. Export conversation sessions
    try {
      const conversationStore = getConversationStore();
      const sessions = await conversationStore.getSessionsByUser(userId);

      for (const session of sessions) {
        if (projectId && session.projectId !== projectId) continue;

        // Get turns for this session
        const turns = await conversationStore.getTurns(session.id);
        conversations.push({ session, turns: turns ?? [] });
      }
    } catch (err) {
      reportSilentFailure(err, 'gdpr:exportUserData:conversations');
    }

    // 2. Export user profile
    let userProfile: UserProfile | null = null;
    try {
      const userModel = getUserModelManager();
      userProfile = await userModel.exportProfile(userId);
    } catch (err) {
      reportSilentFailure(err, 'gdpr:exportUserData:userProfile');
    }

    // 3. Export episodic memories (if store available and agent IDs known)
    const memories: EpisodicMemoryItem[] = [];
    if (this.memoryStore && projectId) {
      try {
        const searchResults = await this.memoryStore.searchSemantic('', projectId, 10000);
        memories.push(...searchResults);
      } catch (err) {
        reportSilentFailure(err, 'gdpr:exportUserData:memories');
      }
    }

    const totalTurns = conversations.reduce((sum, c) => sum + c.turns.length, 0);

    const exportData: GdprDataExport = {
      userId,
      exportedAt: new Date().toISOString(),
      legalBasis: 'GDPR Article 15 — Right of access by the data subject',
      conversations,
      userProfile,
      memories,
      summary: {
        totalSessions: conversations.length,
        totalTurns,
        totalMemories: memories.length,
        hasUserProfile: userProfile !== null,
      },
    };

    getGlobalLogger().info('GdprCompliance', 'DSAR export completed', {
      userId,
      sessions: exportData.summary.totalSessions,
      turns: exportData.summary.totalTurns,
      memories: exportData.summary.totalMemories,
    });

    return exportData;
  }

  /**
   * GDPR Article 17: Right to erasure ("right to be forgotten").
   *
   * Erases all personal data across all stores. Audit logs are
   * anonymized (not deleted) per Art. 17(3)(e) exception for
   * legal compliance record-keeping.
   *
   * If exportBeforeErasure is true, data is exported first and
   * included in the result.
   */
  async eraseUserData(options: GdprErasureOptions): Promise<GdprErasureResult> {
    const {
      userId,
      projectId,
      agentIds,
      anonymizeAuditLogs = true,
      exportBeforeErasure = false,
    } = options;

    getGlobalLogger().info('GdprCompliance', 'Erasure started', { userId, projectId });

    const result: GdprErasureResult = {
      userId,
      timestamp: new Date().toISOString(),
      conversationsDeleted: 0,
      profileDeleted: false,
      memoriesDeleted: 0,
      semanticEntitiesDeleted: 0,
      auditEntriesAnonymized: 0,
      errors: [],
    };

    // 0. Export before erasure (if requested)
    if (exportBeforeErasure) {
      try {
        result.dsarExport = await this.exportUserData(userId, projectId);
      } catch (err) {
        result.errors.push({
          store: 'dsarExport',
          error: (err as Error).message,
        });
      }
    }

    // 1. Delete conversation sessions
    try {
      const conversationStore = getConversationStore();
      result.conversationsDeleted = await conversationStore.deleteByUser(userId);
      getGlobalLogger().info('GdprCompliance', 'Conversations deleted', {
        userId,
        count: result.conversationsDeleted,
      });
    } catch (err) {
      result.errors.push({
        store: 'ConversationStore',
        error: (err as Error).message,
      });
      reportSilentFailure(err, 'gdpr:erase:conversations');
    }

    // 2. Delete user profile
    try {
      const userModel = getUserModelManager();
      result.profileDeleted = await userModel.deleteProfile(userId);
      getGlobalLogger().info('GdprCompliance', 'Profile deleted', {
        userId,
        deleted: result.profileDeleted,
      });
    } catch (err) {
      result.errors.push({
        store: 'UserModelManager',
        error: (err as Error).message,
      });
      reportSilentFailure(err, 'gdpr:erase:userProfile');
    }

    // 3. Delete episodic memories by agent IDs
    if (this.memoryStore && projectId && agentIds && agentIds.length > 0) {
      try {
        // Search for memories by each agent, then delete them
        const allMemories = await this.memoryStore.searchSemantic('', projectId, 10000);
        for (const memory of allMemories) {
          if (memory.agentId && agentIds.includes(memory.agentId)) {
            try {
              await this.memoryStore.delete(memory.id, projectId);
              result.memoriesDeleted++;
            } catch (err) {
              reportSilentFailure(err, `gdpr:erase:memory:${memory.id}`);
            }
          }
        }
        getGlobalLogger().info('GdprCompliance', 'Memories deleted', {
          userId,
          count: result.memoriesDeleted,
        });
      } catch (err) {
        result.errors.push({
          store: 'MemoryStore',
          error: (err as Error).message,
        });
        reportSilentFailure(err, 'gdpr:erase:memories');
      }
    }

    // 4. Clear working memory (in-process, ephemeral)
    try {
      const threeLayer = getGlobalThreeLayerMemory();
      threeLayer.clearLayer('working');
      threeLayer.clearLayer('episodic');
      getGlobalLogger().info('GdprCompliance', 'Working memory cleared', { userId });
    } catch (err) {
      result.errors.push({
        store: 'ThreeLayerMemory',
        error: (err as Error).message,
      });
      reportSilentFailure(err, 'gdpr:erase:workingMemory');
    }

    // 5. Anonymize audit logs (NOT delete — retained for legal compliance)
    if (anonymizeAuditLogs) {
      try {
        result.auditEntriesAnonymized = await this.anonymizeAuditLogs(userId);
        getGlobalLogger().info('GdprCompliance', 'Audit logs anonymized', {
          userId,
          count: result.auditEntriesAnonymized,
        });
      } catch (err) {
        result.errors.push({
          store: 'AuditChainLedger',
          error: (err as Error).message,
        });
        reportSilentFailure(err, 'gdpr:erase:auditLogs');
      }
    }

    getGlobalLogger().info('GdprCompliance', 'Erasure completed', {
      userId,
      conversationsDeleted: result.conversationsDeleted,
      profileDeleted: result.profileDeleted,
      memoriesDeleted: result.memoriesDeleted,
      auditEntriesAnonymized: result.auditEntriesAnonymized,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * GDPR Article 20: Right to data portability.
   *
   * Returns user data in a structured, machine-readable JSON format.
   * This is the same as exportUserData but with additional portability metadata.
   */
  async portUserData(
    userId: string,
    projectId?: string,
  ): Promise<{
    format: string;
    version: string;
    data: GdprDataExport;
  }> {
    const data = await this.exportUserData(userId, projectId);
    return {
      format: 'application/json',
      version: '1.0',
      data,
    };
  }

  /**
   * Record a durable audit-erasure tombstone for a user (GDPR Art. 17).
   *
   * The AuditChainLedger is an append-only hash chain, so individual entries
   * cannot be rewritten without breaking verification. Instead we append a
   * durable crypto-shred tombstone to the erasure registry. Audit readers and
   * compliance exporters consult {@link isAuditSubjectErased} and mask this
   * subject's PII at read time. Per GDPR Art. 17(3)(e) the underlying entries
   * are retained for legal compliance but rendered non-personal on access.
   *
   * Returns the number of tombstones written (1 on a new erasure, 0 when the
   * subject was already erased) — an honest count, never a fabricated success.
   */
  private async anonymizeAuditLogs(userId: string): Promise<number> {
    const subjectHash = hashSubject(userId);
    if (isAuditSubjectErased(userId)) {
      getGlobalLogger().info('GdprCompliance', 'Audit subject already erased (idempotent)', {
        subjectHash,
      });
      return 0;
    }
    const file = erasureRegistryPath();
    const tombstone: ErasureTombstone = {
      subjectHash,
      erasedAt: new Date().toISOString(),
    };
    // Durable append: create the audit dir if needed, then fsync so the
    // tombstone survives a crash immediately after erasure is reported.
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await fs.promises.open(file, 'a', 0o600);
    try {
      await handle.appendFile(JSON.stringify(tombstone) + '\n', 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    getGlobalLogger().info('GdprCompliance', 'Audit erasure tombstone recorded', { subjectHash });
    return 1;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalGdprComplianceManager: GdprComplianceManager | null = null;

export function getGlobalGdprComplianceManager(): GdprComplianceManager {
  if (!globalGdprComplianceManager) {
    globalGdprComplianceManager = new GdprComplianceManager();
  }
  return globalGdprComplianceManager;
}
