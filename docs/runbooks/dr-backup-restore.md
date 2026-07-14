# Disaster Recovery — Backup & Point-in-Time Restore

Architecture V2 operational runbook for Commander kernel + control-plane data.

## What to back up

| Asset | Default location | Notes |
|---|---|---|
| ATR RunLedger | `.commander/atr_ledger.db` (+ `-wal`/`-shm`) | Source of truth for run state / actions |
| State checkpoints | `.commander_state/` | Agent-loop snapshots |
| Event sourcing WAL | configured OTel / event store path | Replay / audit |
| Memory stores | `.commander_memory/` or Postgres | Tenant-scoped |
| Secrets vault | encrypted vault file | Never back up plaintext keys |
| API store | sqlite/postgres per `API_STORE_BACKEND` | War Room / projects |

## Backup (SQLite)

```bash
# Consistent online backup via SQLite backup API / .backup
sqlite3 .commander/atr_ledger.db ".backup '.commander/backups/atr_ledger-$(date -u +%Y%m%dT%H%M%SZ).db'"

# Checkpoint directories (quiesce workers first for crash-consistent copy)
tar -czf ".commander/backups/state-$(date -u +%Y%m%dT%H%M%SZ).tgz" .commander_state .commander_memory
```

## Backup (Postgres)

Use continuous archiving (WAL) + base backups. Retain enough WAL for the
enterprise RPO (recommended ≤ 15 minutes for regulated pilots).

```bash
pg_basebackup -D /backup/commander-base -Fp -Xs -P
# Ensure archive_command / PITR is configured on the primary.
```

## Restore procedure

1. Stop workers and Gateway (`kubectl scale` / `docker compose stop`).
2. Restore ledger DB (or Postgres PITR to target timestamp).
3. Restore checkpoint + memory artifacts matching the same cut.
4. Start Gateway, then scheduler/workers.
5. Run `RecoveryBootstrapper` (automatic on boot) and verify:
   - No unexpected ABORTED zombies that should have been PAUSED.
   - `claimRunnableRun` only wakes eligible `resume_at` rows.
6. Record restore in the audit chain / incident ticket.

## Verification checklist

- [ ] `GET /health` and `GET /readyz` green
- [ ] Sample run resume from `waiting_for_human` succeeds
- [ ] Cross-tenant fuzz / isolation smoke passes
- [ ] OTel traces resume with prior `traceId` correlation where applicable

## RPO / RTO targets (enterprise default)

- RPO: 15 minutes (WAL / frequent SQLite backup)
- RTO: 1 hour (documented restore + bootstrap)

Adjust per customer contract; never claim stronger numbers without drill evidence.

---

## Edge state (per-replica) DR — REL-14

The kernel Postgres PITR above covers the **shared, durable** run/step/effect/event
state. It does **not** cover **edge state**: files a replica writes to its own
local disk (mostly under `.commander/`, `.commander_state/`, `.commander_memory/`,
`.omo/`). These are per-replica and are **not** replicated, so **loss of a
single replica's disk loses any edge-only state written since the last backup.**
The governing rule for V2:

> **Correctness-critical state must live in the Postgres kernel, not at the edge.**
> Edge SQLite/JSON is either a cache (safe to lose) or a legacy single-process
> fallback that must not be the source of truth in a multi-replica deployment.

### Edge-state inventory & classification

| Path (default) | Class | On disk loss | Backup needed? |
|---|---|---|---|
| `.commander/otel_queue/`, `.commander/repl_history`, `*cache*`, `.commander/shadow/` | **Ephemeral** | Regenerated / re-emitted | No |
| `.commander/settings.json`, `.commander/execpolicy.json`, `.commander/locales/`, `.commander/skills/`, `.commander/plugins/` | **Config** | Redeploy from git / IaC | No (in VCS) |
| `.commander/api_keys.json`, `.commander/auth.json`, secrets vault | **Secrets** | Re-provision from secret manager | No — never back up plaintext |
| `.commander/audit/user-actions.ndjson`, `.commander/security/*.ndjson`, `.commander/gdpr-erasures.ndjson` | **Audit (append-only)** | Gap in local audit trail | Yes — ship to central log/WORM continuously |
| `.commander_state/` (checkpoints), `.commander_memory/`, `.commander/memory*.db`, `.commander/conversations.db` | **Durable-if-edge-only** | In-flight run / memory loss **unless kernel-backed** | Yes, **or** move to Postgres/shared backend |
| `.commander/atr_*.db` (`atr_ledger`, `atr_leases`, `atr_idempotency`, `atr_checkpoints`), `.commander/task_queue.db`, `state_checkpoints.db` | **Durable-if-edge-only** | Split-brain / lost run + effect idempotency | Yes, **or** run V2 kernel (`COMMANDER_KERNEL_ENABLED=1`) so these are not authoritative |
| `COMMANDER_INTERACTION_DB` (HITL approvals) | **Durable-critical** | Pending approvals lost | **Must** be a real path/Postgres in prod (never `:memory:`) — see GOV-13 |

### Edge RPO

- **Kernel-backed deployment (recommended):** edge stores are caches; the
  authoritative copy is in Postgres. **Edge RPO for correctness-critical data = 0**
  (nothing authoritative is lost with a replica; it rebuilds from the kernel on boot).
- **Legacy/edge-authoritative deployment:** edge RPO = your edge backup interval.
  For any store in the "Durable-if-edge-only" rows, a replica disk loss loses all
  writes since the last `.backup`/`tar`. This configuration is **not recommended**
  for multi-replica production.

### Pre-conditions to achieve Edge RPO = 0

- `COMMANDER_KERNEL_ENABLED=1` and `COMMANDER_KERNEL_DATABASE_URL` set (durable runs/effects).
- `COMMANDER_INTERACTION_DB` points to a file/Postgres path, not `:memory:` (GOV-13).
- A real signing key is set (`COMMANDER_POLICY_SIGNING_KEY` or `COMMANDER_POLICY_ED25519_*`)
  so signatures verify across replicas after a restore (MCP-13).
- Audit NDJSON is forwarded to a central sink continuously (SIEM/WORM), so a replica
  loss does not create an audit gap.
- Treat replica local disk as **ephemeral**: no store under `.commander/` is the
  sole copy of correctness-critical data.

### Edge recovery procedure

1. Ephemeral/config/secrets: nothing to restore — the replacement replica
   redeploys config from IaC and re-provisions secrets; caches warm on first use.
2. Kernel-backed durable state: none to restore at the edge — the new replica
   reads runs/effects from Postgres and resumes via `RecoveryBootstrapper`.
3. Edge-authoritative durable state (legacy only): restore the SQLite/JSON files
   from the matching backup cut (§Restore procedure), then boot.
4. Verify per the checklist above, plus: pending HITL approvals are queryable and
   no run is stuck waiting on an approval that lived only on the lost disk.

### Drill

Extend the kernel DR drill (`packages/kernel/src/disasterRecovery.ts`) with an
edge-loss scenario: kill a replica, delete its `.commander/` volume, start a
fresh replica, and assert that (a) in-flight runs resume from the kernel, (b) no
duplicate external effects execute (kernel idempotency), and (c) no pending
approval is lost. Record the measured edge RPO/RTO; never claim 0 without this
drill passing.

