# Legacy Authority Inventory Gate — Task 1 Design

## Goal
Produce a deterministic, sorted inventory of every API/Web/CLI/MCP/runtime entry point that can create or mutate a `run`, `effect`, `approval`, or `evidence`, and fail the gate when a new write-capable authority appears without a matching read-only fixture entry.

## Interface

### Inventory entry
```typescript
interface InventoryEntry {
  path: string;                 // repo-relative path to the authority source file
  authorityKind:
    | 'canonical'               // V2 kernel / effect-broker / v1 gateway paths
    | 'read-only-legacy'        // reads legacy state, never mutates it
    | 'write-capable-legacy'    // mutates state or constructs in-process runtime
    | 'temporary-gate';         // guard/rail that is not a final authority
  callers: string[];            // sorted list of repo-relative paths that import this entry
  writesExternally: boolean;    // true if the file performs an external write
  canonicalReplacement: string | null;
  disposition: 'retain' | 'migrate-and-delete' | 'migrate-to-readonly' | 'remove';
}
```

## Classification rules

1. **Canonical** — hard-coded allowlist of V2 authorities:
   - `apps/api/src/v1GatewayEndpoints.ts`
   - `apps/api/src/actionGatewayEndpoints.ts`
   - `packages/kernel/src/*`
   - `packages/worker-plane/src/*`
   - `packages/effect-broker/src/*`

2. **Temporary-gate** — guard modules that will be removed once migration is complete:
   - `apps/api/src/legacyExecutionGuard.ts`
   - `scripts/architecture-gate.ts`
   - `scripts/legacy-authority-inventory.ts`

3. **Write-capable-legacy** — files that instantiate `AgentRuntime`, mutate `WarRoomStore`/`RunLedger`, or expose CLI/MCP commands that start a run/effect/approval:
   - `apps/api/src/sharedRuntime.ts`
   - `apps/api/src/agentRuntimeRegistry.ts`
   - `apps/api/src/orchestratorEndpoints.ts`
   - `packages/core/src/cliEntry.ts`
   - `packages/mcp-server/src/stdioServer.ts`
   - `packages/core/src/controlPlane/index.ts`
   - `apps/api/src/store.ts`

4. **Read-only-legacy** — files that read legacy state without mutating:
   - `apps/web/src/hooks/useWarRoom.ts`
   - other UI/API read helpers

## Scanning strategy

- Static file walk over `apps`, `packages`, and `scripts` (excluding `node_modules`, `dist`, `.git`, test files, and the inventory script itself).
- Pattern-based classification:
  - `new AgentRuntime`, `new UltimateOrchestrator`, `new TELOSOrchestrator` → write-capable-legacy
  - `WarRoomStore`/`SqliteWarRoomStore` creation or mutation → write-capable-legacy
  - `RunLedger` writes → write-capable-legacy
  - `createMission`, `updateMissionStatus`, `approveMission` → read-only or write based on file context
  - CLI commands `run`, `company`, `swarm`, `saga` → write-capable-legacy
  - MCP `execute_agent` → write-capable-legacy
- Reverse import graph: for each classified authority, collect relative imports that import it. Cross-package workspace imports (e.g. `@commander/core`) are not currently tracked.

## Gate behavior

1. Scan the tree and produce a sorted inventory.
2. Compare against `scripts/fixtures/legacy-authorities.json`.
3. If any entry with `authorityKind === 'write-capable-legacy'` is not in the fixture, fail loudly.
4. Output stable JSON sorted by `path`.

## CLI

```bash
pnpm exec tsx scripts/legacy-authority-inventory.ts --format json
pnpm exec tsx --test scripts/legacy-authority-inventory.test.ts
```

## Constraints

- No modifications to existing product code.
- New files only under `scripts/` and `scripts/fixtures/`.
- The fixture is a read-only allowlist of known write-capable legacy authority paths. Only `path` is compared; `callers`/`disposition`/`canonicalReplacement` are informational.
- Fixture is read-only and committed.
