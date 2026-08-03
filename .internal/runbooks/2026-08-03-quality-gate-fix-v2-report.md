# Quality Gate Fix V2 Report

Date: 2026-08-03

## Review Findings Addressed

1. The workflow used an unanchored grep for `410` and generic transport words
   across the complete audit output. A valid advisory JSON document could
   contain the same text and be incorrectly allowed.
2. The React Router exception was initially checked against only two entry
   files, leaving nested source files and several RSC-specific imports outside
   the decision boundary.

## Change

- Added `scripts/ci-audit-policy.ts` and an executable node:test regression
  fixture at `scripts/ci-audit-policy.test.ts`.
- The policy parses valid JSON first. It allows transport/API unavailability
  only for invalid JSON that matches a strict pnpm error code plus a known
  retirement (`ERR_PNPM_AUDIT_BAD_RESPONSE` plus `410` or retirement message)
  or transient network shape (`ERR_PNPM_META_FETCH_FAIL` / `ERR_PNPM_FETCH_*`
  plus `ECONNRESET`, `ETIMEDOUT`, or `fetch failed`). All other output fails
  closed.
- The known advisory exception now recursively scans all JS/TS source files
  under `apps/web/src` for React Router RSC names and RSC imports.
- `ci.yml` writes audit output to `$RUNNER_TEMP` as before and delegates only
  the policy decision to the tested script. Quality Gates runs the regression
  fixture on every selected matrix entry.

## Verification

- RED: `ci-audit-policy.test.ts` initially failed with
  `Cannot find module './ci-audit-policy.ts'`.
- GREEN: the fixture verifies valid JSON containing an unrelated advisory with
  `410` text fails closed, a recognized pnpm retirement error is allowed, a
  nested `RSCHydratedRouter` source causes rejection, and the sole known
  advisory without RSC wiring is allowed.
- Ran the fixture through `pnpm exec node --import tsx --test`.
- Ran the policy CLI against the live local `pnpm audit --json` output.
- Ran `tsc --noEmit` with the repository's `.ts` test-import setting
  (`allowImportingTsExtensions`), Bash syntax checking, Prettier checks, and
  `git diff --check`.

## Remaining Uncertainty

Cross-platform GitHub Actions execution remains pending. This change is CI
policy verification only and is not C/D live proof.
