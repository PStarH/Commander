# Multi-Tenant Work Coordinator Isolation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  TenantWorkCoordinatorRegistry                              │
│                                                              │
│  Map<tenantId, TenantEntry>                                  │
│     TenantEntry = { coord, store }                          │
│                                                              │
│  getWorkCoordinator(tenantId) ──> lazy create + cache        │
│  listTenants() / hasTenant(id) / size()                      │
│  closeAll()  ──> flush + close all SqliteWorkQueueStores     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                    │
│  │ tenant-A │  │ tenant-B │  │ tenant-C │                    │
│  │   coord  │  │   coord  │  │   coord  │                    │
│  │   store  │  │   store  │  │   store  │                    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                    │
│       │             │             │                           │
│       ▼             ▼             ▼                           │
│  base/tenant_A/   base/tenant_B/  base/tenant_C/              │
│  work_queue.db    work_queue.db   work_queue.db               │
│  (sqlite+WAL)     (sqlite+WAL)    (sqlite+WAL)                │
└─────────────────────────────────────────────────────────────┘
```

## API

```typescript
import {
  TenantWorkCoordinatorRegistry,
  getTenantWorkCoordinatorRegistry,
  resetTenantWorkCoordinatorRegistry,
} from '@commander/core/ultimate';

const reg = getTenantWorkCoordinatorRegistry('/var/lib/commander/queues');
const coordA = reg.getWorkCoordinator('tenant-A');
const coordB = reg.getWorkCoordinator('tenant-B');

coordA.enqueue([...]);
coordB.claim('agent-B', { runId: 'run-1' });

reg.closeAll();
```

### `getTenantWorkCoordinatorRegistry(basePath?: string)`

- Singleton accessor
- First call sets `basePath` (default `.commander/queues`)
- Subsequent calls with same path return same registry
- Call with different path → creates new registry, returns new instance
- For tests: call `resetTenantWorkCoordinatorRegistry()` between cases

### `TenantWorkCoordinatorRegistry`

| Method                         | Returns           | Notes                                                |
| ------------------------------ | ----------------- | ---------------------------------------------------- |
| `getWorkCoordinator(tenantId)` | `WorkCoordinator` | Lazy: creates per-tenant coord + store on first call |
| `hasTenant(tenantId)`          | `boolean`         | True if coord was ever created for this id           |
| `listTenants()`                | `string[]`        | All tenant ids that have been initialized            |
| `size()`                       | `number`          | Number of initialized tenants                        |
| `closeAll()`                   | `void`            | Closes all SqliteWorkQueueStores (call on shutdown)  |

## Isolation Guarantees

| Property                               | How                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No cross-tenant visibility**         | `coordA.list()` only reads tenant A's `.db` file; `coordB.list()` only reads tenant B's                                                                                   |
| **No shared runId conflicts**          | runId is unique _within_ a tenant's queue, not globally. Two tenants can each have `runId: "shared-run-id"`                                                               |
| **No shared state in WorkCoordinator** | Each tenant gets its own `WorkCoordinator` instance, with its own `WorkQueueStore`, its own `messageBus` subscription, its own `currentRunId`/`currentRunHandle` sidecars |
| **Crash isolation**                    | One tenant's corrupted `.db` doesn't affect others (separate files, separate connections)                                                                                 |
| **Write isolation**                    | All writes go to per-tenant `.db`; tenant A's writes never touch tenant B's file                                                                                          |

## Lazy Initialization

`getWorkCoordinator` does **not** create files on registry construction. The tenant's directory and `.db` file are created on the first call to `getWorkCoordinator(tenantId)`.

```typescript
const reg = new TenantWorkCoordinatorRegistry('/data');
// /data is empty — no tenant files exist yet

const coordA = reg.getWorkCoordinator('alpha');
// /data/tenant_alpha/work_queue.db created now

// getWorkCoordinator('alpha') again — returns same instance, no new file
```

This means:

- Memory cost scales with number of _active_ tenants, not declared tenants
- A tenant that has never submitted work has zero disk footprint
- Tests can use `mkdtempSync` + fresh registries without leaving stale files

## File Layout

```
<basePath>/
├── tenant_<sanitized-id>/
│   └── work_queue.db          ← SqliteWorkQueueStore data
└── tenant_<other-id>/
    └── work_queue.db
```

Sanitization: `tenantId.replace(/[^a-zA-Z0-9_.-]/g, '_')`. Rejects path traversal attempts by collapsing `..` to `_`. Tenant id `customer/123` becomes `tenant_customer_123`.

## What's NOT in M2.5

| Gap                                                                                 | When                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Per-tenant token budget enforcement on `enqueue`                                    | M3 (cost-aware router)                                       |
| Cross-tenant visibility for admin (list-all queue lengths)                          | M3 (admin tool)                                              |
| Tenant-scoped metrics in `MetricsCollector`                                         | M3                                                           |
| Automatic `closeAll()` on process exit                                              | Out of scope (call explicitly or use process signal handler) |
| Dynamic basePath resolution (e.g., from `TenantConfig.workspacePath`)               | M3                                                           |
| Integration with `HttpServer.resolveTenantFromAuth` for automatic tenant resolution | M3                                                           |

## Migration Path from Singleton

The existing `getWorkCoordinator()` singleton (no tenant) is preserved for backward compatibility. New code should use the tenant registry:

```typescript
// OLD — single-tenant mode (works, but no isolation)
import { getWorkCoordinator } from '@commander/core/ultimate';
const coord = getWorkCoordinator();

// NEW — multi-tenant mode
import { getTenantWorkCoordinatorRegistry } from '@commander/core/ultimate';
const reg = getTenantWorkCoordinatorRegistry();
const coord = reg.getWorkCoordinator(req.tenantId);
```

`orchestrator.ts` and `subAgentExecutor.ts` still call `getWorkCoordinator()`. Migrating them to the registry is M3 work.

## Failure Modes

| Scenario                                                                                             | Behavior                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two processes open same tenant file                                                                  | Sqlite WAL allows concurrent reads; writes serialize via WAL writer lock. No data loss. (Multi-process coordination is M2.4's `tryClaim` guarantee.) |
| Tenant id contains `../`                                                                             | Sanitized to `___`, so path traversal blocked. Tenant directory stays under `basePath`.                                                              |
| `closeAll()` not called on process exit                                                              | Sqlite WAL might not be checkpointed; in-flight writes are lost. Caller's responsibility.                                                            |
| `getWorkCoordinator` called for tenant A, then `resetTenantWorkCoordinatorRegistry`, then call again | New registry → new coord → new store. Tenant A's previous store is NOT closed. Memory leak in tests; production should never reset.                  |
