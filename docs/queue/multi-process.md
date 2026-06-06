# WorkCoordinator Multi-Process Locking

M2.4 adds atomic claim semantics so multiple processes sharing a `SqliteWorkQueueStore` cannot double-claim a work item.

## The race condition (without M2.4)

Two processes `A` and `B` share the same SQLite DB. Both `recover()` loads all 10 items into their in-memory maps.

Without atomic claim:

1. A calls `claim()` → picks item 1 from in-memory → calls `store.update()` → DB has item 1 as CLAIMED by A
2. B calls `claim()` → picks item 1 from in-memory (B's map still has it as PENDING) → calls `store.update()` → DB has item 1 as CLAIMED by B (overwriting A's claim)
3. Both A and B think they own item 1. **Double execution.**

## The fix: atomic UPDATE with WHERE clause

```sql
UPDATE work_items
SET status = 'CLAIMED', claimed_by = ?, claimed_at = ?, lease_token = ?, fencing_epoch = fencing_epoch + 1
WHERE id = ? AND status = 'PENDING'
```

`changes` returns:
- `1` — won the race, the row was PENDING
- `0` — lost, the row was already CLAIMED/RUNNING/etc.

`WorkCoordinator.claim()` iterates candidates and tries each via `store.tryClaim()`. The first to win gets returned. The losers fall through to the next candidate.

## Lease token + fencing epoch

Every successful claim sets:

- `lease_token` — a UUID that uniquely identifies this claim. The owner uses this to prove it's still the claimer (e.g., when calling `complete()` or `fail()`).
- `fencing_epoch` — a monotonic counter that increments on every claim. Stale processes holding old tokens can be detected and rejected.

`complete()` and `fail()` call `store.releaseClaim(leaseToken)` to clear the lease.

## Schema migration

The new columns (`lease_token`, `fencing_epoch`) are added to existing DBs via `ALTER TABLE`. The `SqliteWorkQueueStore.openDb()` runs:

```typescript
private migrate(): void {
  const cols = this.db.prepare(`PRAGMA table_info(work_items)`).all();
  if (!cols.includes('lease_token')) {
    this.db.exec(`ALTER TABLE work_items ADD COLUMN lease_token TEXT`);
  }
  if (!cols.includes('fencing_epoch')) {
    this.db.exec(`ALTER TABLE work_items ADD COLUMN fencing_epoch INTEGER NOT NULL DEFAULT 0`);
  }
}
```

Idempotent — safe to run on fresh DBs (CREATE TABLE includes the columns) and old DBs (ALTER TABLE adds them).

## Test surface

`packages/core/tests/ultimate/workQueueStore.test.ts` → "GAP-M2.4 multi-process tryClaim":

1. `InMemoryWorkQueueStore.tryClaim` returns true for PENDING, false for already-claimed (10 wins + 0 second-pass)
2. `SqliteWorkQueueStore.tryClaim` succeeds once then fails on same `workId`
3. **2-process sequential simulation** — A claims task-1, B's claim fails, B falls through to task-2
4. `releaseClaim` clears the lease so the same `workId` can be re-claimed
5. `fencingEpoch` increments on each successful `tryClaim`

## What's NOT in M2.4

These are deferred to M2.6 (chaos) and beyond:

- **True multi-process testing** — Tests simulate 2 processes sequentially. Spawning 2 real node processes is in M2.6.
- **Lease TTL** — Claims are held forever until `releaseClaim` is called. A crashed process with a live claim would block re-claim forever. M2.4 relies on `recover()` resetting such items to PENDING on next startup.
- **Cross-process heartbeat** — The lease has no `expires_at` yet. M2.4 uses the `recover()` mechanism (in-flight → PENDING) as the only "lease expiration" mechanism.
- **Zombie fencing on resume** — A recovered item starts at fencingEpoch=current. A zombie process holding an old token would NOT be rejected when it tries to write. M2.4 trusts the recover() to clean up zombies; future work can add explicit `validate(leaseToken, expectedEpoch)` checks.

## WorkItem type change

```typescript
export interface WorkItem {
  // ... existing fields
  leaseToken?: string;    // M2.4: UUID of current claim
  fencingEpoch?: number;  // M2.4: monotonic counter
}
```

Both optional. Old data (without these fields) is fine — `fencingEpoch` defaults to 0 on read.
