/**
 * Product memory write — single preferred entry for durable product memory.
 *
 * All product writers (HTTP adapters, UnifiedMemory, tools that claim product
 * durability) MUST go through MemoryStore.write → MemoryService.store, which
 * enforces MEMORY-001 (namespaceGuard).
 *
 * Do not call InMemoryMemoryService / PostgresMemoryService.store from product
 * code except via MemoryStoreFacade or this helper.
 *
 * @see spec/l3-10a-memory-ceiling.md
 */

import type { EpisodicMemoryItem, MemoryStore, MemoryWriteOptions } from '../episodicMemory';

export async function writeProductMemory(
  store: MemoryStore,
  options: MemoryWriteOptions,
): Promise<EpisodicMemoryItem> {
  return store.write(options);
}
