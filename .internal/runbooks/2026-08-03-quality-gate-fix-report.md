# Quality Gate Fix Report

Date: 2026-08-03

## Root Cause

The `Security audit` CI step captured `pnpm audit --json` in a shell variable and
passed that complete JSON string as a Node.js positional argument. This coupled
the exception checker to shell quoting and the operating system command-line
length limit. A larger audit response can consequently fail before the policy
is evaluated.

## Changes

- `.github/workflows/ci.yml`: write the audit command's combined output to
  `$RUNNER_TEMP/pnpm-audit.json`, print it for CI diagnostics, grep that file
  for existing transport/API-unavailable cases, and pass only the file path to
  Node for JSON parsing.
- `packages/core/src/security/activeDeceptionSystem.ts`: Prettier-only change.
- `apps/api/src/task1ReadinessProof.ts`: Prettier-only change.
- `apps/web/src/api/actions.test.ts`: Prettier-only change.

Policy semantics remain unchanged:

- npm audit transport/API failures remain warning-only.
- Any parse error, any advisory other than `GHSA-qwww-vcr4-c8h2`, or detected
  React Router unstable RSC wiring fails the job.
- The known React Router advisory passes only when it is the sole advisory and
  the SPA sources have no unstable RSC wiring.

## Verification

- RED check before the patch: the workflow contained
  `node --input-type=module - "$out"`, proving it passed full audit JSON through
  argv.
- Local policy check with the live `pnpm audit --audit-level=high --json`
  output: exit 1 from pnpm, one high advisory
  (`GHSA-qwww-vcr4-c8h2`), and the file-based exception checker passed because
  the SPA has no unstable RSC wiring.
- Local policy check with a synthetic additional high advisory: the checker
  exited non-zero (fail-closed).
- `pnpm exec prettier --write` on only the three CI-reported files, followed
  by CI-glob `prettier --check`.
- `git diff --check`.

## Remaining Uncertainty

The fix has local structural and policy-boundary verification, but cross-OS
confirmation still requires the next GitHub Actions Quality Gates run. This
report is not live C/D proof and makes no such claim.
