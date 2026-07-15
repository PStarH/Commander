# Direction Audit — Dual MemoryCurator

**Date:** 2026-07-15  
**Full merge/delete:** **Defer** (both WIRED, different APIs)  
**Proceed:** rename TTL curator → `TtlMemoryCurator` (§5 naming)

## Evidence

| Class | Path | Wired by |
|---|---|---|
| `MemoryCurator` (autonomous) | `packages/core/src/memory/curator.ts` | `UnifiedMemory` via `getMemoryCurator` |
| `TtlMemoryCurator` (TTL) | `packages/core/src/memory/memoryCurator.ts` | `ThreeLayerMemory` |

## DoD

1. Product code uses `TtlMemoryCurator` for TTL path
2. Deprecated aliases keep one transition window
3. memoryCurator tests green
4. count-guard still green

## Residual

True consolidation (one curator stack) still open.
