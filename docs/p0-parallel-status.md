# P0 Parallel Status — V2 Kernel E2E Closure

**Branch:** `p0/v2-kernel-e2e-closure`  
**Base checkpoint:** `baseline/arch-v2-checkpoint-2026-07-14`  
**Updated:** 2026-07-15

## Goal (single north star)

Under kernel-on (auto or `COMMANDER_KERNEL_ENABLED=1`) + real Postgres:

1. `POST /v1/runs` accepts work
2. Worker claims with **workerGeneration fencing**
3. Run reaches a **terminal** state
4. Kill worker → **reclaim without double execution**

## Ownership locks

| Owner                       | Owns                                                                                                                                                                                                                     | Must not touch                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code (expensive)** | `packages/kernel/**`, `packages/worker-plane/**`, `packages/effect-broker/**`, minimal `packages/contracts/**`, `packages/core/src/runtime/kernelStepExecutor.ts`, `apps/api/src/v1Gateway*.ts` (step/run contract only) | `apps/web/**`, IM plugins, new benchmarks, long audit docs, `docker-compose*`, `helm/**`, `.github/workflows/**`, large `agentRuntime.ts` rewrite |
| **Sisyphus (this agent)**   | compose/helm wiring, CI/scripts, ESM/dist smoke, residual cleanup, this status page                                                                                                                                      | kernel claim fencing semantics, effect token crypto design                                                                                        |

## Done (Sisyphus — independent, no coordination wait)

| Item                                  | Evidence                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Pre-P0 cleanup commit                 | `03b0a3f1` drop dead `@commander/orchestration` + unused stores                                           |
| Pre-P0 test harden commit             | `667afb75` biscuit/webhook/IM/SAML coverage                                                               |
| P0 branch created                     | `p0/v2-kernel-e2e-closure`                                                                                |
| Compose `v2` profile                  | `docker-compose.yml` postgres/worker/timer/outbox on `v2`                                                 |
| Kernel-on override                    | `docker-compose.v2.yml`                                                                                   |
| Prod kernel default                   | `docker-compose.prod.yml` `:-1`; process auto-on via `isCommanderKernelEnabled` (prod/DSN/V2)             |
| Default compose no longer forces off  | `docker-compose.yml` leaves `COMMANDER_KERNEL_ENABLED` unset (auto); explicit `=0` non-prod only          |
| Enablement matrix unit tests          | `apps/api/test/kernelEnabled.test.ts`                                                                     |
| E2E scaffold                          | `scripts/p0-kernel-e2e.ts` + `pnpm p0:kernel-e2e`                                                         |
| Kernel fencing already in PG path     | `packages/kernel/src/postgres.ts` claim/heartbeat/complete/fail bind `workerGeneration` + live worker row |
| Worker passes generation              | `packages/worker-plane/src/workerService.ts` claim uses `this.worker.generation`                          |
| Real PG e2e (mock LLM)                | `packages/worker-plane/src/e2e/gateway-kernel-worker.e2e.test.ts` — SUCCEEDED + outbox                    |
| Kill/reclaim dual-worker on PG        | same e2e file — expired lease reclaim + zombie complete rejected                                          |
| Fixed ESM `require` in PG integration | `packages/kernel/src/postgres.integration.test.ts` uses `import { Pool } from 'pg'`                       |
| Local proof DSN                       | ephemeral `commander-p0-pg` on `127.0.0.1:5433`                                                           |
| Full loop harness                     | `pnpm p0:full-loop` → Gateway dist + mock worker → `SUCCEEDED`                                            |
| CI gates                              | `.github/workflows/p0-kernel-e2e.yml` + expanded `ci.yml` `kernel-postgres-integration`                   |

## CI

```bash
# Local equivalent of CI:
export DATABASE_URL=postgres://commander:commander@127.0.0.1:5433/commander
export COMMANDER_KERNEL_DATABASE_URL=$DATABASE_URL
pnpm --filter @commander/contracts build
pnpm --filter @commander/kernel build
pnpm --filter @commander/core build
pnpm --filter @commander/worker-plane build
pnpm --filter @commander/api build
pnpm exec tsx --test packages/kernel/src/postgres.integration.test.ts
pnpm exec tsx --test packages/worker-plane/src/e2e/gateway-kernel-worker.e2e.test.ts
pnpm p0:full-loop
```

Workflow triggers: push to `p0/**` / `master` / `main`, PRs to master/main, and `workflow_dispatch`.

## Phase status (2026-07-14 closeout)

**P0 phase = CLOSED for merge consideration** (proof harness + CI gates + audit harden).

| Gate                                          | Status                                          |
| --------------------------------------------- | ----------------------------------------------- |
| Kernel generation fencing (PG)                | Proven (code + integration)                     |
| Worker execute → SUCCEEDED (mock LLM)         | Proven (`pnpm p0:full-loop`)                    |
| Lease reclaim / zombie dual-complete rejected | Proven (e2e)                                    |
| API dist boots + accepts `/v1/runs`           | Proven                                          |
| CI workflows                                  | Added (`p0-kernel-e2e.yml` + expanded `ci.yml`) |
| Compose v2 config                             | Valid (`config -q`)                             |
| Full multi-image `docker:v2` build            | **Not** required for P0 close — Phase-2         |

### Audit harden applied (`c0b549c1`)

- Await `registerBuiltinPlugins` before `listen` (no IM race)
- E2E uses `--test-force-exit` (no `process.exit(0)` masking)
- Mock provider typed as `LLMProvider` (no `as never`)
- Observability unload always resets started singletons
- CI builds `@commander/effect-broker` before worker-plane

### Stashed (not in P0)

`stash@{0}: wip: parallel plugin/IM expansion outside P0 closeout` — restore only for a **separate** PR.

## Remaining gaps (Phase-2+, not P0 blockers)

- [ ] Full compose stack (`pnpm docker:v2`) multi-container image build
- [x] API `dist` Node ESM start smoke
- [x] Full Gateway + mock worker terminal loop
- [x] Effect broker **admission-time** force for external effects (worker bootstrap deny-default; `COMMANDER_WORKER_EFFECT_POLICY=permit` opt-in)
- [ ] InMemory kernel does not simulate worker-registry generation rollover (PG path does)
- [ ] Production worker bootstrap with real LLM providers (p0 uses scripts/p0-worker-bootstrap.ts mock)
- [x] Dedicated P0 Kernel E2E workflow green on branch (e.g. Actions 29338185230 / 29338183221)
- [ ] Monorepo Quality Gates (`Run core tests`) green — tracked as C in release loop; kernel jobs already green

### API smoke env that worked (local)

```bash
export NODE_ENV=production PORT=4011
export TENANT_API_KEYS='tenant-local:smoke-key-12345678'
export API_KEYS='smoke-key-12345678'
export COMMANDER_MASTER_KEY=... JWT_SECRET=...
export COMMANDER_CAPABILITY_TOKEN_KEY=... COMMANDER_INTEGRITY_KEY=...
export COMMANDER_KERNEL_ENABLED=1
export DATABASE_URL=postgres://commander:commander@127.0.0.1:5433/commander
export COMMANDER_KERNEL_DATABASE_URL=$DATABASE_URL
export COMMANDER_DEFAULT_POLICY_SNAPSHOT_ID=policy-default-v1
export API_STORE_BACKEND=memory
node apps/api/dist/index.js
# POST /v1/runs with x-api-key: smoke-key-12345678 → 202 PENDING
```

Note: Gateway already defaults agent steps with `agentId` / `definitionVersion` / `providerSnapshot` when `steps` omitted.

## Start stack (wiring)

```bash
export COMMANDER_API_KEY="$(openssl rand -hex 32)"
docker compose -f docker-compose.yml -f docker-compose.v2.yml --profile v2 up -d --build
pnpm p0:kernel-e2e
# Strict live-stack terminal observation (package e2e already prove fencing):
P0_REQUIRE_TERMINAL=1 pnpm p0:kernel-e2e
```

## Status notes (branch p0/v2-kernel-e2e-closure)

- Kernel fencing / kill-reclaim / terminal worker path: enforced by package e2e + `pnpm p0:full-loop` + P0 Kernel E2E workflow (not this soft probe alone).
- Remaining: monorepo Quality Gates (`Run core tests`), effect-broker admission-time force, production worker bootstrap with real LLMs.
- Historical C1/C2 handoff brief retired — ownership is this branch's release loop, not an open dual-agent assignment.

## Merge order

1. Land core-test / claim-hygiene fixes on `p0/v2-kernel-e2e-closure`
2. Confirm monorepo Quality Gates green
3. Tighten `p0-kernel-e2e` assertions (`P0_REQUIRE_TERMINAL=1` becomes default in CI later)
