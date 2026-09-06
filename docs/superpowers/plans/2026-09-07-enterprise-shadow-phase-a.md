# Enterprise Shadow Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver customer-cloud historical rollback policy evaluation with strict batch manifests, PostgreSQL-authoritative evidence, signed reports, deletion, and no effect-producing dependency.

**Architecture:** Extract the existing deterministic Action Gateway decision into `@commander/contracts`, then build `@commander/shadow-plane` as a separate CLI/runtime package that depends only on contracts, the verified PostgreSQL pool, `pg`, and one RFC 8785 canonicalizer. A signed manifest defines the complete sample before import; PostgreSQL owns campaign state and results; exported bundles are independently verified with a separately supplied public key.

**Tech Stack:** TypeScript, Node.js 22, node:test, PostgreSQL 16, node:crypto Ed25519, `@commander/contracts`, `@commander/postgres-runtime`, pnpm.

## Global Constraints

- Phase A supports only `kubernetes.deployment.rollback` historical policy evaluation.
- No HTTP listener, Helm deployment, provider/model call, Kubernetes client, EffectBroker, worker runtime, action adapter, tool execution, Redis, SQLite, JSON persistence, or local persistence fallback.
- PostgreSQL is the only authoritative store. Runtime roles are non-owner and limited to the dedicated Shadow schema.
- The only filesystem write is an explicit atomic `0600` report export selected by the operator.
- Preserve `allow`, `deny`, and `require_approval`; missing decision facts yield `insufficient_evidence` and are uncomparable.
- Records are at most 16 KiB; identifiers are 1-128 ASCII characters; a manifest contains 1-10,000 observations.
- Use RFC 8785 canonical JSON and SHA-256. Use Ed25519 signatures with an externally supplied trusted public key.
- A registered manifest fixes every expected index and digest. Closed reports cannot change.
- No local Docker, Kind, or PostgreSQL. Real database behavior runs only in the approved CI environment.
- Remove the unsafe legacy transparent Shadow proxy; do not keep a compatibility path or migrate its local files.
- Never label Phase A evidence `PROVEN`, live, production-ready, or customer-accepted.

---

### Task 1: Extract The Shared Action Gateway Policy

**Files:**
- Create: `packages/contracts/src/actionGatewayPolicy.ts`
- Create: `packages/contracts/src/actionGatewayPolicy.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`
- Modify: `apps/api/src/actionGatewayEndpoints.ts`
- Modify: `packages/worker-plane/src/bootstrap.ts`
- Test: `apps/api/test/actionGatewayEndpoints.test.ts`
- Test: `packages/worker-plane/src/actionGatewayPolicy.test.ts`
- Test: `packages/worker-plane/src/bootstrap.policy.test.ts`

**Interfaces:**
- Produce `ACTION_GATEWAY_POLICY_ID = 'action-gateway-mvp-v1'`.
- Produce `ActionGatewayPolicyInput { effectType: string; tool: string; destination: string }`.
- Produce `ActionGatewayPolicyDecision { effect: ActionGatewayEffect; decisionId: string; reasonCode: string; reason: string; policySnapshotId: typeof ACTION_GATEWAY_POLICY_ID }`.
- Produce `evaluateActionGatewayPolicy(input): ActionGatewayPolicyDecision` using only descriptors already in contracts.
- Produce `actionGatewayPolicySnapshot(): { policyId; version; descriptorDigest; descriptors }`. Build a fixed-key projection of every descriptor in manifest order, serialize it with `JSON.stringify`, and SHA-256 those UTF-8 bytes. The projection and order are part of the v1 test contract; do not hash arbitrary caller objects or add the Phase A canonicalizer in this task.

- [ ] **Step 1: Add characterization tests before moving code**

Test registered Kubernetes rollback and compensation destinations, all three demo decisions, malformed/unregistered destinations, and stable IDs/reason codes. Add API/worker parity assertions around their public or test-exported policy call sites.

- [ ] **Step 2: Run tests and confirm RED**

Run `pnpm --filter @commander/contracts test`, `pnpm --filter @commander/api exec node --import tsx --test test/actionGatewayEndpoints.test.ts`, and `pnpm --filter @commander/worker-plane exec node --import tsx --test src/actionGatewayPolicy.test.ts src/bootstrap.policy.test.ts`. Confirm failure is caused by missing shared exports.

- [ ] **Step 3: Implement the pure policy**

Move the existing decision rules into contracts. API and worker call the shared function. Remove duplicate policy decision code; do not change execution, approval, adapter, or persistence behavior.

- [ ] **Step 4: Verify GREEN and build callers**

Run contracts tests, focused API/worker tests, `pnpm --filter @commander/contracts build`, `pnpm --filter @commander/api typecheck`, and `pnpm --filter @commander/worker-plane typecheck`.

- [ ] **Step 5: Commit**

Commit as `refactor(policy): share deterministic gateway decision`.

---

### Task 2: Define Strict Shadow Contracts And Comparison

**Files:**
- Create: `packages/shadow-plane/package.json`
- Create: `packages/shadow-plane/tsconfig.json`
- Create: `packages/shadow-plane/src/contracts.ts`
- Create: `packages/shadow-plane/src/canonical.ts`
- Create: `packages/shadow-plane/src/evaluator.ts`
- Create: `packages/shadow-plane/src/comparison.ts`
- Create: `packages/shadow-plane/src/index.ts`
- Create: `packages/shadow-plane/src/contracts.test.ts`
- Create: `packages/shadow-plane/src/evaluator.test.ts`
- Create: `packages/shadow-plane/src/comparison.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- `ShadowManifestV1`: schema, campaignId, tenantId, producerId, policyId, policyDigest, batchId, closesAt, records `{ index, observationId, digest }[]`, keyId, signature.
- `ShadowObservationV1`: schema, campaign/tenant/producer/batch identity, index, observationId, occurredAt, workflow, effectType, tool, destination, productionDecision, optional enumerated productionReasonCode.
- `parseShadowManifest`, `parseShadowObservation`: exact-key validators returning typed canonical values or stable `SHADOW_*` error codes.
- `canonicalBytes`, `sha256Hex`, `verifyEd25519`: RFC 8785 bytes, lowercase digest, and base64url signature verification.
- `evaluateShadowObservation`: enforce rollback-only input and pinned policy, then map shared policy output or incomplete facts to a hypothetical result.
- `compareShadowDecision`: return `match | mismatch | uncomparable`, never treating unknown/insufficient evidence as compared.

- [ ] **Step 1: Select the canonicalizer**

Confirm no existing RFC 8785 package is installed. Add one mature, dependency-light canonicalizer after checking its exports and production audit. Record its exact version in the lockfile.

- [ ] **Step 2: Write failing contract tests**

Cover exact keys, limits, ASCII identifiers, unique contiguous manifest indexes, supported workflow, decision enums, timestamps, digest shape, 16 KiB observation size, 2 MiB manifest size, 10,000-record bound, and prohibited free-form fields.

- [ ] **Step 3: Write failing crypto/evaluator/comparison tests**

Generate ephemeral Ed25519 keys in tests. Verify valid/tampered/wrong-key cases, manifest signature excluding its signature field, record digest matching, rollback `require_approval`, malformed destination denial, missing facts, unknown decisions, and exact comparison matrix.

- [ ] **Step 4: Implement the minimum pure modules**

Do not accept arbitrary objects after parsing. Do not add runtime configuration or persistence here.

- [ ] **Step 5: Verify and commit**

Run package tests, typecheck, build, production dependency audit, and `git diff --check`. Commit as `feat(shadow): define historical evaluation contracts`.

---

### Task 3: Add PostgreSQL-Authoritative Campaign Storage

**Files:**
- Create: `packages/shadow-plane/src/schema.ts`
- Create: `packages/shadow-plane/src/repository.ts`
- Create: `packages/shadow-plane/src/repository.test.ts`
- Create: `packages/shadow-plane/src/repository.live.test.ts`
- Create: `packages/shadow-plane/src/startupConfig.ts`
- Create: `packages/shadow-plane/src/startupConfig.test.ts`
- Modify: `packages/shadow-plane/src/index.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- `ShadowStartupConfig`: verified DSN, fixed tenant, 1-30 retention days, trusted manifest public keys, report signing key ID/private key, cleanup freshness.
- `ShadowRepository`: register manifest, import observation, close due batch, read report, withdraw campaign, run retention, readiness.
- Every mutation takes explicit `tenantId` and runs in a database transaction.
- `registerManifest` verifies signature/policy/digest before transaction.
- `importObservation` atomically enforces campaign state, expected digest, uniqueness, idempotent retry, and conflict behavior.

- [ ] **Step 1: Write failing startup tests**

Require all credentials/configuration, reject public placeholders, invalid retention, unknown policy keys, and any DSN that the verified pool rejects. No generated credential fallback.

- [ ] **Step 2: Write failing repository contract tests**

Use a recording query client for SQL shape and transaction ordering only: tenant predicates on every query, row lock before admission/withdrawal, no alternate store, no swallowed database failures.

- [ ] **Step 3: Write live PostgreSQL tests for CI**

Provision a dedicated schema and separate installer, ingestion, reader, and retention roles. Prove runtime DDL/other-schema/role-management denial, restart persistence, identical retry, conflict, entirely missing registered batch, closure, late arrival rejection, count reconciliation, retention, and concurrent withdrawal/import serialization.

- [ ] **Step 4: Implement schema, repository and readiness**

Use explicit SQL migrations owned by the installer role. Runtime startup verifies the installed schema version and privileges; it never migrates.

- [ ] **Step 5: Wire the approved CI service**

Use the repository's existing PostgreSQL CI pattern. Do not create a local database path or downgrade live test failures to skips when CI credentials are present.

- [ ] **Step 6: Verify and commit**

Run unit tests/typecheck/build locally and the workflow static validator. Commit as `feat(shadow): persist campaigns in PostgreSQL`.

---

### Task 4: Deliver Phase A CLI And Signed Evidence

**Files:**
- Create: `packages/shadow-plane/src/cli.ts`
- Create: `packages/shadow-plane/src/report.ts`
- Create: `packages/shadow-plane/src/report.test.ts`
- Create: `packages/shadow-plane/src/cli.test.ts`
- Create: `packages/shadow-plane/src/atomicExport.ts`
- Create: `packages/shadow-plane/src/atomicExport.test.ts`
- Modify: `packages/shadow-plane/package.json`
- Modify: `packages/shadow-plane/src/index.ts`

**Interfaces:**
- Binary: `commander-shadow`.
- Commands: `manifest register --file`, `import --file`, `batch close --campaign --batch`, `report export --campaign --output`, `report verify --bundle --public-key`, `campaign withdraw --campaign --confirm`, `retention run`, `status`.
- JSON output has stable code/status fields; secrets and DSNs never appear.
- Export bundle includes manifest, policy snapshot, sanitized facts, terminal statuses, decisions, aggregate counts, evaluator/source versions, hashes, and a detached Ed25519 bundle signature.

- [ ] **Step 1: Write failing report tests**

Cover the 100-record example denominator, all terminal states, three-decision matrix, mismatch detail, omitted cost, no `PROVEN` claim, hash/signature verification, tamper, wrong/revoked key, and deterministic re-evaluation.

- [ ] **Step 2: Write failing CLI tests**

Invoke the real command handler with temporary files and repository fakes. Cover every command, nonzero failure, confirmation requirement, bounded NDJSON line reading, partial import reporting, and sanitized errors.

- [ ] **Step 3: Implement atomic export and evidence**

Write to a sibling temporary file with mode `0600`, fsync file, rename, and fsync parent directory. Refuse symlink targets and non-directory parents.

- [ ] **Step 4: Implement CLI**

Use the verified PostgreSQL configuration and repository only. No hidden file database or implicit campaign creation.

- [ ] **Step 5: Verify and commit**

Run package tests/typecheck/build and pack/import the tarball in a temporary directory. Commit as `feat(shadow): add historical evaluation CLI`.

---

### Task 5: Remove Unsafe Legacy Shadow Replay

**Files:**
- Delete: `packages/core/src/shadow/proxy.ts`
- Delete: `packages/core/src/shadow/runner.ts`
- Delete or replace legacy-only tests under `packages/core/tests/shadow/`
- Modify: `packages/core/src/shadow/index.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/cli/commands/shadow.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `docs/runbooks/shadow.md`
- Modify: any callers discovered with `rg` that exist only for transparent replay

**Interfaces:**
- No transparent replay middleware or runner remains exported or registered.
- `docs/runbooks/shadow.md` points to Phase A customer documentation and clearly marks Phase B unavailable until its own runtime gate.
- Pure scrubber utilities may remain only if still used by security/smoke tests; unused config/drift file types are removed.

- [ ] **Step 1: Add architecture regressions**

Test that API startup has no Shadow middleware, core exports no runner/proxy, the old environment toggle has no runtime caller, and `@commander/shadow-plane` production dependencies exclude forbidden packages.

- [ ] **Step 2: Run RED against current replay code**

Confirm architecture tests fail on the current imports/exports/registration.

- [ ] **Step 3: Remove the obsolete path and update docs**

Remove dead code fully. Do not add deprecation wrappers or migration behavior.

- [ ] **Step 4: Verify and commit**

Run focused core/API tests, builds, architecture guard, and `rg` for old toggle/runner/proxy. Commit as `refactor(shadow): remove transparent request replay`.

---

### Task 6: Publish The Phase A Customer Delivery Pack

**Files:**
- Create: `docs/pilot/shadow/README.md`
- Create: `docs/pilot/shadow/invitation.md`
- Create: `docs/pilot/shadow/pilot-charter.md`
- Create: `docs/pilot/shadow/data-boundary.md`
- Create: `docs/pilot/shadow/historical-evaluation.md`
- Create: `docs/pilot/shadow/example-report.json`
- Create: `docs/pilot/shadow/security-architecture.md`
- Create: `docs/pilot/shadow/retention-withdrawal-teardown.md`
- Create: `scripts/shadow-customer-pack.test.ts`
- Modify: `PRIVACY.md`
- Modify: `docs/runbooks/design-partner-launch-readiness.md`

**Interfaces:**
- Materials describe customer-cloud historical policy evaluation only.
- Example fields exactly match Task 2 schemas and example report exactly matches Task 4 output.
- Charter requires named owners, policy digest, declared sample, observation window, retention, deletion/export owners, usefulness criteria, customer mismatch adjudication, and stop conditions.
- Legal/DPA review remains external and explicit.

- [ ] **Step 1: Write failing documentation contract test**

Parse example JSON with real contract/report parsers; assert required limitations, no unsupported claims, all data fields documented, all commands exist, and contact requires no credentials.

- [ ] **Step 2: Write the customer materials**

Use copy that a platform/SRE lead can send to security and operate without private instructions. Include the exact 100-record report example and explain what signatures do and do not prove.

- [ ] **Step 3: Verify and commit**

Run `pnpm exec node --import tsx --test scripts/shadow-customer-pack.test.ts`, `pnpm exec prettier --check docs/pilot/shadow PRIVACY.md docs/runbooks/design-partner-launch-readiness.md`, and `git diff --check`. Commit as `docs(shadow): add historical pilot delivery pack`.

---

### Task 7: Integrated Phase A Release Gate

**Files:**
- Create: `scripts/shadow-phase-a-gate.ts`
- Create: `scripts/shadow-phase-a-gate.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Root command `pnpm shadow:phase-a:gate` runs contracts, architecture, package, docs, evidence, and PostgreSQL live checks in the approved environment.
- The gate emits only a pass/fail summary with source revision and test counts; it never creates `PROVEN` evidence.

- [ ] **Step 1: Write failing gate-contract tests**

Require every Phase A suite, PostgreSQL live environment, clean package build, tarball import, and customer-pack validation. Missing database configuration is a hard failure in CI and an explicit prerequisite error locally.

- [ ] **Step 2: Implement the orchestrator**

Invoke existing package scripts as child processes with bounded output and stable error codes. Do not duplicate test logic in the orchestrator.

- [ ] **Step 3: Run local non-database checks**

Run all safe local portions and confirm the database prerequisite fails explicitly rather than skipping.

- [ ] **Step 4: Push once for natural CI**

Verify exact remote parent, use normal hooks and a non-force push. Do not inspect raw CI logs. If the scoped job fails, use only its sanitized artifact/status evidence for the smallest repair.

- [ ] **Step 5: Independent final review**

Review the full branch for spec compliance, security, dependency isolation, customer claims, and test evidence. Fix every Critical/Important finding and rerun affected gates before merge consideration.
