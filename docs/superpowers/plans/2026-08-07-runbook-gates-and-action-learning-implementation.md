# Runbook Gates and Action Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the A-E and G1-G8 runbooks, unblock E0 discovery without weakening E1 technical gates, and add a validated opt-in action-learning record that cannot contain raw customer data.

**Architecture:** The A-E runbook remains the internal authority; the G runbook becomes a technical readiness checklist. A pure contracts module defines and validates `ActionLearningRecordV1`; it is not persisted or exported unless the tenant has explicit training consent and the record is within retention and deletion policy.

**Tech Stack:** Markdown, TypeScript, Node test runner, existing `@commander/contracts` package, pnpm workspace.

## Global Constraints

- Do not add a second action, approval, policy, evidence, or audit authority.
- Do not collect prompts, raw arguments, full responses, credentials, tokens, PII, customer content, or internal URLs in learning records.
- Operational telemetry and model-training consent remain separate controls.
- E0 contact and shadow never receive production write credentials and cannot claim `PROVEN` or `FIELD-PROVEN`.
- E1 writes require the selected action to be `PROVEN`, applicable A-D gates, commercial commitment, scoped credentials, and customer acceptance controls.
- Preserve all unrelated dirty-worktree changes and the user's staged deletions.

## File Map

- Modify `.internal/docs/plans/2026-07-30-abcde-execution-runbook.md`: make authority relationship and E0/E1 gates explicit.
- Modify `.internal/customer-discovery/e-launch-gated-research.md`: remove the implicit no-contact-before-public-launch rule and define E0 contact/shadow.
- Modify `docs/runbooks/design-partner-launch-readiness.md`: reframe G1-G8 as E1/technical readiness and remove recruitment blocking language.
- Modify `PRIVACY.md`: make training consent explicit and correct the current contradictory evaluation wording.
- Create `packages/contracts/src/actionLearning.ts`: types, forbidden-field scan, record validation, and exportability predicate.
- Modify `packages/contracts/src/index.ts`: export the action-learning types and helpers.
- Create `packages/contracts/src/actionLearning.test.ts`: red/green tests for schema, forbidden fields, consent, retention, withdrawal, and deletion.
- Create `scripts/runbook-gate-consistency.test.ts`: static regression checks for E0/G1-G8 wording and planned benchmark labeling.

### Task 1: Add failing action-learning contract tests

**Files:** Create `packages/contracts/src/actionLearning.test.ts`.

**Interfaces:** Tests will target `validateActionLearningRecordV1(input: unknown)` and `isActionLearningRecordExportable(record, now)` from `actionLearning.ts`.

- [ ] **Step 1: Write a valid fixture and acceptance tests**

```ts
const validRecord = {
  schemaVersion: 'commander.action-learning/v1',
  recordId: 'record-1',
  createdAt: '2026-08-07T00:00:00.000Z',
  actionClass: 'kubernetes.deployment.rollback',
  sourceRuntime: 'openai-agents-mcp',
  modelFamily: 'gpt-5',
  toolClass: 'kubernetes.rollback',
  resourceScopeClass: 'deployment.namespace',
  policyOutcome: 'allow',
  approvalOutcome: 'approved',
  actionDigest: 'sha256:action',
  policySnapshotId: 'policy-1',
  contractVersion: 'l3-11.v0',
  remoteOutcome: 'applied',
  reconciliationPath: 'none',
  retryCount: 0,
  compensationCount: 0,
  operatorInterventionMinutes: 0,
  recoveryLatencyMs: 1200,
  evidenceVerified: true,
  consent: {
    tenantScopeHash: 'sha256:tenant',
    consentId: 'consent-1',
    purpose: 'model-training',
    trainingOptIn: true,
    grantedAt: '2026-08-07T00:00:00.000Z',
    retentionExpiresAt: '2026-09-07T00:00:00.000Z',
  },
  deletionStatus: 'active',
};
```

Assert the fixture validates and is exportable at `2026-08-08T00:00:00.000Z`.

- [ ] **Step 2: Add failing rejection tests**

Assert validation rejects each of `prompt`, `args`, `rawResponse`, `credential`, `token`, `pii`, `customerPayload`, and `internalUrl` anywhere in the input; rejects missing consent; rejects `trainingOptIn: false`; rejects invalid outcome or negative counters.

- [ ] **Step 3: Add failing lifecycle tests**

Assert exportability is false when consent is withdrawn, retention has expired, deletion status is `deletion_requested` or `deleted`, or the record has `evidenceVerified: false`.

- [ ] **Step 4: Run the focused test and verify RED**

Run: `pnpm exec node --import tsx --test packages/contracts/src/actionLearning.test.ts`

Expected: FAIL because the module and exports do not exist.

### Task 2: Implement and export the pure action-learning contract

**Files:** Create `packages/contracts/src/actionLearning.ts`; modify `packages/contracts/src/index.ts`.

**Interfaces:**

```ts
export type ActionLearningRemoteOutcomeV1 = 'applied' | 'not_applied' | 'unknown' | 'escalated';
export type ActionLearningReconciliationPathV1 = 'none' | 'query' | 'compensation' | 'human_escalation';
export type ActionLearningPolicyOutcomeV1 = 'allow' | 'deny' | 'require_approval';
export type ActionLearningApprovalOutcomeV1 = 'not_required' | 'approved' | 'rejected' | 'expired';
export type ActionLearningDeletionStatusV1 = 'active' | 'deletion_requested' | 'deleted';
export interface ActionLearningConsentV1 {
  tenantScopeHash: string;
  consentId: string;
  purpose: 'model-training';
  trainingOptIn: true;
  grantedAt: string;
  retentionExpiresAt: string;
  withdrawnAt?: string;
}
export interface ActionLearningRecordV1 {
  schemaVersion: 'commander.action-learning/v1';
  recordId: string;
  createdAt: string;
  actionClass: string;
  sourceRuntime: string;
  modelFamily: string;
  toolClass: string;
  resourceScopeClass: string;
  policyOutcome: ActionLearningPolicyOutcomeV1;
  approvalOutcome: ActionLearningApprovalOutcomeV1;
  actionDigest: string;
  policySnapshotId: string;
  contractVersion: string;
  remoteOutcome: ActionLearningRemoteOutcomeV1;
  reconciliationPath: ActionLearningReconciliationPathV1;
  retryCount: number;
  compensationCount: number;
  operatorInterventionMinutes: number;
  recoveryLatencyMs: number;
  evidenceVerified: boolean;
  consent: ActionLearningConsentV1;
  deletionStatus: ActionLearningDeletionStatusV1;
}
export function validateActionLearningRecordV1(input: unknown): ActionLearningRecordV1;
export function isActionLearningRecordExportable(record: ActionLearningRecordV1, now?: Date): boolean;
```

- [ ] **Step 1: Implement exact runtime validation**

Validate object shape, ISO timestamps, non-empty bounded strings, enum values, non-negative finite counters, and the required consent object. Return a typed copy only after validation; throw stable `ACTION_LEARNING_INVALID_RECORD` errors with field paths.

- [ ] **Step 2: Implement recursive forbidden-field rejection**

Walk unknown objects and arrays before shape validation. Normalize keys to lowercase and reject prompt, args/arguments, response, raw response, credential, token, secret, PII, customer data/payload, and internal URL key variants. Do not inspect or retain values from rejected fields.

- [ ] **Step 3: Implement exportability**

Require explicit `purpose: 'model-training'`, `trainingOptIn: true`, active deletion status, no withdrawal, unexpired retention, and verified evidence. Use the supplied `now` for deterministic tests.

- [ ] **Step 4: Export the contract from `packages/contracts/src/index.ts`**

Export all public types and both helpers from the package root without importing runtime code.

- [ ] **Step 5: Run focused tests and package typecheck**

Run: `pnpm exec node --import tsx --test packages/contracts/src/actionLearning.test.ts && pnpm --filter @commander/contracts typecheck`

Expected: PASS.

### Task 3: Correct runbook and privacy boundaries

**Files:** Modify `.internal/docs/plans/2026-07-30-abcde-execution-runbook.md`, `.internal/customer-discovery/e-launch-gated-research.md`, `docs/runbooks/design-partner-launch-readiness.md`, and `PRIVACY.md`.

- [ ] **Step 1: Make A-E the internal authority**

Add a direct reference to the G checklist and state that G1-G8 are not E0 contact gates. Preserve the existing A-E ownership, evidence, and stop-condition rules.

- [ ] **Step 2: Split customer gates**

Replace any “no contact before public launch” wording with E0-CONTACT and E0-SHADOW rules: interviews and public incident follow-up may start immediately; shadow is read-only and minimized; neither requests production credentials or claims product proof. Keep E1 blocked on technical and commercial gates.

- [ ] **Step 3: Reframe the G checklist**

Change its introduction and execution sequence so G1-G8 govern E1/technical promotion and not first contact. Keep the exact technical thresholds. Mark `benchmark:governed-rollback` as planned until the executable command exists.

- [ ] **Step 4: Correct privacy consent**

State that evaluation does not imply training consent, that training export requires explicit tenant opt-in, and that withdrawal, retention expiry, deletion, and external-provider copies have separate handling. Preserve the no-telemetry-by-default statement.

### Task 4: Add static runbook consistency regression tests

**Files:** Create `scripts/runbook-gate-consistency.test.ts`.

- [ ] **Step 1: Assert the authoritative wording**

Read the three runbook files and assert A-E contains “E0 starts immediately”, the G checklist contains “does not block E0” and “E1”, and the customer-discovery document contains E0-CONTACT/E0-SHADOW language.

- [ ] **Step 2: Assert privacy boundaries**

Read `PRIVACY.md` and assert it contains explicit opt-in, no implied consent, withdrawal, and deletion language.

- [ ] **Step 3: Assert planned benchmark honesty**

Assert the G checklist continues to label `benchmark:governed-rollback` as planned until a command is added; fail if it presents that command as implemented.

- [ ] **Step 4: Run the static test**

Run: `pnpm exec node --import tsx --test scripts/runbook-gate-consistency.test.ts`

Expected: PASS.

### Task 5: Full verification and handoff

- [ ] **Step 1: Run contracts tests**

Run: `pnpm --filter @commander/contracts test`

- [ ] **Step 2: Run architecture and claim checks**

Run: `pnpm arch:guard && pnpm claim:gate`

- [ ] **Step 3: Run formatting and diff checks**

Run: `pnpm exec prettier --check packages/contracts/src/actionLearning.ts packages/contracts/src/actionLearning.test.ts packages/contracts/src/index.ts scripts/runbook-gate-consistency.test.ts && git diff --check`

- [ ] **Step 4: Review final evidence level**

Report that the contract is `EXISTS`/`ENFORCED` through tests only; no customer data collection, training export, `PROVEN`, or `FIELD-PROVEN` claim is created by this change.
