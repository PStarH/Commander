# Direction Audit — PRINCIPLES §3 count-guard

**Date:** 2026-07-15  
**Decision:** **Proceed** (implemented)

## Problem

§3 duplication counts were honor-system only (Enforcement: NONE). Counts could grow
silently across PRs.

## Methodology (locked in test)

See `packages/core/tests/architecture/duplicationCountGuard.test.ts`.

Ceilings (2026-07-15 live):
- orchestrator ≤ 10
- store ≤ 51
- memory ≤ 21 (scoped)
- stateMachine ≤ 4

## DoD

1. Guard test green
2. Wired into `pnpm test:arch`
3. PRINCIPLES Enforcement → PARTIAL ENFORCED
4. Table counts aligned to methodology

## Duplication delta

Does not shrink implementations; **prevents growth** (ENFORCED).
