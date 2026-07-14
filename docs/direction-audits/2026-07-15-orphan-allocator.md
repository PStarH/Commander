# Direction Audit — Orphan DeterministicTaskAllocator deletion

**Date:** 2026-07-15  
**Branch:** `p0/v2-kernel-e2e-closure`  
**Prior:** C/A/B commit `e6935af`

## Problem statement (falsifiable)

`apps/api/src/deterministicTaskAllocator.ts` still exists on disk and is listed in
`scripts/architecture-gate.config.json` exception lists, but has **zero importers**
outside its own file. PRINCIPLES.md §3 already marks it as the next delete target.
Keeping it grows exception-list debt and false surface area.

## Canonical-home check

Searched (source-only, excluding node_modules/dist):

- `deterministicTaskAllocator` / `DeterministicTaskAllocator` / `getDeterministicTaskAllocator`
- Results: only `apps/api/src/deterministicTaskAllocator.ts`, PRINCIPLES.md, architecture-gate.config.json
- No apps/api tests, no package.json exports, no dynamic import strings found

## Fit against PRINCIPLES

- §3 single decision points — deleting an orphan **shrinks** surface (exception list −3 entries)
- Does not add a parallel allocator
- Duplication delta: orchestrator/store/memory counts unchanged (this was never counted as a live orchestrator); exception-list shrinks

## Strongest measurable contribution

Remove a named dead module and its architecture-gate exemptions so reintroduction fails CI
(via a new orphanDeletion guard test).

## Opportunity cost

1. Dual EpisodicMemoryStore consolidation — higher value but higher blast radius (apps/api still imports it)
2. Dual MemoryCurator consolidation — both still WIRED (unifiedMemory + threeLayerMemory)
3. Count-guard for orch/store/memory/SM — good ENFORCEMENT, larger design
4. This orphan delete — lowest risk, PRINCIPLES-named next step

**Why this wins today:** completeable in one iteration; prior loop already paid for census; dual memory needs a full consumer map.

## Blast radius

- Delete one file + scrub architecture-gate.config.json + PRINCIPLES + guard test
- Must not touch kernel/worker/effect paths

## Definition of done

1. `apps/api/src/deterministicTaskAllocator.ts` does not exist
2. `scripts/architecture-gate.config.json` has zero `deterministicTaskAllocator` strings
3. Guard test in `packages/core/tests/architecture/` fails if file or exception returns
4. `pnpm test:arch` or equivalent node:test for the guard passes
5. PRINCIPLES changelog dated entry

## Decision

**Proceed** — contingent on explicit human approval to delete
`apps/api/src/deterministicTaskAllocator.ts` (auto-mode safety gate requires naming the file).

## Duplication delta

Grow/shrink: **shrink** exception surface; product orchestrator count unchanged.
