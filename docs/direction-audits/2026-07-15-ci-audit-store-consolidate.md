# Direction Audit — CI audit 410 + store consolidation

**Date:** 2026-07-15  
**Decision:** **Proceed** (implemented)

## Problems

1. Quality Gates fails on all OS before tests: `pnpm audit` → npm API **HTTP 410**.
2. `LockFreeStateStore` still EXISTS with zero importers (store count noise).
3. Dual `DatasetStore` class declarations (near-identical files).

## DoD

1. CI audit step does not fail on 410
2. `export class LockFreeStateStore` gone + orphan guard
3. plugin `dataset.ts` is re-export only
4. count-guard store ceiling = 49 and green

## Duplication delta

store **51 → 49** (ENFORCED ceiling lowered).
