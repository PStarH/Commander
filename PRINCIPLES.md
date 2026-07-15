# PRINCIPLES.md

The single living document of architectural invariants and naming rules for Commander.
Kept short, current, and checked against on every change. This is the **target** shape;
where today's code diverges, the divergence is named as debt, not hidden.

**How to read a status tag** (used throughout):

- **EXISTS** — the code is there.
- **WIRED** — it runs on the default / live path, not just behind an opt-in flag or in a test.
- **ENFORCED** — a test / lint / CI gate fails the build if it's violated.

Every claim below cites `file:line` to code, or is marked UNVERIFIED. Counts state how they
were produced so they're reproducible. Backing inventory: workflow run `wf_db80bc0a-04f`
(15 package maps + duplication censuses, 2026-07-14).

---

## 0. Two generations (read this first)

Commander is mid-strangler-migration. Two architectures coexist on disk:

- **V1** — `@commander/core`: a 304,435-LOC, 882-file monolith whose `src/index.ts` is a
  1643-line barrel re-exporting 43 subsystems (runtime, 11+ orchestrators, 5+ memory systems,
  security guards, SQLite/Postgres drivers, CLI, TUI). This is what the live CLI and most of
  `apps/api` run today. WIRED.
- **V2** — the plane-separated target: `@commander/contracts` (types) → `@commander/kernel`
  (durable Postgres authority) → `@commander/worker-plane` (execution) + `@commander/effect-broker`
  (capability PEP) + `@commander/operations` (background workers), fronted by `apps/api` (Gateway).
  Partially built; durable `/v1` kernel defaults ON in production / V2 mode / when a DSN is set
  (`isCommanderKernelEnabled`, see §4). Explicit `COMMANDER_KERNEL_ENABLED=0` remains non-prod opt-out.

The principles below define **V2 as the invariant set**. V1 duplication is the debt to retire.
Every "one canonical X" rule names the current count so consolidation is measurable.

---

## 1. Dependency direction

**Invariants**

1. `@commander/contracts` depends on nothing internal; everything may depend on it.
2. No package imports the `@commander/core` barrel wholesale. If you need one thing from core,
   that thing gets a real home (a submodule path at minimum, its own package ideally).

**Conformance today**

- (1) HOLDS. `packages/contracts` has zero internal deps and no `dependencies` block
  (`packages/contracts/src/index.ts`, `package.json:60-63`); it is imported by kernel, sdk, api.
- (2) **VIOLATED, widely.** The core root barrel is imported wholesale by:
  `apps/api` (50 `from '@commander/core'` imports, e.g. `apps/api/src/index.ts:1-19`),
  `worker-plane` (`workerRuntimeAdapter.ts:1`), `mcp-server` (`stdioServer.ts:1-11`, 9 symbols),
  `sdk` (`commanderClient.ts:26,139,381` incl. a sync `require`), `operations` (root barrel),
  and the `apps/memory` writer (`apps/api/src/memoryIndexManager.ts:14`).
- **Enforcement: NONE.** The "must never import core/kernel" rule is a doc comment
  (`packages/contracts/src/index.ts:5-6`); there is no dependency-cruiser / eslint-boundaries
  config in the repo. This principle is currently aspirational.

**Gap to close:** add a boundary linter that fails CI on a wholesale core-barrel import.

---

## 2. Plane separation

**Invariants**

1. Only the Gateway (`apps/api`) imports an HTTP framework.
2. Only the worker/execution plane runs the LLM/provider runtime.
3. Only the durable kernel (`packages/kernel`) writes the `runs` / `steps` / `events` tables.
4. Every cross-plane value is a `@commander/contracts` type — no ad-hoc shapes crossing boundaries.

**Conformance today**

- (1) HOLDS + **ENFORCED.** `express` is imported only under `apps/api` (`index.ts:20`; 55 files).
  `packages/core/tests/architecture/architectureV2.invariants.test.ts:34` asserts apps/api is the
  sole Gateway and `:40` that `CommanderHttpServer` is deprecated for product Gateway use.
- (2) MOSTLY HOLDS. Core _implements_ the runtime (27 fetch-based providers,
  `packages/core/src/runtime/providers/`, `anthropicProvider.ts:137`); worker-plane invokes it via
  the core barrel on the default `agent` path (`workerRuntimeAdapter.ts:1`, `bootstrap.ts:183`).
  `apps/api` can instantiate `AgentRuntime` in-process but only behind `legacyExecutionGuard.ts:11`
  (default-OFF: `orchestratorEndpoints.ts:57`, `sequentialExecutor.ts:457`).
- (3) **PARTIALLY HOLDS for `/v1`.** Kernel Postgres (`postgres.ts:213/229/815-817`) is the
  **default durable authority** for `/v1/runs*` via `isCommanderKernelEnabled()` auto-on
  (production / V2 mode / DSN present; explicit `=0` non-prod only; production refuse rejects off).
  Missing kernel → HTTP 503 `KERNEL_UNAVAILABLE` — no WarRoomStore fallback.
  Residual dual surface: `WarRoomStore` still writes `missions`+`execution_logs` for the
  non-`/v1` missions UI (`store.ts:1034,358`), and core's ATR `RunLedger` writes
  `run_transactions`/`run_actions` in SQLite (`atr/runLedger.ts:205,219`). Legacy Gateway
  execute paths remain behind `legacyExecutionGuard` (default-OFF).

**Gap to close:** retire `WarRoomStore`/`RunLedger` as run-state authorities entirely
(demote/delete after missions UI is re-homed); keep `/v1` kernel-only.

---

## 3. Single decision points — one canonical implementation per concept

**Invariant:** one implementation per concept on the live path. New product modes are configuration
over the one implementation, not a new class. Count before/after on any change that claims to consolidate.

**Current counts** (source-only; excludes tests/dist/re-exports; grep commands in run `wf_db80bc0a-04f`):

| Concept               | Real impls                                                                 | Canonical (intended)                                                                                                                                                | Notable duplication / dead code                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator          | **10** (was 13)                                                            | V1 `UltimateOrchestrator` (`core/src/ultimate/orchestrator.ts:64`); V2 `planWorkGraph` (`core/src/planner/workGraphPlanner.ts:112`) → kernel → worker StepExecutors | DELETED 2026-07-14: `apps/api` dead `Orchestrator` class (file slimmed to the live, tested `runAgentStep`), `AdaptiveOrchestrator`, the whole `@commander/orchestration` package (dead divergent fork). Remaining: 6 wired V1 orchestrators (Ultimate/TELOS/Swarm/Drive/Goal/AgentLoop) + 3 coordinators overlap the V2 planner path. DELETED 2026-07-15: orphan `apps/api/src/deterministicTaskAllocator.ts` (484 LOC; zero importers; was not an Orchestrator count).      |
| Store / Repository    | **51** classes (was 51 baseline; methodology-locked)                       | per-concept: kernel `KernelRepository`, core `MemoryStore`, `apiStore`, `WarRoomStore` (≈4 parallel roots, not 1)                                                   | `EpisodicMemoryStore` defined in **both** `core/src/memory/episodicStore.ts:41` and `apps/api/src/episodicMemoryStore.ts:398`. DELETED 2026-07-14: `DatasetStore` verbatim copy (consumers repointed to `observability/dataset.ts`), `LockFreeStateStore` (+ its orphaned `ILockFreeStateStore` contract in `pillarI.ts`)                                                                                                                                                    |
| Memory system         | **19** (methodology-locked allowlist of product memory systems)            | `UnifiedMemory` (`core/src/memory/unifiedMemory.ts:167`) over `ThreeLayerMemory`                                                                                    | Allowlist (not path-walk): Unified/ThreeLayer/MemorySystem + dual curators (`MemoryCurator` + `TtlMemoryCurator`) + dual `EpisodicMemoryStore` + api parallel stores (`ProjectMemoryStore`/`NamespacedMemoryStore`/`MemoryIndexManager`) + Conversation/Semantic/Procedural/Json/Sqlite + Federation/ManagerAgent/QualityGate/CrossModelMemory. Path-walk of `memory/**` helpers is 24–32 and is NOT the locked definition. `MemorySystem` is `@deprecated` with no callers. |
| State machine         | **6** (4 `*StateMachine` classes + `RUN_TRANSITIONS` + `STEP_TRANSITIONS`) | `contracts/src/states.ts:49/61` (RUN/STEP lifecycle tables)                                                                                                         | Classes: `TaskStateMachine`, `StateMachine`, `PatternStateMachine`, `TopologyStateMachine`. Canonical transition tables have **zero call sites** — the kernel enforces transitions in SQL (`kernel/src/postgres.ts:342`) instead; `apps/api/src/stateMachine.ts:245` and `patternStateMachine.ts:214` are two legacy engines with byte-identical interface names                                                                                                             |
| Policy decision point | multiple                                                                   | `@commander/effect-broker` PEP for external effects (`effect-broker/src/index.ts:294`, fail-closed)                                                                 | `apps/api` middleware chain (`authMiddleware`/`jwtMiddleware`/`tenantContextMiddleware`/`securityMiddleware`); worker-plane default `PolicyEvaluator` is **deny-all** (`createWorkerPolicyEvaluator`; permit only via `COMMANDER_WORKER_EFFECT_POLICY=permit`); core hosts many guards (`GuardianAgent`, `OutboundNetworkPolicy`, `ToolPoisoningGuard`…). No single authz choke point. _(census pending; enumerated from package maps)_                                      |

**Enforcement: ENFORCED (ceilings).** `packages/core/tests/architecture/duplicationCountGuard.test.ts`
(wired into `pnpm test:arch`) fails if orchestrator/store/memory/stateMachine counts increase
above locked live ceilings (orchestrator≤10, store≤51, memory≤19 allowlist, stateMachine≤6 =
classes + RUN/STEP_TRANSITIONS). Methodology is pure-fs walk + locked regexes in that file
header. Lowering a ceiling requires a real deletion + evidence; raising requires intentional
amendment + this changelog. Policy decision point row remains unenforced (census pending).

**Gap to close:** pick the V2 canonical for each row. Next dedup targets: dual
`EpisodicMemoryStore` (core vs apps/api) and eventual merge of `MemoryCurator` +
`TtlMemoryCurator` into one stack. Count-guard ENFORCED (ceilings only — does not force deletions).

---

## 4. Durability claims

**Invariants**

1. "Durable" means backed by a real database or fsync'd storage. In-memory is a test default,
   never a production default, for anything described as durable.
2. A feature is "default" only if it runs with zero flags set. If it needs a flag, it is opt-in
   everywhere — including docs and marketing copy.

**Conformance today** — durability is real but bimodal, and the strongest tier is _not_ the default:

- REAL: kernel Postgres with transactional outbox (`kernel/src/postgres.ts:815-817`), core ATR
  `RunLedger`/idempotency/checkpoint in SQLite-WAL (`atr/runLedger.ts:205`, `atr/checkpointStore.ts:9`),
  `atomicWrite` fsync-then-rename (`core/src/tools/_utils/atomicWrite.ts:14`; `apps/api/src/atomicWrite.ts:23-45`).
- WEAK / FALSE claims:
  - `EventSourcingEngine` constructor defaults `walPath=null` (in-memory). Singleton
    `getGlobalEventSourcingEngine()` defaults to `.commander_state/event-sourcing.wal`
    (or `COMMANDER_EVENT_SOURCING_WAL`). Header + `isDurable()` clarify optional WAL
    (fixed 2026-07-15).
  - `apps/api` `EpisodicMemoryStore` is JSON + in-memory `Map`s (`episodicMemoryStore.ts` —
    header corrected 2026-07-15; still not SQLite/atomic). Parallel to core `memory/episodicStore.ts`.
  - `apps/api` `StateMachine` checkpoints use plain non-atomic `fs.writeFileSync`
    (`stateMachine.ts:169,198`).
- (2) **HOLDS for `/v1` durable path (as of 2026-07-15):** kernel defaults ON in production,
  under `COMMANDER_V2_MODE=1`, or when a Postgres DSN is set (`isCommanderKernelEnabled`);
  production refuses `COMMANDER_KERNEL_ENABLED=0` and refuses boot without DSN + initialized
  gateway. Explicit `=0` remains a non-prod escape hatch only. This is **not** yet
  "zero-flag durable" for every local compose path: default compose without a DSN still needs
  either a DSN or explicit `=0` because the image sets `NODE_ENV=production`.
  WarRoomStore remains the non-`/v1` mission store, not the `/v1` run authority.

**Gap to close:** finish WarRoomStore demotion/removal as non-/v1 mission store only;
keep claim-honesty guards green; prefer kernel event log over dual V1 event engines.

---

## 5. Naming

**Invariant:** package, dir, module, and class names describe **function, not ambition**. If a rename
would make the purpose obvious to someone outside the team, do the rename.

**Conformance today — VIOLATED broadly.** Aspirational names in `@commander/core`:
`ultimate/` (45 files) + `UltimateOrchestrator`, `telos/` + `TELOSOrchestrator`, `hub/`, `showcase/`

- `ShowcaseRunner` ("killer demo"), `swarm/`, `drive/`, `shadow/`, `selfEvolution/`, `companyEngine.ts`,
  `contracts/pillarI.ts`…`pillarIV.ts`. In `apps/api`: war-room theming (`store.ts:93`), `/api/v1/hub`
  (`index.ts:730`). Default project id is `project-war-room` (`apps/api/src/index.ts:111`).
  Also **misnamed**: `@commander/control-plane` is actually a contracts/types package with no runtime
  (`control-plane/src/index.ts:4-6`).

**Enforcement: NONE.** No lint flags ambition-naming.

**Gap to close:** rename `control-plane`→ (its real function) or fold into `contracts`; treat new
`ultimate/telos/hub/showcase`-style names as review blockers.

---

## 6. Enforcement mechanisms (what actually gates)

The real ENFORCED layer today is `packages/core/tests/architecture/` (run via `pnpm test:arch`):

- `architectureV2.invariants.test.ts` asserts: apps/api sole Gateway (`:34`), `CommanderHttpServer`
  deprecated (`:40`), `createDriverSoft` fail-closes in prod (`:46`), `SideEffectGate` wired into
  `ToolExecutionService` (`:52`), ATR `pauseRun`/`claimRunnableRun` (`:63`), `waiting_for_human`
  first-class (`:70`), V2 packages exist (`:85`), SDK versioned `v1` (`:91`), DR runbook exists (`:101`),
  no silent `scheduleAction` bypass (`:113`).
- The `v2-*` suite covers cross-node fencing, outbox at-least-once + DLQ, event-sourcing integrity,
  compensation rollback, RPO/RTO drill, cross-tenant live-fire, worker autoscale.

**Unenforced principles** (aspirational text only — flag if still unenforced at next review):
§1 dependency direction (no boundary linter), §5 naming (no lint).
§3 duplication count ceilings are ENFORCED via `duplicationCountGuard.test.ts` (growth-only).

---

## Change log

- **2026-07-15 (iteration: §3 count-guard methodology lock)** — Rewrote
  `duplicationCountGuard.test.ts` to the locked audit methodology: pure-fs walk of
  packages/** + apps/**; orchestrator `export class *Orchestrator` (10); store
  `*Store|*Repository` (51 live, not stale 49); memory **fixed allowlist of 19**
  product systems (not broken path check that counted 0 / not path-walk 24–32);
  stateMachine **6** = 4 `*StateMachine` classes + `RUN_TRANSITIONS` +
  `STEP_TRANSITIONS`. Ceilings = live only. §3 Enforcement PARTIAL → ENFORCED;
  §6 unenforced list drops §3 count-guard. Lowering ceilings needs real deletion
  - evidence; raising needs PRINCIPLES changelog.

- **2026-07-15 (iteration: EventSourcingEngine WAL claim honesty)** — Clarified
  optional WAL: constructor default is in-memory; singleton may default a file path.
  Added `isDurable()` / `getWalPath()`. claimHonesty arch test guards the header.
  §3 gap text no longer asks for count-guard (already ENFORCED) or dual MemoryCurator
  same-name (renamed to TtlMemoryCurator).

- **2026-07-15 (iteration: MemoryCurator naming disambiguation)** — Renamed TTL/expiry
  curator `memory/memoryCurator.ts` class to `TtlMemoryCurator` (was colliding with
  autonomous `memory/curator.ts` `MemoryCurator`). Deprecated aliases retained for one
  window. ThreeLayerMemory + tests updated. Count ceilings unchanged (still two impls);
  §5 naming debt reduced for this pair.

- **2026-07-15 (iteration: §3 count-guard ENFORCED)** — Added
  `duplicationCountGuard.test.ts` with locked pure-fs census + ceilings
  (orchestrator≤10, store≤51, memory≤21 scoped, stateMachine≤4). Wired into
  `pnpm test:arch`. Updated §3 table to methodology-locked counts (store 51,
  memory 21, SM 4 class-only). Enforcement upgraded NONE → PARTIAL. (Superseded by
  methodology-lock entry above: memory 19 allowlist, SM 6 incl. transitions.)

- **2026-07-15 (iteration: claim honesty — api EpisodicMemoryStore)** — Corrected false
  "SQLite + Vector Index" file header on `apps/api/src/episodicMemoryStore.ts`. Implementation
  remains JSON + in-memory Maps (not durable SQLite). Dual store vs core still EXISTS+WIRED;
  consolidation deferred (apps/api/src/index.ts still constructs it).

- **2026-07-15 (iteration: orphan allocator delete)** — Deleted dead
  `apps/api/src/deterministicTaskAllocator.ts` (484 LOC) after adversarial verify:
  zero product importers / package exports / tests / `.cjs` requires / dynamic import
  strings; only PRINCIPLES + architecture-gate allowlist referenced it. Removed
  `legacyImportExceptions` (×2) and `authorityExceptions` entries for that file;
  dropped `apps/api/dist/deterministicTaskAllocator.*`. Orch/store/memory/SM live
  counts unchanged (allocator was not counted as an Orchestrator). §0 kernel default-on
  wording already aligned in prior honesty pass.

- **2026-07-15 (iteration: PRINCIPLES honesty)** — Fixed §0 stale wording that said the
  durable path is "gated off by default"; it now matches `isCommanderKernelEnabled` auto-on
  (production / V2 / DSN).

- **2026-07-15 (iteration: effect admission force)** — Worker bootstrap
  `PolicyEvaluator` no longer defaults to permit-all. `createWorkerPolicyEvaluator()`
  is fail-closed (`deny-default`); explicit `COMMANDER_WORKER_EFFECT_POLICY=permit`
  restores the legacy allow-all for local demos only. ENFORCED by
  `packages/worker-plane/src/bootstrap.policy.test.ts`.

- **2026-07-15 (iteration: kernel default-on)** — `/v1` durable kernel is no longer
  only `COMMANDER_KERNEL_ENABLED=1`. `isCommanderKernelEnabled()` defaults ON in
  production, under `COMMANDER_V2_MODE=1`, or when a Postgres DSN is present;
  production refuses explicit `=0` and refuses boot without DSN + initialized gateway;
  explicit `=0` remains non-prod escape hatch only. WarRoomStore remains non-/v1
  missions/UI store, not the /v1 run authority. ENFORCED by
  `apps/api/test/kernelEnabled.test.ts`.

- **2026-07-14 (iteration 1: dead-code deletion)** — First gated improvement iteration. Deleted, after
  adversarial verify-dead review (workflow `wf_0ef6d0a1-41b`, one refuting skeptic per candidate):
  `AdaptiveOrchestrator` (+ its orphaned `TaskComplexityOptions` import), the dead `Orchestrator`
  class/plan section of `apps/api/src/orchestrator.ts` (file slimmed to the live, test-covered
  `runAgentStep`), the whole `@commander/orchestration` package (dead divergent fork of
  `core/src/planner/workGraphPlanner.ts`), `core/src/runtime/lockFreeStateStore.ts` (whole file
  - orphaned `ILockFreeStateStore` in `pillarI.ts`), and the `DatasetStore` verbatim copy
    (5 consumers repointed to `core/src/observability/dataset.ts`). Counts: orchestrator 13→10,
    store 51→49. Amendment: the §6 invariant test's package list was updated
    (`architectureV2.invariants.test.ts:85` no longer asserts `packages/orchestration` exists) —
    this amends an outdated assertion rather than weakening a principle: the package was
    imported by zero files and the enterprise-trust audit ARCH-1 had already slated it for deletion.
    Verify-dead findings worth keeping: the census's whole-file deletion claim for
    `apps/api/orchestrator.ts` was REFUTED by a `.cjs` test requiring the compiled
    `dist/orchestrator.js` (LSP-invisible) — adversarial verification before deletion stays mandatory.

- **2026-07-14** — Initial honest baseline. Written from architecture inventory `wf_db80bc0a-04f`
  (15 package maps + orchestrator/store/memory/state-machine duplication censuses). Records the
  V1→V2 strangler split and the live duplication counts (orchestrator 13, store 51, memory 19,
  state-machine 6) as the debt the "single canonical" invariants exist to retire. No principle is
  enforced beyond the `test:arch` suite; §1/§3/§5 are aspirational pending a boundary linter,
  count-guard, and naming lint respectively.
  Provenance note: the orchestrator/store/memory/state-machine counts in §3 are census-backed; the
  policy-decision-point row (§3) and the §2/§4/§5 conformance findings are reconstructed from the
  15 package maps (each file:line-cited) — the dedicated policy census and the plane/durability/
  flag/naming audit agents failed on infrastructure errors (one stall + `CERTIFICATE_VERIFICATION`
  on 4 agents) and should be re-run to promote those sections from map-backed to audit-backed.
