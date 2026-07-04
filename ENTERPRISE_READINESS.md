# Enterprise Pilot Readiness — Commander v0.2.x

> **Audience:** Engineering owners, compliance officers, and the CFO signing off on enterprise pilots.
> **Purpose:** Explicit checklist of what must be true before a customer can pilot Commander in production-tier workloads.
> **Confidence:** Items marked ✅ have a wired commit; items marked 🟡 have a documented gap; items marked ❌ have no implementation yet.

> **CI rule:** Every ✅ entry below must have an evidence pointer (commit SHA or file:line) and be reflected in `docs/status.json`. The `pnpm check:readiness` script (referenced from `.github/workflows/ci.yml`) fails the build if any ✅ marker is stale.

---

## P0 — MUST be true before any paid pilot ships

### Security — Tier-1 certifiable

| # | Item | Status | Owner | Evidence | Target |
|---|------|--------|-------|----------|--------|
| SOC2-1 | API keys resolved via AES-256-GCM EncryptedSecretsVault, never `process.env.<X>_API_KEY` in production paths | ✅ | @security-team | `packages/core/src/security/encryptedSecretsVault.ts`; `secureApiKeyResolver.ts`; wired in `CommanderHttpServer.start()` | 2026-Q3 (delivered 2026-06-29) |
| SOC2-2 | Tamper-evident audit chain for security-relevant events (one-way hash) | ✅ | @security-team | `packages/core/src/security/auditChainLedger.ts` (rewrite-once ledger) | 2026-Q3 (delivered) |
| SOC2-3 | RBAC + capability-token defense at tool boundary | ✅ | @security-team | `packages/core/src/security/capabilityToken.ts`; HMAC short-lived tokens | 2026-Q3 |
| SOC2-4 | mTLS for inter-process traffic (HTTP server → AgentRuntime) | ❌ | @infra | Roadmap only; tracks G3 in `security_architecture_hardening_roadmap.md` | 2026-Q4 |
| SOC2-5 | SOC 2 Type II report (audit-window) | ❌ | @compliance | External auditor engagement; requires SOC2-1..4 green for ≥3 months | 2027-Q2 |
| SOC2-6 | Cross-tenant fuzz test suite (every storage backend) | ❌ | @security-team | Listed in G6; not started | 2026-Q4 |

### Observability — Tier-1 certifiable

| # | Item | Status | Owner | Evidence | Target |
|---|------|--------|-------|----------|--------|
| OBS-1 | W3C distributed tracing end-to-end (every LLM call / tool call tagged with `traceId`/`spanId`) | ✅ | @observability | `packages/core/src/runtime/distributedTracing.ts`; `runWithTrace` AsyncLocalStorage | 2026-Q3 (delivered) |
| OBS-2 | OpenTelemetry exporter (Jaeger/Tempo/Honeycomb compatible) | ✅ | @observability | `packages/core/src/runtime/openTelemetryExporter.ts`; `getOTelExporter()` | 2026-Q3 |
| OBS-3 | Prometheus `/metrics` endpoint in **both** HTTP server (CommanderHttpServer) **and** apps/api | ✅ | @observability | `CommanderHttpServer.metrics`; `apps/api/src/index.ts:/metrics` | 2026-Q3 |
| OBS-4 | Grafana dashboard template for SLO tracking | ❌ | @observability | Mentioned in `docs/runbooks/chaos.md` but no committed JSON template | 2026-Q4 |

### Multi-tenancy — Alpha (API context isolation only)

⚠️ **Alpha.** Commander provides tenant-aware singletons and request-context
isolation via `runWithTenant` + `AsyncLocalStorage`. Storage-layer isolation
(SQLite per-tenant path, per-tenant budgets) is opt-in and must be verified by
the deployment operator. Do not rely on the current implementation for strict
inter-tenant data separation without configuring the storage backend and
setting `allowGlobalFallback: false` on tenant-aware singletons.

| # | Item | Status | Owner | Evidence | Target |
|---|------|--------|-------|----------|--------|
| TEN-1 | Tenant-aware singletons gated by `runWithTenant` AsyncLocalStorage | 🟡 | @multi-tenancy | `runtime/tenantAwareSingleton.ts` provides the *interface*; storage backend cooperation is customer-side | 2026-Q3 (interface delivered, customer-side verification ongoing) |
| TEN-2 | SQLite per-tenant (instead of optional filtering) | 🟡 | @multi-tenancy | `storage/cachedDriver.ts` shipped 2026-06-29; per-tenant path is opt-in | 2026-Q4 |
| TEN-3 | Cross-tenant fuzz test (TEN-1 + TEN-2 verification harness) | ❌ | @security-team | Accepts seed memories as Tenant A, asserts no read leakage as Tenant B | 2026-Q4 |
| TEN-4 | Enforce "no global fallback" boundary outside development | ❌ | @multi-tenancy | `tenantAwareSingleton.ts` logs a runtime warning; enforcement is pending | 2026-Q4 |

### SLA / SLO — committed to customer

| # | Item | Status | Owner | Evidence | Target |
|---|------|--------|-------|----------|--------|
| SLO-1 | `test:slo` cron-bound CI check (latency / cost / drift regression) | 🟡 | @observability | Referenced in README; command wiring in `commander-fix-list.md` | 2026-Q4 |
| SLO-2 | Public SLO dashboard (99.5% API success rate, <2s p95 plan latency) | ❌ | @ops | No dashboard committed yet | 2026-Q4 |

### Data governance

| # | Item | Status | Owner | Evidence | Target |
|---|------|--------|-------|----------|--------|
| DATA-1 | GDPR Art 17 right-to-erasure endpoint (function-preserving delete) | ✅ | @compliance | `packages/core/src/storage/dataRetention.ts` (DataRetentionJanitor + auditOnDelete) | 2026-Q3 (delivered) |
| DATA-2 | DPA (Data Processing Agreement) template | ❌ | @legal | Not committed; required for paid EU customer | 2026-Q4 |
| DATA-3 | Encrypted-at-rest storage for memory + audit (provider-side) | 🟡 | @storage | `encryptedSecretsVault` covers API keys; memory + audit rely on storage backend encryption (sqlite/json file-level) | 2026-Q4 |
| DATA-4 | Backup / restore runbook (`dr-backup-restore.md`) | ❌ | @ops | Not started | 2027-Q1 |

---

## P1 — Strong buy signal; not pilot-blocking but pilot-deciding

| # | Item | Status | Owner | Target |
|---|------|--------|-------|--------|
| P1-1 | Async-migrate remaining sync-IO hotspots in `packages/core/src/runtime/` (fileChangeTracker, deadLetterQueue, etc.) | 🟡 | @runtime | 2026-Q4 |
| P1-2 | Decompose `agentRuntime.ts` (4,807 lines, 275+ singleton calls) into per-concern subsystems | 🟡 | @runtime | 2026-Q4 (one subsystem per quarter) |
| P1-3 | Replace placeholder hardcoded zeros in `@commander/sdk` `commanderClient.ts` (queryMemory/getStats) with `getGlobalThreeLayerMemory` lookups | ❌ | @sdk | 2026-Q4 |
| P1-4 | Delete confirmed dead-code modules (`atr/runtimeIntegration.ts`, `_unmounted/*`) | 🟡 | @runtime | 2026-Q4 |
| P1-5 | Multi-language SDK — Python (`packages/python-sdk`) parity with `@commander/sdk` | 🟡 | @sdk | 2026-Q4 |
| P1-6 | Add cost-predictive test:slo guardrails (`max cost per test: $X`) | ❌ | @observability | 2026-Q4 |
| P1-7 | Tier-1 enterprise demo feat: cross-team War Room with shared memory namespaces | 🟡 | @product | 2026-Q4 |

---

## P2 — Cutting-edge features (saleable advantage, not required)

| # | Item | Status | Target |
|---|------|--------|--------|
| P2-1 | RASP extensions G1 hardened across attack surfaces (output sanitizer, network egress filter, plugin scanner) | 🟡 | 2026-Q4 |
| P2-2 | Adversarial-corpus CI gate (`adversarial-corpus.yml`) covering ≥60 attack patterns | ✅ | 2026-Q3 (delivered 2026-06-29) |
| P2-3 | EU AI Act Article 12/13/14 + ISO 42001 + NIST AI RMF compliance reporters | ✅ | 2026-Q3 (delivered) |
| P2-4 | Post-quantum crypto primitive (SHAKE-256, PQ-safe MAC) | ✅ | 2026-Q3 (delivered) |

---

## Tiers-of-evidence — how we publish confidence

| Evidence level | Symbol | What it means |
|---|---|---|
| Wired code + verified | ✅ | The capability exists at the cited file:line and has a test or live runtime caller. Could still have bugs but the surface is real. |
| Interface exists, validation requires customer cooperation | 🟡 | The capability exists but Tier-1 certification requires the customer's own audit to confirm a cooperative component (storage backend, KMS, etc.) is in place. |
| Not implemented / roadmap-only | ❌ | No code, no committed plan. Tracked as a target on this document. |

The CI script `pnpm check:readiness` consumes `docs/status.json` + this document and fails if any ✅ marker is stale (i.e., the cited file:line no longer exists or the count changed without updating this document).

---

## Citation of evidence (release-time audit)

When a release manager moves a 🟡 item to ✅, they MUST:

1. Update `docs/status.json` with the new evidence pointer (commit SHA + file:line).
2. Update this document.
3. Open a PR with `release-readiness` label.
4. Add an entry to `CHANGELOG.md`.

This is the single contract for honest enterprise-grade status reporting.
