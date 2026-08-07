# C6 Dual-Process Race Fix

Date: 2026-08-03

## Root Cause

The C6 script waited for the kernel publisher to mark compensation-topic
outbox rows as published. The enforced authority deliberately excludes that
topic from the kernel publisher; only an authenticated `commander_adapter_ops`
worker may claim and finalize governed compensation requests. The consumer
worker was also looking up a worker id different from the id returned by the
registration RPC, so it could not claim any request.

## Change

- Seed governed compensation requests through the app tenant-context and
  persisted authorization path.
- Register a real compensation worker through the adapter-ops RPC and pass its
  generation/claim secret to a separate consumer process.
- Keep the owner publisher process on ordinary `kernel.effect.completed` noise
  rows, while the adapter process claims and fail-closed escalates governed
  compensation rows.
- Assert ordinary publisher progress, all compensation rows finalized, and
  zero WS2 compensation deliveries. Scope cleanup to the generated tenant and
  delete finalization receipts before dependent rows.

## Verification

With a clean PostgreSQL 16 instance bootstrapped using the CI role and closure
migrations:

```text
pnpm exec tsx scripts/l4-b-compensation-dual-process-race.ts -- --seed=16
PASS: publishedCount=16, compensationPublishedCount=16,
      consumerClaims=16, ws2CompensationDeliveries=0, publisherSteals=0
```

Prettier and `git diff --check` also pass. GitHub CI rerun is required for
retained remote proof.
