# Shadow Phase A Review Important Fixes Report

## Scope

Resolved the two Important findings against `f876be861b8380806b6477e374e456688af32f24`:

- Ingestion now relies on the existing campaign advisory lock and constrained
  security-definer functions, without application-side `SELECT ... FOR UPDATE` queries.
- The dependency guard now records resolved manifest identities per edge, visits those
  identities, and includes optional dependencies and peers when they are installed.
  Name-keyed manifest maps without resolved edges retain their existing behavior.

## RED Evidence

The controller recorded both RED states before the production changes, as required by
the handoff.

1. `PATH=/Users/sampan/.nvm/versions/node/v22.22.0/bin:$PATH pnpm exec node --import tsx --test scripts/shadow-dependency-guard.test.ts`
   - RED: the installed optional-peer assertion failed because optional peers were
     excluded from the graph. The distinct-resolved-version assertion also required
     traversal by resolved manifest identity rather than package name.
2. `PATH=/Users/sampan/.nvm/versions/node/v22.22.0/bin:$PATH pnpm --filter @commander/shadow-plane exec node --import tsx --test src/repository.test.ts`
   - RED: the new ingestion privilege contract failed before the preserved repository
     patch removed application-side `FOR UPDATE` queries. The current worktree already
     contained that repository production change when this implementation resumed.

## Implementation

- `packages/shadow-plane/src/repository.ts` removes row-locking reads only from
  `importObservation` and `closeDueBatch`; campaign advisory locking remains. Retention
  and withdrawal code is unchanged.
- `scripts/shadow-dependency-guard.ts` resolves each installed dependency manifest from
  its declaring package, stores the resolved identity in `resolvedDependencies`, and
  validates using identity keys while retaining package names in issue paths. Optional
  dependency and optional-peer edges are skipped only when no manifest resolves.
- The preserved contract tests cover the no-`FOR UPDATE` ingestion behavior, installed
  optional peers, and divergent closures for two installed package versions.

## GREEN Verification

All commands used Node 22 from
`/Users/sampan/.nvm/versions/node/v22.22.0/bin`.

| Command | Result |
| --- | --- |
| `pnpm exec node --import tsx --test scripts/shadow-dependency-guard.test.ts` | 2/2 tests passed |
| `pnpm --filter @commander/shadow-plane exec node --import tsx --test src/repository.test.ts` | 25/25 tests passed |
| `pnpm --dir packages/core exec vitest run tests/architecture/shadow-replay-removal.test.ts` | 4/4 tests passed |
| `pnpm --filter @commander/shadow-plane test` | 59/59 tests passed |
| `pnpm exec node --import tsx --test scripts/shadow-phase-a-gate.test.ts scripts/shadow-customer-pack.test.ts scripts/shadow-dependency-guard.test.ts` | 17/17 tests passed |
| `pnpm --filter @commander/shadow-plane typecheck` | passed |
| `pnpm --filter @commander/contracts typecheck` | passed |
| `pnpm --filter @commander/postgres-runtime typecheck` | passed |
| `pnpm --filter @commander/contracts build` | passed |
| `pnpm --filter @commander/postgres-runtime build` | passed |
| `pnpm --filter @commander/shadow-plane build` | passed |

Formatting and `git diff --check` were rerun after this report was written and before
the commit.

## Files Changed

- `packages/shadow-plane/src/repository.ts`
- `packages/shadow-plane/src/repository.test.ts`
- `scripts/shadow-dependency-guard.ts`
- `scripts/shadow-dependency-guard.test.ts`
- `.superpowers/sdd/shadow-review-important-fixes-report.md`

## Self-Review

- The explicit Shadow and PostgreSQL allowlists are unchanged.
- The loader uses real paths as node keys, so different installed versions cannot
  suppress one another's closures.
- Human-readable issue paths remain package names, not filesystem paths.
- Ingestion retains no direct table mutation authority and no application-side row lock;
  database functions continue to own internal transition locking and validation.

## Concerns

No product-code concerns. Docker, Kind, and PostgreSQL/live suites were not run by
design, per the handoff constraints.
