# C/D Continuation 2 Verification

Date: 2026-08-03
Branch: `codex/cd-live-proof`

## Changes

- PostgreSQL worker-plane E2E now uses a real `commander_app` login and a separate
  `commander_tenant_authority` login. The test seeds and removes its temporary
  authority/worker tenant rows and closes all pools in `finally`.
- Exported the existing `PostgresTenantContextAuthority` from the kernel package
  entrypoint so the E2E exercises the public runtime API.
- Restored the PostgreSQL enforced-authority repository contract suite (19 cases)
  with real app, worker, scheduler, adapter-ops, and tenant-authority credentials.
  Contract cases are serial because they reuse stable fixture IDs and reset shared
  PostgreSQL tables between cases.
- Tightened the pnpm audit transport exception so a bare `410` in arbitrary output
  cannot be treated as endpoint retirement; the web source scan remains recursive.

## Verification

Using a local PostgreSQL 16 service with real role logins:

```text
worker-plane gateway-kernel-worker.e2e.test.ts: 3 passed, 0 failed
Postgres enforced-authority repository contract: 19 passed, 0 failed
PostgresKernelRepository integration: 7 passed, 0 failed
Combined kernel integration file: 26 passed, 0 failed
ci-audit-policy.test.ts: 5 passed, 0 failed
worker-plane typecheck: passed
Prettier checks for changed TypeScript files: passed
git diff --check: passed
```

The latest protected CI run before this continuation passed C6 and failed the
worker-plane E2E at the old legacy tenant-scope setup. The next CI run must verify
the new app-context path on GitHub's clean PostgreSQL service.

## Evidence Ceiling

This is local/CI contract and integration evidence (`ENFORCED` for the exercised
paths). It does not create retained Kind, real-provider, backup/restore, rotation,
or customer-environment evidence. C and D therefore remain below `PROVEN` until
those required external artifacts exist under `.internal/evidence/`.
