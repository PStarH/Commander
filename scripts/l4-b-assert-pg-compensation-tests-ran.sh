#!/usr/bin/env bash
# Fail-closed: PG compensation integration tests must run (not skip) under CI.
# Spec: 2026-07-20-to100-w2-compensation-spec.md §3.2 / §6.1
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${DATABASE_URL:-}" && -z "${COMMANDER_KERNEL_DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL or COMMANDER_KERNEL_DATABASE_URL required" >&2
  exit 1
fi

out="$(
  pnpm exec tsx --test --test-concurrency=1 \
    packages/kernel/src/postgres.ops.integration.test.ts \
    packages/kernel/src/ops/outbox/compensationPublisherRace.postgres.integration.test.ts \
    2>&1
)"
printf '%s\n' "$out"

if ! printf '%s\n' "$out" | rg -q '# skipped 0'; then
  echo "ERROR: expected '# skipped 0' in Node test summary (PG tests must not skip)" >&2
  exit 1
fi

if ! printf '%s\n' "$out" | rg -q '# pass [1-9]'; then
  echo "ERROR: expected at least one passing test ('# pass N' with N>=1)" >&2
  exit 1
fi

echo "OK: PG compensation tests ran with # skipped 0"
