# Direction Audit — Dual EpisodicMemoryStore (iteration scope)

**Date:** 2026-07-15  
**Decision for full consolidate/delete:** **Defer**  
**Proceed instead:** claim honesty (false SQLite header)

## Evidence

| Impl | Path | Status |
|---|---|---|
| Core ACT-R store | `packages/core/src/memory/episodicStore.ts` | EXISTS + WIRED (`threeLayerMemory`, `getGlobalEpisodicStore`) |
| API JSON/TF-IDF store | `apps/api/src/episodicMemoryStore.ts` | EXISTS + WIRED (`apps/api/src/index.ts:190` construct + shutdown persist) |

Full deletion this iteration would break API health/status + tests. Different public APIs.

## Proceed (small)

Fix marketing/false durability header so docs/code match PRINCIPLES §4.

## Definition of done

1. File header no longer claims SQLite
2. PRINCIPLES changelog notes residual dual path
3. No behavior change to runtime persistence

## Next iteration candidates

1. Count-guard with locked grep methodology
2. Plan to route API episodic through core UnifiedMemory (larger)
3. Dual MemoryCurator design
