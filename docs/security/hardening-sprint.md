# Security Hardening Sprint — 14-Day WBS

> **Sprint ID:** `SEC-HARD-2026.07`
> **Start:** T+0 (date Agreed in kickoff)
> **End:** T+14 (12 workdays + 2 buffer)
> **Goal:** Close all 12 P0 launch gates → ship to Private Beta (Day 15)
> **Non-goals:** Adding new features · Scaling perf · Provisioning prod infra · Public launch messaging
> **Scope card:** Code freeze on `packages/core` (except security-critical hotfixes). New features behind feature flags; **no merges to `main` during sprint absent security risk to users**
> **Repo:** `Commander` (lock branch `sec-hard-2026.07-sprint`)
> **Linked artifacts:** `docs/acquisition-readiness-plan.md` · `docs/security/soc2-type2-readiness.md` · `/tmp/compliance-audit-seed.json`

---

## 0. Pre-Sprint Baseline (T-1 Day)

Run these commands **the day before kickoff** and save outputs to `docs/security/sprint-baseline-2026-07.md`:

```bash
# Baseline state
git status --short > baseline.dirty
git log --oneline -10 > baseline.commits
git rev-parse HEAD > baseline.commit
docker --version > baseline.tooling

# Current security posture
npx tsx packages/core/src/security/runComplianceAudit.ts --all \
  --output=/tmp/sprint-baseline-audit 2>&1 | tee baseline.audit.log

# Current test inventory
find packages/core/tests -name '*.test.ts' | wc -l > baseline.test_count
npx tsc --noEmit 2>&1 | tee baseline.tsc
pnpm --filter @commander/core test 2>&1 | tail -200 > baseline.testlog
```

The 12 launch gates must be **explicitly enumerated** in the kickoff doc. Use this as the dashboard.

---

## 1. Master Schedule

| Phase | Days | Lead | Theme | Cap-rolled-if-don't? |
|-------|------|------|-------|-----------------------|
| **Phase A** Critical Lock | D1, D2, D2.5, D3 | DevOps + Backend | Audit/prod key + git clean + benchmark verify + HTTP-API secret scrub | **Yes: blocking** |
| **Phase B** Stability | D4-D7 | Backend + QA | Core test green + coverage + inventory | Yes: blocking |
| **Phase C** UX Demo | D8-D10 | Backend + Front | Interactive approval UI + sandbox secrets e2e | Yes: critical-path |
| **Phase D** Packaging | D11-D14 | DevOps + Sec + Product | Docker prod + 10-min clone + HackerOne + Risk Register v0.1 | Yes: blocking |
| **Buffer** | already in calendar | — | Slip absorption | — |
| **Exit Review** | D14 16:00 | CTO + CISO | Gate-by-gate final check before Private Beta | — |

**Daily stand-up:** 09:00 UTC · 30 min · no exception. Async remote OK.

---

## 2. Owner Matrix (RACI)

| Role | Person | RACI for Hardening |
|------|--------|-----|
| CISO | TBD | **Accountable** final sign-off each Day 14 onward · weekly |
| CTO | TBD | **Accountable** Technical decisions · weekly |
| Head of Security | TBD | **Responsible** Phase A + D Risk Register; Consult for B + C |
| DevOps Lead | TBD | **Responsible** Phase A + D packaging/keys |
| Backend Lead | TBD | **Responsible** Phase B + interactive approval integration |
| Frontend Lead | TBD | **Responsible** Phase C inquirer modal UI |
| QA Lead | TBD | **Responsible** Phase B + sandbox e2e |
| Product Lead | TBD | **Responsible** Phase D HackerOne go-live |

---

## 3. Phase A: Critical Lock (D1, D2, D2.5, D3 · 4 cards · 6 deliverables)

### D1 — Audit Chain prod-key fail-fast + .gitignore lock
**Lead:** DevOps · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • Fail-fast at the **single chokepoint** `resolveMasterKey()` exported from `packages/core/src/security/auditChainLedger.ts` (re-used by both `AuditChainLedger` and `CapabilityTokenIssuer`): throws `Error('COMMANDER_AUDIT_CHAIN_KEY required')` when env unset AND `NODE_ENV=production`<br>• Same fail-fast in `CapabilityTokenIssuer.resolveMasterKey()` and `FederatedIdentity.resolveFederationKey()` — all 3 chokepoints assert their distinct env-var name in the message (`AUDIT_CHAIN_KEY`, `CAPABILITY_TOKEN_KEY`, `FEDERATION_KEY`)<br>• Add 4 unit tests (one per chokepoint + one for dev-mode unchanged): assert exact env-var name appears in error<br>• Update `.gitignore`: `.commander/conversations.db`, `.commander/posture-snapshots.json`, `.commander/webhooks.json`, `*.tmp.cbor`<br>• Remove existing tracked dirty files via `git rm --cached` (keep local copies) |
| **Entry (In)** | Local dev with `NODE_ENV=development` works unchanged |
| **Exit (Out)** | • Running `NODE_ENV=production npx tsx cli.ts --plan "noop"` fails with the documented error and exact env-var name<br>• `git status` shows the four patterns as "ignored"<br>• All 3 unit tests green; total core test count = N+3 |
| **Verify** | `NODE_ENV=production bash -c 'npx tsx packages/core/src/security/runComplianceAudit.ts' 2>&1 \| grep -i 'audit_chain_key\|required'` |
| **Self-weight** | 6 — block everything else until signed off |

### D2 — Benchmark `benchmark:verify` script + reproducibility
**Lead:** Backend · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • Add `scripts/benchmark-verify.ts` that runs BFCL / GAIA / PinchBench — subset of 20 cases each — and asserts ≥ baseline numbers we will publish on scorecard (Blackbox baseline: reuse any cached `securityBenchmarkRunner` results)<br>• Wire `pnpm benchmark:verify` in root `package.json`<br>• Save outputs JSON+MD under `docs/security/benchmarks/<date>/`<br>• Document in `docs/security/benchmarks/README.md` how to extend (don't allow drift) |
| **In** | `packages/core/src/security/securityBenchmarkRunner.ts` exposes `getCasesForBenchmark()` we already use |
| **Out** | • `pnpm benchmark:verify` runs end-to-end in ≤8 min · exit code 0 on success<br>• JSON output is deterministic (sort order, no random ids)<br>• README explains the 20-case subset selection + how to spot drift |
| **Verify** | `pnpm benchmark:verify && cat docs/security/benchmarks/$(date)/summary.json \| jq '.pass_rate'` |
| **Self-weight** | 5 — protects #3 launch failure mode (BFCL/GAIA fake-result accusation) |

### D2.5 — HTTP API: scrub plaintext API keys + secret-rotation audit
**Lead:** Backend · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • `grep -rnE '(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+)' packages/apps/api/src/` → expect zero hits after fix<br>• Replace any plaintext occurrence with `process.env.X` indirection + add an explicit null-check that throws at boot<br>• Add `tests/api/secretsEnvironmentOnly.test.ts` asserting the entire `apps/api/src` tree is env-only — `grep -RE '[A-Z0-9]{20,}' src/ \| grep -vE '^src/.*\.spec\.ts:'` is empty<br>• Document the rotation procedure in `docs/security/secret-rotation.md` (when a key is leaked: rotate → invalidate → revoke → audit log entry) |
| **In** | `packages/apps/api` has `authMiddleware.ts` + `httpServer.ts` already wired with env-var resolution |
| **Out** | • `grep -RE '(sk-\\|ghp_\\|AKIA\\|xox[abprs])' packages/apps/api/src` returns exit 1<br>• Test passes against current tree (counts = 0 plaintext hits)<br>• Rotation doc signed by Head of Security + CISO |
| **Verify** | `bash -c 'grep -RE "(sk-\\\\|ghp_\\\\|AKIA\\\\|xox[abprs])" packages/apps/api/src && echo FAIL || echo CLEAN'` |
| **Self-weight** | 3 — clears any plaintext key left over from rapid prototyping |

### D3 — `commands/skill/tool security` scan pre-commit hook
**Lead:** DevOps · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • Pre-commit hook (husky) calls `SupplyChainScanner.scan()` (interface method exported from `packages/core/src/security/supplyChainScanner.ts`; **NOT** `scanFile()` — confirm the exact name when implementing) on any new/modified `.ts` under `tools/` or `sandbox/{profiles,approval}.ts`<br>• The hook must **block** if any file produces severity ≥ "high" finding; emit a remediation message<br>• Second pass: **ExecPolicy edge-case unit tests** in `packages/core/tests/security/execPolicy.engine.test.ts` (or extend existing) covering pipes (`a | b`), env-prefix substitution (`FOO=bar cmd`), symlinked command paths (`/usr/bin/nice`). Must hit ≥ 5 patterns; assert "exec_policy_forbidden" event types on each<br>• Add CI gate `.github/workflows/security-gate.yml` running the same scanner over PR diff (≤30 sec target)<br>• Document bypass policy in `CONTRIBUTING.md` requiring justified `[skip-reason: ...]` magic comment |
| **In** | `SupplyChainScanner.scan({ filePath })` exports today; sandbox/`profiles.ts` + `approval.ts` exist |
| **Out** | • `git commit -m "test bypass"` with a high-severity file content → **commit rejected** with clear remediation message<br>• ExecPolicy tests: pipes / substitution / symlinks blocked at unit-test level + 5+ variant attack-inputs each<br>• CI workflow runs in <30 sec on diff<br>• Documentation identifies false-positive escape hatch |
| **Verify** | (scanner) `echo ': pipeline' > /tmp/x && git add /tmp/foo.ts && git commit -m t` → expect reject with `SupplyChain threat: ...` · (execPolicy) `npx vitest run tests/security/execPolicy.engine.test.ts` |
| **Self-weight** | 4 (raised from 3 — covers two outstanding 30-day items) |

---

## 4. Phase B: Stability (D4-D7 · 4 cards)

### D4 — Core test suite green
**Lead:** QA · **Sign-off:** Backend Lead

| | |
|---|---|
| **Tasks** | • Run `pnpm --filter @commander/core test` end-to-end on `sec-hard` branch<br>• Triage failures into: (a) real bugs, (b) flaky timeouts, (c) dependencies on prior global state → file issue per category<br>• Squash (a) with fixes ≤ 200 LOC each (split if larger)<br>• For (b): add `vi.retry(2)` or `await sleep(50)` per documented flake, **track count** in `docs/security/test-flake-log.md`<br>• For (c): ensure singleton reset between tests |
| **In** | Current "271 .test.ts files" + bash count |
| **Out** | • `pnpm --filter @commander/core test` exit code 0<br>• Per-file flake-rate < 1% (no file shows >2 retries in 5 runs)<br>• Test-flake-log.md updated with every retried test |
| **Verify** | `for i in 1 2 3 4 5; do pnpm --filter @commander/core test 2>&1 \| tail -5; done` → see 5/5 success rows |
| **Self-weight** | 8 — gates everything downstream |

### D5 — Coverage report + CI artifact
**Lead:** Backend · **Sign-off:** QA Lead

| | |
|---|---|
| **Tasks** | • Configure vitest `--coverage` provider=v8 — already a config key<br>• Coverage threshold floor: `lines: 70`, `branches: 60`, `functions: 75` (raise in Q3, not now)<br>• `pnpm --filter @commander/core test:coverage` writes to `.coverage/` and uploads as `coverage-summary.html` in CI artifact<br>• Add § to `docs/security/hardening-sprint.md` baseline diff |
| **In** | `vitest --coverage` v8 works locally for a subset |
| **Out** | • CI step `coverage-report` uploads artifact<br>• Coverage floor enforced → red builds below threshold<br>• Coverage delta (vs D5 baseline) tracked |
| **Verify** | `pnpm --filter @commander/core test:coverage 2>&1 \| grep -E 'All files\|lines'` |
| **Self-weight** | 4 |

### D6 — `test:inventory` no-silent-omits gate
**Lead:** Backend · **Sign-off:** QA Lead

| | |
|---|---|
| **Tasks** | • `scripts/test-inventory.ts` parses `packages/core/tests/**/*.test.ts` and asserts each has a corresponding entry in the runner config (`vitest.config.ts`)<br>• Cross-references against `scripts/scripts-registry.json` if present<br>• Outputs `tests/inventory-report.json`: `{ filePath, registered, framework, skipped }`<br>• CI gate via `pnpm test:inventory` exits 1 if any file is "found on disk but not registered" |
| **In** | `vitest.config.ts` includes current inv+unit/integration paths |
| **Out** | • Adding new `foo.test.ts` and forgetting to register → CI fails with explicit path<br>• Removing `vitest.config.ts` entries → also detected (test files become orphans but registered count diverges from disk) |
| **Verify** | `pnpm test:inventory 2>&1 \| jq '.unregistered'` → expect `[]` |
| **Self-weight** | 4 |

### D7 — Provider streaming real (not stub) + sandbox secrets e2e
**Lead:** Backend · **Sign-off:** QA Lead

| | |
|---|---|
| **Tasks** | • `packages/core/src/telos/providerPool.ts` — verify streaming receives chunks >1 for at least OpenAI + Anthropic adapters via mocked SSE<br>• Add test asserting: chunks.length >= 3 in 1s for stage-1 stream; chunk sizes vary (not single fallback token)<br>• `tests/integration/sandbox-secrets-e2e.test.ts` — full scenario: start sandbox with `OPENAI_API_KEY=sk-...` in env, run `printenv`, assert key **does NOT appear** in tool output or stderr<br>• Add test asserting `~/.aws/credentials` is mounted read-only or absent under workspace profile |
| **In** | The prior commit notes flagged `providerPool.test.ts` was "untested streaming" and `sandbox-security.test.ts` "recently rewritten" |
| **Out** | • All 3 stream tests green<br>• Secret-leak tests fail-fast if API key appears; lock for any integration dolly<br>• Test results in `sprint-baseline-2026-07.md` show ≥ N+4 test count vs Day 4 |
| **Verify** | `npx vitest run tests/integration/sandbox-secrets-e2e.test.ts packages/core/src/telos/providerPool.test.ts` |
| **Self-weight** | 5 — protects gate #3 + #5 |

---

## 5. Phase C: UX Demo (D8-D10 · 3 cards)

### D8 — Interactive approval UI (inquirer/blessed modal)
**Lead:** Frontend · **Sign-off:** Backend Lead

| | |
|---|---|
| **Tasks** | • Pick library: prefer `inquirer` (lighter; ≥ v9 declared in deps if not, add)<br>• Wire to existing `ApprovalCallback.ts`: `commit-msg-triggered` shell tool calls land at `inquirer.prompt([{type:'confirm',name:'allow',message:'Allow this command?',default:false}])`<br>• Distinguish 6 categories (`sandbox_escape`, `network`, `file_write`, `file_read`, `shell_exec`, `destructive`) with category-specific wording<br>• Default to **deny**; require explicit `yes` with stderrcatch on non-TTY env (auto-deny with logged reason) |
| **In** | `ApprovalCallback.ts` already supports programmatic decisions |
| **Out** | • Manual demo run: `./commander run "rename src/foo.ts to foo2.ts"` → inquirer modal appears with appropriate copy<br>• `npx vitest run tests/approval-ui.test.ts` passes (mock stdin/stdout)<br>• Non-TTY (`< /dev/null`) auto-denies with structured audit entry |
| **Verify** | `npx vitest run tests/approval-ui.test.ts + interactive recording in PR description` |
| **Self-weight** | 5 — covers table-stakes D7+D1 |

### D9 — Plan persistence (`plan.md` as long-task artifact)
**Lead:** Backend · **Sign-off:** CTO

| | |
|---|---|
| **Tasks** | • `StateCheckpointer` write a `plan.md` whenever a multi-step mission is initiated (≥ 3 steps)<br>• Format: Goal · Steps · Dependencies · Current state · Recovery command<br>• Update plan as steps execute (overwrite on each step completion + append at completion)<br>• Expose `commander plan show <mission-id>` CLI |
| **In** | `StateCheckpointer.ts` already atomic-write snapshots |
| **Out** | • Run `./commander run "5-step research mission"` — `plan.md` appears at workspace root within 200ms of mission start<br>• Kill mid-mission (`Ctrl+C`) → re-run `./commander run --resume` reads `plan.md` and continues from last-checkpointed step<br>• Plan.md format documented in `AGENTS.md` "Plan persistence" section |
| **Verify** | `rm -rf /tmp/plan-test && ./commander run --plan-only "decompose this research" && cat plan.md && wc -l plan.md ≥ 8` |
| **Self-weight** | 3 — covers table-stakes D6 |

### D10 — Sandbox full-access secrets filter end-to-end
**Lead:** QA · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • Write `tests/e2e/sandbox-full-access-secrets.test.ts` — start sandbox in `full-access` mode (Docker), set env `AWS_SECRET_ACCESS_KEY=wJalr...`, execute `cat /proc/self/environ` via `shell_exec` tool, assert **filter triggered** and key replaced with `***REDACTED***`<br>• Test 3 secret types: AWS keys, GitHub PAT (`ghp_...`), OpenAI (`sk-...`)<br>• Assert audit chain records the redaction event |
| **In** | `sandbox/profiles.ts` already has `envFilter` |
| **Out** | • All 3 tests green · fails-fast if filter bypasses<br>• Audit chain evidence: `getAuditChainLedger().verifyChain()` after each test still passes<br>• Test results appended to `sprint-baseline-2026-07.md` |
| **Verify** | `npx vitest run tests/e2e/sandbox-full-access-secrets.test.ts` |
| **Self-weight** | 5 — covers gate #3 sandbox secret filtering |

---

## 6. Phase D: Packaging (D11-D14 · 4 cards)

### D11 — `docker-compose.prod.yml` hardened + health/readiness probes
**Lead:** DevOps · **Sign-off:** CTO

| | |
|---|---|
| **Tasks** | • Validate `docker-compose.prod.yml` runs `docker compose -f docker-compose.prod.yml config` without warnings<br>• Add `healthcheck` for each service — interval 30s · timeout 5s · 5 retries<br>• Add `readiness` probe — probe that returns 503 until ApplicationWarmup ack<br>• Confirm `apps/api` mounts `audit-chain/` as tmpfs (not a docker volume!) to avoid persistence leaks<br>• Run `docker compose up` and check `curl localhost:8080/health` returns 200 within 30s |
| **In** | `docker-compose.prod.yml` already exists |
| **Out** | • `docker compose -f docker-compose.prod.yml config` exit 0 with no warnings<br>• All services healthy after `docker compose up`<br>• Health probe output documented in API doc |
| **Verify** | `bash -c 'docker compose -f docker-compose.prod.yml config > /dev/null && echo OK'` |
| **Self-weight** | 4 — gate #9 |

### D12 — 10-minute clean clone demo script
**Lead:** DevOps · **Sign-off:** Product Lead

| | |
|---|---|
| **Tasks** | • Write `scripts/demo-clone.sh` that performs `git clone` → `pnpm i` → `pnpm test` → `pnpm demo:run` from a fresh dir simulating user<br>• Time-budget: full script ≤ 10 min; CI-run below 8 min possible<br>• Capture screen recording + speedrun in `docs/security/demos/clone-10min.mp4`<br>• Update README "Quick start" with new commands |
| **In** | `acquisition-readiness-plan.md` 30-day ship list item #10 |
| **Out** | • `bash scripts/demo-clone.sh` completes in ≤ 10 min wall-clock (CI job `demo-clone-smoke` runs the same)<br>• Recording uploaded to public storage<br>• README correct |
| **Verify** | `time bash scripts/demo-clone.sh` |
| **Self-weight** | 5 — gate #10 |

### D13 — `SECURITY.md` + HackerOne go-live
**Lead:** Product + Security · **Sign-off:** Head of Security

| | |
|---|---|
| **Tasks** | • Create `SECURITY.md` at repo root: scope line (packages/core, sandbox, scanners, redteam), severity matrix, response SLA (`P0 < 4h`, `P1 < 24h`, `P2 < 7d`), coordinated disclosure notice<br>• HackerOne company box set up with `commander` program — invitation-only mode at launch<br>• `commander.security@<org>` mailbox aliased<br>• Print the SECURITY.md as part of `commander --help security`<br>• Document in `CONTRIBUTING.md` how a bounty is paid |
| **In** | Existing scope = `tests/security/*` already references CVE-style naming |
| **Out** | • `SECURITY.md` published (= commit on `main`, not just branch)<br>• HackerOne program URL works in a private browser session<br>• Email-MX on `commander.security@` resolvable<br>• First internal test report filed and acknowledged in <24h cycle |
| **Verify** | `curl -sI https://hackerone.com/commander` (302) + `dig +short TXT commander.security` (responds) |
| **Self-weight** | 5 — gate #12 + SOC 2 CC2.1 |

### D14 — Risk Register v0.1 + Audit Hardening sign + Pre-Beta gate review
**Lead:** Head of Security · **Sign-off:** CISO + CTO

| | |
|---|---|
| **Tasks** | • CISO + CTO + Head of Security 30-min meeting finalize `docs/security/risk-register.md` v1.0 with Top 20 entries (use MITRE ATLAS Heatmap from `MitreAtlasMapper.generateReport` as source)<br>• Each Top 20 assigned an accountable owner (NOT always security — usually backend or product)<br>• Re-run `runComplianceAudit.ts` to capture snapshot POSTURE-D14 closing the 4 organizational SOC 2 P0 (CC3.2, CC3.1, CC1.4, CC2.1+2.2)<br>• Persist audit baseline at `docs/security/baselines/posture-D14.json`<br>• Pre-Beta Gate Review (60 min): each of the 12 launch gates walked through with demo + score<br>• Sign-off doc `docs/security/launch-gates-2026-07.md` (CHK across rows) |
| **In** | `MitreAtlasMapper.generateReport()` already produces heatmap |
| **Out** | • Risk register signed and committed (CISO + CTO dual sign)<br>• Posture snapshot shows ≥ 4 new ISO/NIST items closed versus baseline<br>• `launch-gates-2026-07.md` shows ≥ 12/12 ✅ for the 12 gates<br>• Go/no-go call scheduled for Day 15 09:00 UTC |
| **Verify** | `npx tsx packages/core/src/security/runComplianceAudit.ts --all --output=/tmp/d14-baseline && diff <(jq .isoCompliance.gaps /tmp/sprint-baseline-audit.json) <(jq .isoCompliance.gaps /tmp/d14-baseline.json) \| head -40` |
| **Self-weight** | 9 — final exit gate |

---

## 7. Exit Criteria (D14 16:00 → Private Beta)

### Definition of Done (all required)

| # | Objectively verifiable | Verifier | Status |
|---|-------------------------|----------|--------|
| 1 | `git status` clean (no large uncommitted DB/JSON files) | DevOps Lead | ☐ |
| 2 | `npx tsx packages/core/src/security/runComplianceAudit.ts` — `COMMANDER_AUDIT_CHAIN_KEY` failure if absent in prod | Head of Security | ☐ |
| 3 | `pnpm benchmark:verify` exit 0 with reproducible JSON output | Head of Security | ☐ |
| 4 | `pnpm test:inventory` reports `[]` unregistered | QA Lead | ☐ |
| 5 | `pnpm --filter @commander/core test:coverage` upload artifact + floor enforced | QA Lead | ☐ |
| 6 | `pnpm --filter @commander/core test` exit 0 × 5 consecutive runs | QA Lead | ☐ |
| 7 | `docker compose -f docker-compose.prod.yml config` valid | DevOps Lead | ☐ |
| 8 | `bash scripts/demo-clone.sh` ≤ 10 min wall-clock | DevOps Lead | ☐ |
| 9 | `SECURITY.md` published & linked from README | Product Lead | ☐ |
| 10 | `docs/security/risk-register.md` v1.0 committed | CISO + CTO | ☐ |
| 11 | 4 SOC 2 P0 organizational items show progress in audit report (CC3.2, CC1.4, CC2.1+2.2, CC3.1) | Head of Security | ☐ |
| 12 | All launch-gate signs signed in `docs/security/launch-gates-2026-07.md` | CISO + CTO | ☐ |
| 13 | `grep -RE '(sk-\\|ghp_\\|AKIA\\|xox[abprs])' packages/apps/api/src` exits 1 (D2.5 secrets scrub) | Head of Security | ☐ |

**Private Beta is GO** only when **all 13 boxes ticked**.

---

## 8. Risk Register for the Sprint Itself

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Provider streaming real test fails → D7 blocks | M | M | Day 4 risk-pool: have OpenAI + Anthropic IDE-add another research |
| `.gitignore` accidentally drops benchmark data files | L | H | Verify with `git check-ignore -v <file>` after commit |
| Pre-commit hook has too many false positives → engineers disable | H | M | Phase A escape hatch documented + tracked |
| HackerOne program not approved in time | L | L | Defer to Private Beta Phase — open source disclosure as fallback |
| CISO or CTO unavailable for Day 14 sign-off | M | H | Schedule backup signers ahead, documented in DOC |
| Test flake rate > 1% on D6 | M | M | D4-D6 buffer; if > 3% by D6, pull feature scope |
| `docker compose prod` requires Mac M-series silicon; CI on Linux only | M | L | CI runs on amd64 already; document in `README.md` |

---

## 9. Daily Stand-up Cadence

- **09:00 UTC** — daily 30-min stand-up (remote OK)
- **Output per day:** Owner updates `docs/security/hardening-sprint.md` Day card with `% complete` and `blocker?`
- **D14 16:00:** final sign-off → Day 15 09:00 UTC kite ship decision (Private Beta go/no-go)

---

## 10. Phase-After-Sprint Hand-off → Private Beta

Day 15 onward (NOT part of this sprint):

- 5 enterprise private beta invites (priority: 2 banks, 1 gov, 1 hospital, 1 manufacturer)
- Define 30-day beta SLA: 99.9% uptime target, response time P95
- `commander.security@` mailbox receiving real reports; track live `AgentSOC` incident counts weekly
- Beta retires 30-60 days later → Public Launch readiness check (different sprint)

---

> **Co-sign signature block** (at sprint end):
>
> Head of Security: ________________
> CTO: ________________
> CISO: ________________
> Date: ________________

*Sprint is closed when all 12 gates have ticks AND signatures.*
