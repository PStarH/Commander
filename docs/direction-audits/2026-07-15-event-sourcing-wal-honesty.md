# Direction Audit — EventSourcingEngine WAL honesty

**Date:** 2026-07-15  
**Decision:** **Proceed** (claim honesty + isDurable API)

## Problem

File header claimed unconditional "WAL persistence". Constructor defaults `walPath` to null
(in-memory). Singleton path is different (defaults a file). PRINCIPLES §4 already flagged this.

## Fit

- Durability claims principle: durable means real storage; in-memory is not durable.
- Does not grow duplication.

## DoD

1. Header honest about optional WAL
2. `isDurable()` / `getWalPath()` exist
3. claimHonesty test covers header + isDurable
4. PRINCIPLES updated

## Residual

Callers may still ignore `isDurable()`; full fail-closed append without WAL is a larger behavior change (not this iteration).
