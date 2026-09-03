# G1-G8 Enterprise Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute and retain an honest G1-G8 acceptance bundle for the bounded, dedicated Commander design-partner offer.

**Architecture:** Keep the existing Gateway, Postgres kernel, worker/effect-broker, adapter, MCP, and signed-evidence boundaries as the only authorities. Add only the missing acceptance aggregation and usability evidence needed to prove those boundaries; do not add fallback execution or treat previews, fixtures, or third-party provider smoke as customer proof.

**Tech Stack:** Node 22, pnpm 9, TypeScript, Node test runner, Docker/Kind, PostgreSQL, existing Commander proof scripts, Markdown evidence.

## Global Constraints

- Enterprise Gateway remains dedicated/self-hosted for the first pilot; shared multi-tenant SaaS remains alpha.
- External writes use `/v1/actions` or MCP; workflow previews never count as external execution.
- Deterministic CI remains no-key, no-network; live provider smoke is opt-in and redacted.
- Fake Kubernetes is permitted only in test fixtures and cannot be used for G5/G6 proof claims.
- Retained artifacts must exclude API keys, prompts, raw responses, credentials, tokens, customer data, and private keys.
- A gate is `PROVEN` only when its required external system and evidence conditions pass; missing prerequisites are `NOT_READY`.

## Evidence Map

| Gate | Required result | Primary command/artifact |
| --- | --- | --- |
| G1 | clean release candidate passes build, lint, tests, contract, architecture, deploy gates | CI/local logs under the run-scoped evidence directory |
| G2 | fresh install and first run outside the checkout, with teardown | install smoke report and sanitized quickstart record |
| G3 | one durable Postgres authority path with real external-process identities | `proof:authority`, `p0:full-loop`, action-operations proof |
| G4 | DR and signer rotation preserve receipts and reject revoked signers | `dr:verify --full`, `rotate:verify` reports |
| G5 | real Kind Kubernetes rollback benchmark meets exact write/recovery thresholds | `kubernetes-rollback-kind` and governed-rollback benchmark artifacts |
| G6 | dedicated-pilot security floor passes with no open scoped P0/P1 | claim/security gate outputs and sanitized scan report |
| G7 | independent reader completes install, approval, recovery, receipt verification, kill switch, teardown | signed usability record and quickstart/support docs |
| G8 | immutable release evidence bundle validates hashes, schemas, claims, and limitations | `launch:verify` report and bundle manifest |

### Task 1: Capture clean baseline and prerequisite status

**Files:** Create run-scoped evidence directory only; do not modify source.

- [ ] **Step 1: Record source and environment identity**

Run:

```bash
export EVIDENCE_ROOT="$PWD/artifacts/enterprise-acceptance/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_ROOT"/{g1,g2,g3,g4,g5,g6,g7,g8,logs}
git status --short --branch > "$EVIDENCE_ROOT/source-status.txt"
git rev-parse HEAD > "$EVIDENCE_ROOT/commit.txt"
pnpm --version > "$EVIDENCE_ROOT/pnpm-version.txt"
node --version > "$EVIDENCE_ROOT/node-version.txt"
```

- [ ] **Step 2: Run existing honesty and readiness checks**

Run `pnpm claim:gate`, `pnpm check:readiness`, and `pnpm verify:evidence`, writing stdout/stderr to `g6` and `g8` logs. Record each exit code; do not convert failures to warnings.

- [ ] **Step 3: Classify prerequisites**

Record whether Docker, Kind, kubectl, PostgreSQL tools, an independent restore target, GPG public key, evidence JWKS, and a real sandbox destination are present. A missing item remains `NOT_READY` for the dependent gate.

### Task 2: Execute G1 branch-trust gate

**Files:** No source changes unless a failing command identifies a scoped defect; retain logs in `g1`.

- [ ] **Step 1: Run required local gates**

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:contract`, `pnpm arch:guard`, `pnpm test:deploy-gates`, and `pnpm p0:kernel-e2e` with `set -o pipefail` and per-command logs.

- [ ] **Step 2: Fix only reproducible G1 failures**

For a failure, add a focused regression test first, implement the smallest existing-pattern fix, rerun that test, then rerun the failed gate. Preserve unrelated dirty-worktree changes.

- [ ] **Step 3: Produce G1 verdict**

Write `g1/verdict.json` with command names, exit codes, commit, lockfile hash, and `PROVEN` only when every required command exits zero on a clean release candidate. Otherwise write `NOT_READY` with exact failures.

### Task 3: Execute G2 installation and first-run gate

**Files:** Modify `docs/getting-started.md` and `docs/deploy.md` only if the observed fresh-environment path is undocumented; create `scripts/install-smoke.ts` and its test only if no existing command can perform the required smoke.

- [ ] **Step 1: Test a fresh environment**

From a temporary directory outside the checkout, install the documented published/local artifact path, run `--help`, `doctor`, the bounded demo, and teardown. Do not request a provider secret before the step that needs one.

- [ ] **Step 2: Fail closed on unpublished or workspace-only packages**

If the fresh install requires `workspace:*` packages or a repository checkout, record G2 `NOT_READY`; do not claim a package release based on an in-repo build.

- [ ] **Step 3: Add the bounded pilot quickstart**

Document the exact dedicated deployment path, tenant identity, connector registration, approval, receipt verification, kill switch, and teardown. Explicitly state that `/api/workflows/:id/execute` is preview-only and consequential actions use `/v1/actions`/MCP.

### Task 4: Execute G3 durable-authority and G4 recovery gates

**Files:** No source changes unless a proof identifies a correctness defect; retain sanitized logs and reports under `g3`/`g4`.

- [ ] **Step 1: Run authority and P0 proofs**

Run `pnpm proof:authority` and `pnpm p0:full-loop` against the provisioned Postgres roles. Run `pnpm proof:action-operations -- --provider github --fault-campaign full --output "$EVIDENCE_ROOT/g3/action-operations"` only with a real, allowlisted sandbox destination and separate `commander_app`, `commander_adapter_ops`, and `commander_owner` DSNs.

- [ ] **Step 2: Run signer rotation and independent DR**

Run `pnpm rotate:verify` and `DATABASE_URL=... RST_DATABASE_URL=... pnpm dr:verify --full`. Require `verified=4/4`, independent restore, preserved receipts/anchors/identity accounting, and revoked-signer rejection.

- [ ] **Step 3: Produce G3/G4 verdicts**

Use existing proof schemas and `deriveTechnicalVerdict`; mark `NOT_READY` if a real process identity, independent restore target, signer, or external system is absent. Never substitute unit, in-memory, or simulated artifacts.

### Task 5: Execute G5 governed Kubernetes rollback gate

**Files:** Modify `package.json` and create a wrapper/aggregator only if the existing Kind driver cannot produce the runbook’s aggregate command; add focused tests for argument parsing, repetition accounting, artifact sanitization, and exact write thresholds.

- [ ] **Step 1: Run the single real Kind proof**

Run `pnpm exec tsx scripts/kubernetes-rollback-kind.ts --mode kind --jwks "$EVIDENCE_ROOT/g5/jwks.json"` with a real Kind API and Commander Gateway. Require one remote write, zero reconciliation writes, query-first recovery, compensation, escalation of irreducible unknown, and independently verified receipt.

- [ ] **Step 2: Run the existing cell proofs**

Run `pnpm cell:smoke -- --mode compose --controlled-change-proof <artifact>` and `pnpm cell:compensation-e2e -- --mode compose --up --controlled-change-proof <artifact>`; retain outputs without relabeling Compose fixtures as live Kind evidence.

- [ ] **Step 3: Run the aggregate benchmark**

If implemented, run `pnpm benchmark:governed-rollback -- --environment kind --repetitions 100 --output "$EVIDENCE_ROOT/g5/governed-rollback"`. Require all 15 scenarios, three fresh environment rebuilds, exact zero-duplicate/zero-denied-write thresholds, and raw metrics plus receipt verification. If the command or required environment is absent, G5 remains `NOT_READY`.

### Task 6: Execute G6 security-floor gate

**Files:** No source changes unless a scoped P0/P1 defect is reproducibly demonstrated; retain sanitized reports under `g6`.

- [ ] **Step 1: Run security and boundary checks**

Run `pnpm claim:gate`, `pnpm audit:wiring`, `pnpm arch:guard`, dependency audit, fake-Kubernetes boundary scans, and the required tenant/sandbox boot-refuse checks.

- [ ] **Step 2: Verify secret and evidence hygiene**

Scan retained artifacts and logs for keys, DSNs, bearer tokens, private keys, prompts, raw payloads, and customer data. Any match fails G6 and G8.

- [ ] **Step 3: Confirm dedicated-pilot limits**

Require production startup fail-closed, allowlisted egress, digest-bound policy/approval/destination/arguments, no effect bypass, and no shared multi-tenant claim.

### Task 7: Complete G7 usability and workflow-integration acceptance

**Files:** Create `docs/enterprise/quickstart.md`, `docs/enterprise/workflow-template-kubernetes-rollback.md`, `docs/enterprise/support-runbook.md`, and `artifacts/enterprise-acceptance/g7/usability-record.json`; modify root README/docs index to link them.

- [ ] **Step 1: Write the customer-facing path**

Provide one bounded workflow template with inputs, approval owner, connector destination, retries, unknown handling, receipt verification, kill switch, teardown, and a mapping table from an existing SRE workflow to Commander MCP/`/v1/actions`.

- [ ] **Step 2: Run an independent-reader test**

Use a technically competent reader who did not build the workflow. They must complete install, propose, approve, observe recovery, verify the signed receipt, trigger the kill switch, and tear down using only public docs. Record start/end times, exact commands, blockers, and sanitized screenshots/log hashes; a blocker makes G7 `NOT_READY` until the docs or product path is fixed.

- [ ] **Step 3: Keep field proof separate**

Do not write `FIELD-PROVEN` or customer acceptance without a real partner’s signed acceptance artifact. An internal reader proves usability only, not adoption.

### Task 8: Build and verify G8 immutable release bundle

**Files:** Create `scripts/launch-verify.ts` and `scripts/launch-verify.test.ts` only if no existing verifier covers the required bundle; add `launch:verify` to `package.json`; create bundle manifest under the run-scoped evidence directory.

- [ ] **Step 1: Validate bundle inputs**

Require G1-G7 verdict files, source/lockfile/image hashes, CI links, raw metrics, signed receipt samples, independent verification output, threat/security reports, claim registry, SBOM/dependency/license reports, and G7 usability notes.

- [ ] **Step 2: Verify schemas, hashes, and claim ceiling**

Reject missing files, hash mismatches, simulated evidence in required slots, dirty-source attestations, undocumented limitations, secrets, and any `PROVEN`/production claim without the corresponding gate.

- [ ] **Step 3: Produce final verdict**

Write an immutable manifest with commit, lockfile hash, artifact hashes, gate verdicts, evidence levels, and limitations. `PROVEN` requires all G1-G8 technical gates; `FIELD-PROVEN` requires the separate signed customer acceptance artifact.

### Task 9: Final verification and handoff

- [ ] **Step 1: Run focused tests for every changed script/doc contract**

Run the relevant Node tests, `pnpm format:check`, `git diff --check`, and all gate commands whose prerequisites are available.

- [ ] **Step 2: Review evidence for honesty**

Confirm no artifact claims customer adoption, official OpenAI validation, production SaaS readiness, or fake Kubernetes as live external evidence.

- [ ] **Step 3: Report remaining external blockers**

If any gate is `NOT_READY`, report the exact missing external prerequisite and the command that will complete it. Do not mark the overall acceptance complete.
