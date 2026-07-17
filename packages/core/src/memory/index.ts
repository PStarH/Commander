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
export { UnifiedMemory, getUnifiedMemory, resetUnifiedMemory } from './unifiedMemory';
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

// Memory curation (TTL expiry + autonomous quality — single stack)
export {
  MemoryCurator,
  getMemoryCurator,
  DEFAULT_CURATOR_CONFIG,
  TtlMemoryCurator, // @deprecated alias
  DEFAULT_TTL_CURATOR_CONFIG, // @deprecated alias
} from './curator';
export type {
  CuratorConfig,
  CurationResult,
  CuratorMemoryItem,
  TtlMemoryCuratorConfig, // @deprecated alias
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
export { createMemoryStore, bootstrapMemoryPersistence, resolveMemoryStoreType } from './utils';
export type { MemoryBootstrapOptions, MemoryStoreType } from './utils';
export {
  MemoryServiceValidationError,
  assertForgetTarget,
  assertLimit,
  assertMemoryScope,
} from './memoryService';
export type {
  ForgetMemoryInput,
  ListMemoryInput,
  MemoryPage,
  MemoryRecord,
  MemoryRetentionPolicy,
  MemoryScope,
  MemorySearchResult as MemoryServiceSearchResult,
  MemoryService,
  MemoryServiceMaintenance,
  RetrieveMemoryInput,
  SearchMemoryInput,
  StoreMemoryInput,
} from './memoryService';
export { InMemoryMemoryService } from './inMemoryMemoryService';
export { PostgresMemoryService } from './postgresMemoryService';
export { memorySchemaStatements, vectorSchemaStatements } from './postgresMemorySchema';
export { MemoryStoreFacade } from './memoryStoreFacade';
export { writeProductMemory } from './writeProductMemory';
export { assertNamespaced, assertNamespacedStoreInput } from './namespaceGuard';
export type { MemoryNamespaceAcl } from './namespaceGuard';
export { MemoryMigrationRunner } from './memoryMigration';
export type {
  LegacyMemoryRecord,
  MemoryMigrationCheckpointStore,
  MemoryMigrationResult,
  MemoryMigrationSource,
  TenantMapping,
} from './memoryMigration';
export { tokenize } from './tokenizer';

// Episodic memory store interface
export type { MemoryStore, MemoryMeta } from '../episodicMemory';

// BM25 full-text search scorer (FTS5-quality without SQLite)
export { BM25Scorer, tokenizeForBM25 } from './ftsScorer';
export type { BM25Config, BM25Document, BM25Result } from './ftsScorer';

// Thompson Memory Scorer - Beta distribution based usefulness tracking (0 tokens)
export { ThompsonMemoryScorer } from './thompsonMemoryScorer';
export type { ThompsonScorerConfig } from './thompsonMemoryScorer';

// Memory Quality Gate - Multi-layer quality filtering (0 tokens)
export { MemoryQualityGate, quickQualityCheck } from './memoryQualityGate';
export type { QualityGateConfig, QualityGateResult, ConsensusVote } from './memoryQualityGate';

// Reflexion Injector - Sliding window reflection injection (~100 tokens/retry)
export { ReflexionInjector, createReflexionInjector } from './reflexionInjector';
export type { ReflexionInjectorConfig, ReflectionEntry } from './reflexionInjector';

// Reflection Pipeline - Synthesis of episodic memories into long-term insights (~40 tokens/experience)
export { ReflectionPipeline } from './reflectionPipeline';
export type { ReflectionPipelineConfig, ReflectionInsight } from './reflectionPipeline';

// P1 Memory Management Agent prototype
export { MemoryManagerAgent } from './memoryManagerAgent';
export type {
  MemoryAction,
  MemoryObservation,
  MemoryItem,
  MemoryQuery,
  MemoryManagerStats,
  MemoryManagerConfig,
  LLMPolicy,
  LLMPolicyInput,
} from './memoryManagerAgent';

// Temporal relation chain for semantic memory
export { TemporalGraph } from './temporalGraph';
export type { TemporalEvent, TemporalRelation } from './temporalGraph';
