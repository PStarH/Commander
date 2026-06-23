# Commander — API Key Rotation Cadence & Runbook

> **Effective:** 2026-06-21 · **Owners:** CISO (sign-off) + Head of Security (operational) · **Audit linkage:** D2.5 (plaintext CI gate) + D2.6 (GPG-bound sign-off verifier) + D2.7 (≥1 verified row policy tightening) + D2.8 (incremental bump to ≥2) + D2.9 (full 4-role gate, ≥4, see `POLICY_VERSION` + bump-history in `scripts/verify-rotation-signoff.ts`)

This document establishes:

1. **Default rotation cadence** for every secret referenced via `process.env.X` indirection across Commander.
2. **Emergency rotation runbook** when a key is suspected or known to be compromised.
3. **CI gate** that prevents plaintext keys from being committed.
4. **GPG-bound sign-off** that cryptographically binds the effective date of every sign-off to a verifiable commit SHA.

Companion code:
- `packages/core/tests/security/d25-api-key-grep.test.ts` — vitest CI gate (zero plaintext API-key prefix hits across `apps/api/src` and `apps/web/src`).
- `scripts/verify-rotation-signoff.ts` + `packages/core/tests/security/d26-rotation-signoff-gate.test.ts` — vitest gate that parses §6 table rows, runs `git verify-commit <sha>` for every non-empty Signed-Commit SHA, and extracts `signed_at = git log -1 --format=%aI <sha>` for each verified row. The effective date is NEVER free-form text; it is derived from a cryptographic binding.
- `packages/core/src/security/auditChainLedger.ts::resolveMasterKey` (`COMMANDER_AUDIT_CHAIN_KEY`) — hard-fails in `NODE_ENV=production` if env-var unset, ≥32 chars, or short.
- `packages/core/src/security/capabilityToken.ts::resolveMasterKey` (`COMMANDER_CAPABILITY_TOKEN_KEY`) — same fail-fast contract.
- `packages/core/src/security/federatedIdentity.ts::resolveFederationKey` (`COMMANDER_FEDERATION_KEY`) — same.

---

## §1 — Scope

Every secret referenced via `process.env.X` indirection in Commander source. Categorised below by rotation cadence.

| Included                                                       | Excluded                                                                                  |
|----------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| LLM provider keys (OpenAI, Anthropic, Google, DeepSeek, etc.)  | Anonymous usage telemetry (no auth required)                                              |
| Cloud provider keys (AWS, GCP, Azure)                          | Public endpoint URLs (no auth required)                                                  |
| SaaS API tokens (GitHub, Slack, Notion, Linear)                | Local model checkpoints (not secret)                                                      |
| Federated identity HMAC + OIDC JWT keys                        | Tests + demo data (intentionally synthetic)                                               |
| HMAC master keys (audit-chain, capability-token, federation)   | Documentation-site secrets (rotated by the doc host, not us)                              |

---

## §2 — Default Rotation Cadence

| Secret class                                  | Standard cadence | Driver / justification                                  |
|-----------------------------------------------|------------------|---------------------------------------------------------|
| **Production LLM provider keys**              | every **90 d**   | Bounds leak-window exposure; aligns to SOC 2 CC6.1     |
| **Production cloud / SaaS tokens**            | every **90 d**   | Same-handle coverage as production LLM keys             |
| **Federated identity HMAC keys**              | every **180 d**  | Cross-org coordination overhead for the rotation party |
| **Federated identity OIDC private keys**      | every **180 d**  | Same as HMAC; coordinated with HMAC rotation           |
| **Capability-token HMAC master**              | every **90 d**   | Same-handle as consumer credentials                    |
| **Audit-chain HMAC master**                   | every **365 d**  | Long history retention (signing key continuity)        |
| **Ephemeral / dev-only secrets**              | every **30 d**   | Common rotation window for short-lived credentials     |
| **Demo / staging credentials**                | every **30 d**   | Same as ephemeral; do not reuse across environments    |

**Operator rules**
- Schedule the rotation in the calendar BEFORE the deadline hits. A "missed by 5 days" rotation still counts as a security incident.
- Use the `commander-rotate <env-var-name> --audit` CLI (to be implemented) for atomic rotate + audit-linked confirmation.
- Never rotate during a freeze window (Black Friday, end-of-quarter, etc.) unless emergency rotation is required (§3).

---

## §3 — Emergency Rotation Runbook

Triggers (any one fires the runbook):
1. HackerOne report of a leak or suspected leak.
2. Postmortem-filed incident where a key was exposed.
3. CISO direct instruction (e.g., upstream provider compromised).
4. CI gate `tests/security/d25-api-key-grep.test.ts` detects plaintext in a committed file.
5. Provider-initiated disclosure (e.g., GitHub rotated a token due to upstream incident).

Runbook (5 steps):

1. **Stop the bleed** — revoke the live key in the upstream provider's console within **4 hours** of confirmed compromise. Latency target applies to *revoke*-not-*rotate*.
2. **Generate replacement** — produce a fresh key in the provider's UI/API. Document the generation timestamp.
3. **Deploy rotation** — update production env-var store (Vault / AWS Secrets Manager / GitHub Actions secret). Deploy to all environments simultaneously to prevent drift.
4. **Verify** — run `pnpm benchmark:verify` (week-2 hardening) and spot-check a representative fleet run using the new key.
5. **Audit + notify** — append a dated section to this file (or its successor) with: incident ID, rotation timestamp, revocation confirmation timestamp, downstream-key-cascade (e.g., audit-chain-key also rotated because it absorbed the old env-var). Ping Head of Security + CISO within **24 hours**.

Recovery is not complete until the on-call can answer: "Which tickets / consumers / chains used the old key, and did any of them accept traffic between compromise-confirmation and rotate-deploy?" — typically answered via the supply-chain attestor's generated `SpdxDocument` (CTL-010).

### §3.1 — Incident log

| Date       | Incident ID | Secret           | Trigger                | Status     | Notes |
|------------|-------------|------------------|------------------------|------------|-------|
| 2026-06-23 | CMDR-2026-0623-001 | STEPFUN_API_KEY | External security audit | **ROTATE** | Key was present in committed `.env`. Key removed from working tree; `.env` is gitignored. Full history scrub with `git filter-branch` / BFG still required. Rotate the key in StepFun console before any release. |

---

## §4 — CI Gate

`packages/core/tests/security/d25-api-key-grep.test.ts` runs:

```
node recursive walk on:
  apps/api/src/
  apps/web/src/
skip: node_modules, dist, build, .next, .commander, *.test.ts, *.spec.ts, *.fixture.ts, *.d.ts
regex match (case-sensitive) for prefixes:
  sk- / sk-proj- / sk-ant-
  ghp_ / gho_ / ghu_ / ghs_ / ghr_
  AKIA / ASIA  (16-char alnum suffix)
  xox[abprs]-  (Slack)
```

If any of those prefixes appears in source (excluding the patterns above), the test fails with a report listing:
- the file (relative to repo root),
- the line number,
- the matched substring (truncated to 32 chars),
- the canonical env-var name the prefix maps to (so the operator knows where to migrate).

Remediation:
1. Read the violation report.
2. Replace the plaintext with `process.env.<canonical-env-var>`.
3. Document the env-var in your deployment README so ops knows what to set.
4. Confirm CI is green.

---

## §5 — Pre-commit Hook Coordination

The D3 pre-commit hook (`.githooks/pre-commit` → `scripts/precommitHook.ts`) does NOT run this gate today. The D2.5 gate runs as a vitest suite at CI-level only. This split is intentional:
- pre-commit hook = fast (~seconds), blocks catastrophic slips.
- vitest CI gate = slower (~10 s), enforces policy at merge time.

A future hardening card may unify the two. Until then, expect a short CI window where committed plaintext is caught before review.

---

## §6 — Sign-off

This policy is binding on the engineering organisation once signed below. New secret classes MUST be added to §1 + §2 before being introduced.

### §6.1 — Sign-off format (binding)

Each row below must carry a **Name · GitHub Handle · GPG fingerprint (16-char short) · Signed-Commit SHA**. The GPG fingerprint binds the sign-off to a cryptographic identity so substitution is detectable on review; the Signed-Commit SHA binds the policy to the exact text that was approved. **The effective date is NOT a free-form cell** — it is the cryptographic timestamp of the GPG-signed commit and is derived as:

```
git log -1 --format=%aI <Signed-Commit SHA>
```

`git verify-commit <Signed-Commit SHA>` MUST return 0; if it does not, the row is treated as unverified and the gate fails. The verifier script (`scripts/verify-rotation-signoff.ts`) prints the derived `signed_at` value for every verified row, eliminating any opportunity to post-date a sign-off.

An empty SHA cell is `[pending]`, not `[FAILED]` — empty cells do not count as a failure and contribute zero toward the policy-binding minimum. The D2.7 gate therefore requires at LEAST `POLICY_MIN_VERIFIED_ROWS = 4` rows to hold a GPG-verified SHA; an all-empty table is RED exit 1, not bound. Any row whose non-empty SHA fails `git verify-commit` IS a failure, and the gate exits 0 only when `(verified ≥ POLICY_MIN_VERIFIED_ROWS) ∧ (failed = 0)`. When BOTH clauses are simultaneously violated (e.g. one row carries an invalid SHA while the rest are empty), the report stacks BOTH reasons so the most actionable defect is not hidden: `"RED: policy NOT bound AND N unverified SHA(s) need to be fixed."`. **Operational implication of D2.9 (min = 4):** every release-block stays RED exit 1 until all four roles GPG-sign commits; partial sign-off (e.g. 3-of-4 verified, or 4-of-4 with one invalid SHA) cannot clear the gate alone — the verifier demands the full set before flipping GREEN. This is intentional: a single absent or invalid signature is treated as a release-block, not a soft-warning. **Break-glass path:** open a waiver-PR against this policy doc, with authorisation recorded per §3's trigger criteria (HackerOne, postmortem, CISO direct instruction, d25 plaintext hit, or provider-initiated disclosure). The §7 traceability row for §3 establishes `/.commander/approval-mode.json` as the audit-tracking surface for the runbook drill, and the verifier re-derives the bound from the rotated commit's SHA. *Listing is a quick-glance summary; §3's full enumerated trigger language is canonical.*

**D3.0 surface (informative):** the verifier exposes a structured `reasons: readonly string[]` array on its public `VerifyResult` (additive change; the human-readable `report` field is preserved for back-compat). Dual-failure cases now expose BOTH policy clauses as separate `reasons[]` elements — structured dashboards / alerting rules can iterate the array directly without re-parsing `report`. CLI surface ships a `--json` flag (compact `{status, exitCode, reasons}` payload on stdout, ideal for `jq`) and a `--quiet` flag (terse one-line summary on stderr; multi-line human report suppressed). Both flags are orthogonal: `--json` controls stdout, `--quiet` controls stderr. Usage examples are in §8. The verifier stays a single-source-of-truth via `POLICY_MIN_VERIFIED_ROWS` + `POLICY_VERSION`.

### §6.2 — How to sign off

1. Set up a GPG key (recommended: ed25519). Configure `git config --global user.signingkey <key-id>`.
2. Make a single-line change to the table below (e.g. fill in the CISO row with `Name | handle | fingerprint | <your future SHA>`).
3. Stage the change and run `git commit -S` (GPG-signed). Capture the resulting commit SHA.
4. Update the row's **Signed-Commit SHA** cell with that SHA.
5. Run `pnpm vitest run tests/security/d26-rotation-signoff-gate.test.ts` to confirm the gate goes green.
6. Open a PR. Reviewers replay `git verify-commit <sha>` and read `git log -1 --format=%aI <sha>` to confirm the effective date.

The Signed-Commit SHA is the binding artifact; reviewers can replay `git verify-commit <sha>` to confirm the signer is the named GPG keyholder.

### §6.3 — Sign-off table

| Role                | Name | GitHub handle | GPG fingerprint (16-char short) | Signed-Commit SHA        |
|---------------------|------|---------------|---------------------------------|--------------------------|
| **CISO**            |      |               |                                 |                          |
| **Head of Security**|      |               |                                 |                          |
| **Engineering Lead**|      |               |                                 |                          |
| **Compliance Lead** |      |               |                                 |                          |

### §6.4 — Procedural note

Sign-off requires (a) a GPG-signed commit on this document (§6.2 step 3), (b) the PR has at least one approval from a role other than the signer, and (c) the commit is then included in the next tagged security-policy release. **Bypass of any of (a, b, c) is forbidden** — even by CISO direct waiver — because the cryptographic binding cannot be circumvented without invalidating the chain. If CISO waiver is genuinely required, rotate the CISO GPG key through the AuditChainLedger's key-rotation event before granting the waiver.

---

## §7 — Enforcement Traceability

| Policy clause       | Test gate / enforcement artifact                                                          |
|---------------------|--------------------------------------------------------------------------------------------|
| §1 Scope            | `vitest run tests/security/d25-api-key-grep.test.ts`                                       |
| §2 Cadence          | operational; not auto-tested                                                               |
| §3 Runbook          | manual runbook drill; tracked via `/.commander/approval-mode.json` entries                 |
| §4 CI Gate          | `vitest run tests/security/d25-api-key-grep.test.ts`                                       |
| §5 Pre-commit coord | `.githooks/pre-commit` → `scripts/precommitHook.ts`                                        |
| §6 Sign-off         | `vitest run tests/security/d26-rotation-signoff-gate.test.ts` + `npx tsx scripts/verify-rotation-signoff.ts` |
| §6.1 binding (D2.7 / D2.8 + D3.0) | (a) Date binding: `git log -1 --format=%aI <sha>` derived from GPG-verified SHA (no free-form Date cell); (b) ≥ `POLICY_MIN_VERIFIED_ROWS` (currently 4 per D2.9) verified bound: `evaluateSignoff(rows)` returning `VerifyResult { ok, rows, reasons, report, exitCode }` where D3.0's `reasons: readonly string[]` carries the discrete clause list (separate elements on dual-clause; joined via `' AND '` for the human `report`); contract honoured by `npx tsx scripts/verify-rotation-signoff.ts [--json] [--quiet]` exit-code (0/1/2). D3.0 also adds `--json` (compact `jq`-friendly JSON on stdout) + `--quiet` (terse one-line summary on stderr, multi-line report suppressed). |

---

## §8 — Operator quick-reference

```bash
# Verify the current sign-off table:
npx tsx scripts/verify-rotation-signoff.ts

# Verify a sign-off table in a production fork:
npx tsx scripts/verify-rotation-signoff.ts --doc=./keys-rotation-fork.md

# Run the regression gate (CI):
cd packages/core && npx vitest run tests/security/d26-rotation-signoff-gate.test.ts

# Show the effective date of an existing sign-off:
git log -1 --format='%aI  %s' <Signed-Commit SHA>

# Confirm the GPG binding:
git verify-commit <Signed-Commit SHA>

# D3.0: emit a compact JSON status payload for shell pipelines / `jq`:
npx tsx scripts/verify-rotation-signoff.ts --json | jq '.reasons[]'

# D3.0: terse CI logs — one-line summary on stderr, multi-line report suppressed:
npx tsx scripts/verify-rotation-signoff.ts --quiet

# D3.0: combine `--json` + `--quiet` for the typical `jq` pipeline read-out:
npx tsx scripts/verify-rotation-signoff.ts --json --quiet
```
