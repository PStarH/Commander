# Commander Test Inventory

This repo keeps two test runners because the runtime suite contains both
`node:test` files and Vitest files. The split is acceptable only if CI proves
that no test file is silently omitted.

Run the inventory gate from a clean checkout:

```bash
cd packages/core
pnpm test:inventory
```

The gate verifies:

- every `*.test.ts` file under `tests/` or `benchmarks/` declares either
  `node:test` or `vitest`
- every Vitest test file is listed in `vitest.config.ts`
- no stale Vitest config entry points at a missing file

The full core gate is:

```bash
git status --short
cd packages/core
pnpm test:inventory
pnpm test
npx tsc --noEmit
```

For audit packets, capture the machine-readable inventory:

```bash
cd packages/core
node scripts/test-inventory.mjs --json > ../../docs/test-inventory-current.json
```
