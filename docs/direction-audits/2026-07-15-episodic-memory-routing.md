# Direction Audit + Routing Plan — Dual EpisodicMemoryStore

**Date:** 2026-07-15  
**Branch:** `p0/v2-kernel-e2e-closure`  
**Decision:** **Proceed (strangler delete of apps/api store)** — not a merge of APIs  
**Status:** Phase A **DONE** (health decouple + path-override tests no longer require module). Phase B delete of `apps/api/src/episodicMemoryStore.ts` + unit test **pending explicit user approval to delete those files**.  
**Why not full merge:** the two classes are **different products** with incompatible contracts; apps/api copy is effectively a **health-only zombie**.

---

## 1. PROBLEM STATEMENT (falsifiable)

Two classes named `EpisodicMemoryStore` exist:

| Impl                 | Path                                        | Role                                                       |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| **Core (canonical)** | `packages/core/src/memory/episodicStore.ts` | ACT-R activation / `IEpisodicStore` (Pillar IV)            |
| **API (parallel)**   | `apps/api/src/episodicMemoryStore.ts`       | JSON file + TF-IDF vector index, project-scoped “memories” |

PRINCIPLES §3 lists this as dual-store debt. Count-guard memory allowlist counts **both** class names (two hits under the same symbol).

**Falsifiable claim:** The apps/api instance is **not** on any product HTTP write/read path for episodic memory; it only appears in health/ready/status probes and shutdown flush. Verified 2026-07-15.

---

## 2. EVIDENCE RULE — EXISTS / WIRED / ENFORCED

### Core store

| Claim                                                      | Status      | Citation                                            |
| ---------------------------------------------------------- | ----------- | --------------------------------------------------- |
| Class implements `IEpisodicStore`                          | **EXISTS**  | `packages/core/src/memory/episodicStore.ts:41`      |
| Contract: `record` / `recall` / `reinforce` / `applyDecay` | **EXISTS**  | `packages/core/src/contracts/pillarIV.ts:45-54`     |
| Wired into ThreeLayerMemory mirror/recall                  | **WIRED**   | `threeLayerMemory.ts:27,324,530-535,799-823`        |
| Tenant singleton                                           | **WIRED**   | `episodicStore.ts:323-328` `getGlobalEpisodicStore` |
| ENFORCED by product tests                                  | **PARTIAL** | core memory tests; no arch forbid on second class   |

### API store

| Claim                              | Status                | Citation                                                                                      |
| ---------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Class + JSON/TF-IDF index          | **EXISTS**            | `apps/api/src/episodicMemoryStore.ts:401+`                                                    |
| Constructed at boot                | **WIRED (singleton)** | `apps/api/src/index.ts:190`                                                                   |
| Used by `/ready` check             | **WIRED**             | `index.ts:358` always `'ok'` if constructed                                                   |
| Used by `/health/detailed` modules | **WIRED**             | `index.ts:412`                                                                                |
| Used by status modules             | **WIRED**             | `index.ts:483`                                                                                |
| Shutdown flush                     | **WIRED**             | `index.ts:1198` `doPersist`                                                                   |
| Used by any feature router         | **MISSING**           | no `episodicMemoryStore.` method calls outside `index.ts` health/shutdown; no Endpoint import |
| Unit tests                         | **EXISTS**            | `apps/api/tests/episodicMemoryStore.test.ts` (313 LOC)                                        |
| Architecture-gate exception        | **EXISTS**            | `scripts/architecture-gate.config.json` lists `episodicMemoryStore.ts`                        |
| Durability claim honesty           | **ENFORCED**          | header fixed 2026-07-15; `claimHonesty.test.ts`                                               |

### Real API memory surfaces (do not confuse)

These are the **live** memory product paths on the Gateway:

| Component                   | Path                                         | Role                                            |
| --------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `ProjectMemoryStore`        | `apps/api/src/memoryStore.ts`                | Project memory CRUD (missions UI)               |
| `MemoryIndexManager`        | `apps/api/src/memoryIndexManager.ts`         | Domain index                                    |
| `NamespacedMemoryStore`     | `apps/api/src/namespacedMemoryStore.ts`      | Namespaced items                                |
| `ProjectMemoryStoreAdapter` | `apps/api/src/memoryStoreAdapter.ts`         | Optional bridge to **core** `createMemoryStore` |
| Routes                      | `createProjectRouter(..., memoryStore, ...)` | `/projects/{id}/memory*`                        |

None of these take the apps/api `EpisodicMemoryStore` instance.

---

## 3. CANONICAL-HOME CHECK

| Concept                                              | Canonical home                                                 | Action                             |
| ---------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| ACT-R episodic (context/action/outcome + activation) | `packages/core/src/memory/episodicStore.ts` + `IEpisodicStore` | **Keep / extend**                  |
| Project/mission memories (title/content/type/tags)   | `ProjectMemoryStore` + optional core `MemoryStore` via adapter | **Keep**                           |
| apps/api `EpisodicMemoryStore`                       | **None — zombie**                                              | **Delete after health decoupling** |

Do **not** try to make core ACT-R store implement the API `write/read/getStats` shape. That would grow a god-adapter and violate “one concept.”

---

## 4. FIT AGAINST PRINCIPLES.md

| Principle             | Effect of this plan                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3 one canonical impl | **Shrinks** dual `EpisodicMemoryStore` class declarations (memory allowlist −1)                                                                         |
| §4 durability honesty | Already fixed header; deletion removes JSON-as-memory dual path noise                                                                                   |
| §2 plane separation   | Gateway should not own a parallel episodic engine; workers/core own cognitive memory                                                                    |
| Duplication delta     | store/memory counts: memory allowlist **19 → 18** after delete; store count unchanged (class name is Memory* not *Store in allowlist — still memory −1) |

---

## 5. WHAT “STRONGEST” MEANS HERE

Measurable:

1. Zero `export class EpisodicMemoryStore` under `apps/api/`
2. Memory count-guard ceiling **19 → 18** with green `test:arch`
3. Architecture-gate exception list loses `episodicMemoryStore.ts`
4. `/ready` no longer pretends a non-product module is a readiness dependency

---

## 6. OPPORTUNITY COST

| Alternative                     | Why not first                                       |
| ------------------------------- | --------------------------------------------------- |
| Build adapter API→core ACT-R    | No product route needs it; pure engineering theater |
| Merge types into one mega-store | Violates two different domain models                |
| Only docs (“prefer core”)       | Does not shrink counts or exception lists           |
| Delete ProjectMemoryStore       | **WIRED** to real routes — wrong target             |

---

## 7. BLAST RADIUS

| Phase                                                    | Touches                                                   | Risk                               |
| -------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| A Health decouple                                        | `apps/api/src/index.ts` only                              | Low — probes change meaning        |
| B Delete store + tests + gate exception                  | `episodicMemoryStore.ts`, tests, gate config, count-guard | Low-med — verify no dynamic import |
| C Optional: expose core episodic via worker/runtime only | core already wired                                        | Out of scope for delete            |

**Must not touch:** `ProjectMemoryStore`, namespaced memory routes, kernel, worker bootstrap.

---

## 8. ROUTING PLAN (strangler phases)

### Phase A — Decouple health (no product behavior change)

**Goal:** Stop treating zombie store as readiness-critical.

1. Remove `const episodicMemoryStore = new EpisodicMemoryStore()` **or** keep behind `COMMANDER_API_EPISODIC_PROBE=1` (default off).
2. Remove `episodicMemoryStore` from `/ready` checks (or mark optional / omit).
3. Remove from `/health/detailed` and status `modules` **or** report `'absent'` / omit key.
4. Remove shutdown `doPersist` (or no-op if flag off).
5. Test: ready returns 200 without constructing the store.

**DoD:** Boot without `apps/api` EpisodicMemoryStore; ready green; no import cycle.

### Phase B — Delete apps/api implementation

**Goal:** One class name left (core).

1. Adversarial re-verify: `rg EpisodicMemoryStore apps/api` only hits tests + file itself.
2. Delete `apps/api/src/episodicMemoryStore.ts`.
3. Delete or rewrite `apps/api/tests/episodicMemoryStore.test.ts` (prefer delete).
4. Scrub `scripts/architecture-gate.config.json` exceptions for `episodicMemoryStore.ts`.
5. Lower memory ceiling in `duplicationCountGuard.test.ts` **19 → 18**.
6. Extend `orphanDeletion.test.ts`: file must not exist.
7. PRINCIPLES §3 table + changelog.

**DoD:** `pnpm test:arch` green; `pnpm arch:gate` green; api unit tests that remain green.

### Phase C — Product routing (only if product needs ACT-R at edge)

**Not required for dual-delete.** If later product wants Gateway-visible ACT-R episodic:

1. Add thin `/v1` or internal route that calls `getGlobalEpisodicStore()` **or** submits a kernel step.
2. Types stay `IEpisodicRecord` / `EpisodicQuery` from contracts — **not** the old API `EpisodicMemory` shape.
3. Prefer worker-plane / agent runtime path over Gateway local store (plane separation).

**DoD:** No new class named `EpisodicMemoryStore` under apps/api; contracts-owned types only.

### Explicit non-goals

- Do not reimplement TF-IDF vector index in core “for compatibility.”
- Do not make `ProjectMemoryStore` an alias of ACT-R episodic.
- Do not migrate historical JSON files from `COMMANDER_EPISODIC_FILE` unless an operator asks (data is unused by routes).

---

## 9. INTERFACE FREEZE (if Phase C ever happens)

```ts
// packages/contracts — already exists (pillar IV)
interface IEpisodicStore {
  record(experience: Omit<IEpisodicRecord, 'id' | 'activation'>): Promise<IEpisodicRecord>;
  recall(query: EpisodicQuery): Promise<IEpisodicRecord[]>;
  reinforce(id: string): Promise<void>;
  applyDecay(hoursElapsed: number): Promise<number>;
}
```

Gateway must not invent a second public JSON schema for “episodic.” If UI needs title/content/type, that is **ProjectMemory**, not IEpisodicStore.

---

## 10. DEPENDENCY GRAPH

```
Phase A (health decouple)
    └── blocks Phase B (delete)
Phase C independent (optional product feature)
count-guard ceiling drop happens in Phase B only
```

---

## 11. DEFINITION OF DONE (whole routing initiative)

| #   | Criterion                                               | Verifiable                   |
| --- | ------------------------------------------------------- | ---------------------------- |
| 1   | No `export class EpisodicMemoryStore` under `apps/api/` | `rg` + orphanDeletion test   |
| 2   | Memory allowlist count ≤ 18                             | `duplicationCountGuard`      |
| 3   | Gate config has no `episodicMemoryStore.ts` exception   | `arch:gate` + orphanDeletion |
| 4   | `/ready` does not depend on api episodic singleton      | curl / unit                  |
| 5   | Core `IEpisodicStore` still WIRED via ThreeLayerMemory  | existing core tests          |
| 6   | PRINCIPLES §3 updated with DELETED date                 | file                         |

---

## 12. DECISION

**Proceed with Phase A → B immediately** (delete zombie; do not merge APIs).  
**Defer Phase C** until a product requirement for Gateway ACT-R episodic exists.

**Duplication delta:** shrink (memory dual class −1).  
**Does not grow** parallel adapters.

---

## 13. RECOMMENDED IMPLEMENTATION ORDER (next coding session)

1. **Phase A** PR-sized patch on `apps/api/src/index.ts` (+ ready tests if any).
2. **Phase B** delete file/tests/gate/ceiling/guards.
3. Open follow-up only if product asks for Phase C.

---

## 14. OPEN / UNVERIFIED

- Whether any **external operator scripts** import `apps/api/dist/episodicMemoryStore.js` (not in repo tests; check before Phase B if dist is published).
- Whether any **dashboard** keys on `modules.episodicMemoryStore === 'active'` string (health contract change — document in changelog).
- Live JSON files under default episodic paths may remain on disk after delete (harmless garbage).

## 14. OPEN / UNVERIFIED + HARD DEPENDENTS

### Hard dependents found after deeper search (must handle in Phase B)

| Dependent | Path | Implication |
|---|---|---|
| Path-override unit tests | `apps/api/test/store-path-overrides.test.cjs` + `.js` | `require('../dist/episodicMemoryStore.js')` — **must delete or rewrite tests** when removing the module (same REFUTE pattern as prior orchestrator dist require) |
| Spawn helper comment | `apps/api/test/_helpers/spawnServer.js:68` | Docs only |
| Architecture-gate allowlist | `scripts/architecture-gate.config.json` ×3 | Scrub on delete |

### Still UNVERIFIED

- Whether any **dashboard** keys on `modules.episodicMemoryStore === 'active'` (health contract change — document in changelog).  
- Live JSON files under default episodic paths may remain on disk after delete (harmless garbage).  
- No external npm consumer of apps/api dist (api is app, not published package) — assumed safe.

## 15. IMPLEMENTATION NOTE FOR PHASE B TESTS

`store-path-overrides` tests cover env path capture for episodic + vector files. Options:

1. **Delete** those episodic cases (preferred if store is product-dead).  
2. **Retarget** path-override tests at `ProjectMemoryStore` or another live JSON store that still uses env paths.

Do not leave a dist-only stub class solely to satisfy path-override tests.
