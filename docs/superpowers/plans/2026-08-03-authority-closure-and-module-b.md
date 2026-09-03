# Authority Closure and Module B Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with a fresh verification cycle for every change. Do not promote local or simulated evidence to `PROVEN`.

**Goal:** Close every A-owned Authority Closure gap with retained real-infrastructure evidence, then begin Module B only after the A gate truthfully reaches `PROVEN`.

**Architecture:** Keep the kernel as durable lifecycle authority, the EffectBroker as the only consequential-effect admission path, and adapter-ops as the reconciliation/compensation owner. Real proof must run through separate gateway, kernel-ops, worker, broker, adapter, PostgreSQL, and external-provider boundaries; missing credentials or topology is a blocker, not a fallback to mocks.

**Tech Stack:** TypeScript/Node 22, pnpm workspaces, PostgreSQL with real roles/RLS, Docker/Kind, GitHub or ServiceNow sandbox adapter, Ed25519 signed evidence, GitHub Actions.

## Global Constraints

- `PROVEN` requires real infrastructure, real process boundaries, fault injection, and retained evidence metadata.
- Do not modify B/C/D/shared-PostgreSQL code from an A-owned fix without an explicit ownership handoff.
- Do not weaken fail-closed gates, skip required fault points, use mocks, or relabel `ENFORCED`/`WIRED` output as `PROVEN`.
- Preserve the event-selected CI matrix: PR Quality is canonical Ubuntu/Node 22; compatibility entries run only on main/manual events.
- Keep the user’s dirty and untracked worktree changes intact.

### Task 1: Reproduce and record the current A proof ceiling

**Files:**
- Run: `scripts/authority-closure-proof.ts`, `scripts/action-operations-proof.ts`, and the proof preflight tests.
- Evidence: `.internal/evidence/a-restart/2026-08-03/`.
- Runbook: `.internal/runbooks/2026-08-02-a-restart-status.md`.

- [ ] Run fail-closed preflight with the current environment and record every missing required input.
- [ ] Run the local A gate runner and package-level worker/EffectBroker suites; retain exact counts and hashes.
- [ ] Compare each result with the product-proof matrix and mark only the strongest observed level.

### Task 2: Fix an A-owned defect only when a RED test identifies it

**Files:**
- Modify only the A-owned kernel/worker/effect-broker files identified by Task 1.
- Test: the smallest focused regression test beside the affected implementation.

- [ ] Write and run one failing regression test for the identified A-owned behavior.
- [ ] Implement the smallest authority-preserving fix.
- [ ] Run the focused test, full worker suite, EffectBroker suite, typechecks, `arch:guard`, and `arch:gate`.

### Task 3: Execute the real A-D proof campaign

**Inputs:** real PostgreSQL role DSNs, signed-evidence key, process/container topology, real external sandbox credentials, and an authorized runner.

- [ ] Run the full fault campaign: forward response loss, claimant kill, outcome-query restart, compensation response loss, compensation query restart, evidence persistence failure, stale-drain denial, and backup/restore.
- [ ] Verify external write counters and signed API receipts independently from the producing process.
- [ ] Validate artifact metadata, source cleanliness, topology, backend roles, hashes, fault points, and observed outcomes.
- [ ] Promote the verdict only if every mandatory matrix row is `PROVEN`; otherwise record the exact blocker and stop A closure.

### Task 4: Begin Module B after A is proven

**Files:** Module B-owned SDK files and tests only after Task 3 passes.

- [ ] Create RED tests for the first B-owned failure, beginning with the Python SDK Ruff inventory if that remains the first blocker.
- [ ] Apply minimal B-owned fixes, then run Ruff, pyright, pytest, and the canonical CI checks.
- [ ] Keep A’s proven artifact immutable and record B evidence separately.

## Verification Gate

Before claiming completion, require fresh output for all mandatory tests, a retained real proof artifact with `evidenceLevel: PROVEN`, an independent receipt verification, a clean identified source commit, and `Authority Closure: YES` in the runbook. If any prerequisite is unavailable, report `BLOCKED / NOT PROVEN` and do not begin Module B.
