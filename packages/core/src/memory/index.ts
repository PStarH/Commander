/**
 * Memory System - Barrel Export
 *
 * Unified exports for Commander's memory subsystem including:
 * - UnifiedMemory: Single API over all memory backends
 * - ConversationStore: Cross-session conversation persistence with FTS5 search
 * - MemoryCurator: Autonomous memory lifecycle management
 * - UserModelManager: User profiling and personalization
 */

// Unified memory layer (single API over all backends)
export { UnifiedMemory, getUnifiedMemory } from './unifiedMemory';
export type {
  UnifiedMemoryConfig,
  RememberOptions,
  RecallOptions,
  MemorySource,
  UnifiedRecallResult,
  UnifiedContext,
} from './unifiedMemory';

// Conversation persistence (FTS5-powered cross-session recall)
export { ConversationStore, getConversationStore } from './conversationStore';
export type {
  ConversationTurn,
  ConversationSession,
  ConversationSearchResult,
  ConversationSearchOptions,
  ConversationStoreConfig,
} from './conversationStore';

// Autonomous memory curation
export { MemoryCurator, getMemoryCurator } from './curator';
export type {
  CuratorConfig,
  CurationResult,
  CuratorMemoryItem,
} from './curator';

// User modeling and personalization
export { UserModelManager, getUserModelManager } from './userModel';
export type {
  UserProfile,
  UserPreferences,
  ExpertiseLevel,
  CommunicationStyle,
  ToolUsagePatterns,
  InteractionPatterns,
  UserObservation,
  UserModelConfig,
} from './userModel';

// Existing utilities
export { createMemoryStore } from './utils';
export { JsonMemoryStore } from './jsonStore';
export { tokenize } from './tokenizer';

// BM25 full-text search scorer (FTS5-quality without SQLite)
export { BM25Scorer, tokenizeForBM25 } from './ftsScorer';
export type { BM25Config, BM25Document, BM25Result } from './ftsScorer';

// SQLite-backed memory store (production-grade)
export { SqliteMemoryStore } from './sqliteMemoryStore';
