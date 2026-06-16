# WorkCoordinator Queue Persistence

## Two Backends

WorkCoordinator accepts a `WorkQueueStore` dependency injection. Two implementations ship:

| Backend                 | Class                    | When to use                                      |
| ----------------------- | ------------------------ | ------------------------------------------------ |
| **In-memory** (default) | `InMemoryWorkQueueStore` | Tests, single-process dev, ephemeral agents      |
| **SQLite**              | `SqliteWorkQueueStore`   | Production, crash recovery, multi-step workflows |

Both implement the same interface, so swapping is zero-cost.

## When to switch

Use **InMemory** when:

- Writing unit/integration tests (zero setup)
- Running a one-shot CLI command (`commander run "task"`)
- Process death means losing the run is acceptable

Use **SQLite** when:

- The run spans minutes/hours and a crash would lose progress
- The orchestrator might be killed mid-execution (deploys, OOM, manual kill)
- You need an audit trail of work claims

## How to enable

```typescript
import { getWorkCoordinator, SqliteWorkQueueStore } from '@commander/core';

const store = new SqliteWorkQueueStore({ filePath: '.commander/work_queue.db' });
const coord = getWorkCoordinator({ store });
```

The file path is created on first write (parent dirs auto-created).

## What survives a crash

- **All PENDING items** — reloaded, available to claim
- **CLAIMED items** — reloaded, then rearmed to PENDING on next `WorkCoordinator` startup. The `attempts` counter is preserved.
- **RUNNING items** — reloaded, then rearmed to PENDING on next `WorkCoordinator` startup. The `attempts` counter is preserved.
- **COMPLETED / FAILED** — reloaded for audit. (M2.6 will add a TTL-based GC.)

See [`resume.md`](./resume.md) for the full state-transition matrix and side-effect caveats.

## What doesn't survive

- **In-process subscriptions** (`subscribe()`) — re-register on restart
- **Bus listeners** — re-register on restart
- **Open SSE streams** — clients must reconnect

## Schema

```sql
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_node_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  depends_on_json TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  last_error TEXT,
  token_budget INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  tenant_id TEXT
);
CREATE INDEX idx_work_run_status ON work_items(run_id, status, priority DESC);
CREATE INDEX idx_work_claimed_by ON work_items(claimed_by) WHERE status IN ('CLAIMED', 'RUNNING');
CREATE INDEX idx_work_tenant ON work_items(tenant_id) WHERE tenant_id IS NOT NULL;
```

`tenant_id` is nullable; populated in M2.5.

## Performance

| Operation               | InMemory | Sqlite (WAL)          |
| ----------------------- | -------- | --------------------- |
| `enqueue`               | ~0.01ms  | ~0.2ms                |
| `update` (status flip)  | ~0.01ms  | ~0.2ms                |
| `loadAll` (1000 items)  | ~0.5ms   | ~3ms                  |
| `updateMany` (50 items) | n/a      | ~5ms (in transaction) |
| 1000 enqueue + loadAll  | ~10ms    | ~220ms                |

Hot path: `claim` is O(1) Map lookup + 1 SQLite UPDATE = still sub-millisecond.

## Multi-process / distributed

**Not supported in M2.2.** M2.2 is single-process (one Worker reading + writing). For multi-process worker pools, see M2.4 (`LockManager`).

Concurrent writes from two processes may corrupt the SQLite DB. The single-process design is intentional and matches Commander's current architecture (one orchestrator process per run).

## Reset / clear

```typescript
import { resetWorkCoordinator } from '@commander/core';
resetWorkCoordinator(); // clears in-memory + closes store
```

For a hard reset (drop the SQLite file):

```bash
rm -rf .commander/work_queue.db .commander/work_queue.db-shm .commander/work_queue.db-wal
```

## Migration from in-memory

M2.2 is opt-in. No migration path needed — the default is still in-memory. To upgrade:

1. Pick a DB path (e.g., `.commander/work_queue.db`)
2. Pass `SqliteWorkQueueStore` to `getWorkCoordinator({ store })`
3. In-flight runs in old process die normally; new process gets the SQLite-backed queue
