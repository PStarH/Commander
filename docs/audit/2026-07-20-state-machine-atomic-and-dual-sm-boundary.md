# Architecture Boundary Note — 2026-07-20

## Fixed (small, isolated)

**Boundary:** Storage durability helper vs legacy Gateway state-machine persistence.

**Violation:** `apps/api/src/stateMachine.ts` claimed checkpoint/state persistence while using
non-atomic `fs.writeFileSync` (PRINCIPLES §4 WEAK claim). Elsewhere Gateway already owns
`atomicWriteFileSync` / `readJsonFileSafe` (`apps/api/src/atomicWrite.ts`) for
`WarRoomStore` and `AgentStateStore`.

**Fix:** Route `persistState` / `saveCheckpoint` through `atomicWriteFileSync` and
load paths through `readJsonFileSafe`. Enforced by `claimHonesty.test.ts`. PRINCIPLES §4
updated; stale dual `EpisodicMemoryStore` claim text corrected.

**Not fixed (by design):** The module remains `@legacy` and is not the V2 run authority
(`@commander/contracts` RUN/STEP tables + kernel SQL transitions).

## Residual high-value boundary (finding — redesign required)

### Dual state-machine engines on the live Gateway surface

| Surface                                            | Owner                              | Live path?                  | Authority for `/v1` runs? |
| -------------------------------------------------- | ---------------------------------- | --------------------------- | ------------------------- |
| `contracts` `RUN_TRANSITIONS` / `STEP_TRANSITIONS` | ABI                                | types only; zero call sites | intended                  |
| kernel SQL transitions (`packages/kernel`)         | durable authority                  | yes (`/v1`)                 | **yes**                   |
| `apps/api/src/stateMachine.ts` `StateMachine`      | legacy HTTP `/api/state-machine/*` | mounted on Gateway          | **no**                    |
| `apps/api/src/patternStateMachine.ts`              | pipeline endpoints                 | compatibility mode          | **no**                    |
| core `TaskStateMachine` / `TopologyStateMachine`   | V1 orchestration                   | CLI/local                   | **no**                    |

**Why it exists:** Strangler migration — legacy demo/HITL state machine and pattern pipelines
predate plane separation; kernel is the only multi-replica-safe run authority.

**Systemic risk:** Operators/SDK users may treat `/api/state-machine/*` or mission store state
as durable run lifecycle. In-memory `Map` of machines in `stateMachineEndpoints.ts` still
loses in-flight tasks on restart (documented in endpoint header). Six SM implementations
remain under the duplication ceiling (`stateMachine≤6`).

**Recommended owner for redesign (strategic agents):** WP7 / run-lifecycle consolidation.
Do **not** expand features on `apps/api` StateMachine. Prefer:

1. Deprecate + 410 `/api/state-machine/*` after UI/clients migrate to `/v1` pause/approve.
2. Re-home any still-needed governance checkpoint UX onto kernel waiting_for_human + effect broker.
3. Delete `patternStateMachine` after pipeline callers move to WorkGraph steps.
4. Keep `claimHonesty` + `duplicationCountGuard` green; never raise the SM ceiling.

### Dual event engines (related)

V1 `EventSourcingEngine` (file WAL / optional in-memory) vs kernel event log + outbox.
`/v1` must remain kernel-only; V1 engine is for local CLI recovery. Prefer kernel event log
over dual writers; do not wire Gateway product paths onto `getGlobalEventSourcingEngine()`.
