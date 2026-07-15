# Direction Audit — Dual MemoryCurator → merged

**Date:** 2026-07-15  
**Status:** **DONE** (true merge)

## Outcome

| Before | After |
|---|---|
| `MemoryCurator` (autonomous) in `memory/curator.ts` | **Single** `MemoryCurator` in `memory/curator.ts` |
| `TtlMemoryCurator` (TTL) in `memory/memoryCurator.ts` | Alias only (`const TtlMemoryCurator = MemoryCurator`); file is re-export shim |

## Capabilities on one class

- `runForProject` / `start` / `stop` / `close` — TTL + long-term inactivity decay
- `onWrite` / `curate` / `getLastCuration` — full autonomous cycle (TTL first)

## DoD

1. Product code uses one curator class for both paths
2. Deprecated `TtlMemoryCurator` aliases for one transition window
3. memoryCurator + curator tests green
4. count-guard memory ceiling 19→18 green

## Residual

None for this pair. Next memory dedup: dual `EpisodicMemoryStore` (core vs apps/api).
