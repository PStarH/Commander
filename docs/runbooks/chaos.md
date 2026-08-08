# Chaos Engineering Runbook

## Running Chaos Tests

```bash
# Single layer
npx tsx packages/core/src/cli/commands/chaos.ts --layers=L1 --tenant=ci-staging

# Multiple layers
npx tsx packages/core/src/cli/commands/chaos.ts --layers=L1,L2,L3 --tenant=ci-staging --duration=60

# With recovery verification (default)
npx tsx packages/core/src/cli/commands/chaos.ts --layers=L1,L2 --tenant=ci-staging
```

## Layers

- **L1 (LLM)**: Provider-level fault injection (rate limits, timeouts, etc.)
- **L2 (Tool)**: 10 failure modes (http_5xx, http_4xx, disk_full, oom, process_crash, state_corrupt, dependency_unavailable, time_drift, auth_expired, http_timeout)
- **L3 (System)**: Process/disk/CPU/memory faults
- **L4 (Tenant)**: Multi-tenant blast radius enforcement

## Adding New Scenarios

1. Add fault config to layer module (`l1LlmLayer.ts` / `l2ToolLayer.ts` / `l3SystemLayer.ts` / `l4TenantLayer.ts`)
2. Write test in `tests/chaos/`
3. Add to `ChaosOrchestrator.runLayer()` dispatcher

## Recovery Verification

Every chaos run calls `RecoveryBootstrapper.bootstrap()` after fault injection.
If recovery fails, the run is marked failed in the report.

## Governed Rollback Pilot

The design-partner proof injects named lifecycle faults at
`before_remote_request`, `after_remote_commit`, `before_local_complete`,
`during_outcome_query`, `during_compensation`, and `during_evidence_persist`.
A timeout never authorizes a second write: the operator queries the Kubernetes
marker and revision, then resolves or escalates the durable unknown. Any tenant
isolation failure, digest mismatch, duplicate write, missing receipt, or unknown
older than 5 minutes activates the scoped kill switch and ends the trial.
