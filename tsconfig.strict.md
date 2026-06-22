# `tsconfig.strict.json` — Opt-in Strict Gate Overlay

## Purpose

`tsconfig.strict.json` is an **opt-in extension overlay** for TypeScript
packages that opt into stricter lint-style gates. It is **NOT** applied
to all packages by default.

The four gates it enables:

| Flag                          | Catches                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `noUnusedLocals`              | Unused locals (e.g. dead methods, orphan helpers)              |
| `noUnusedParameters`          | Unused function/method parameters                             |
| `noImplicitReturns`           | Functions that may fall off without returning a value         |
| `noFallthroughCasesInSwitch`  | Switch cases that fall through without an explicit `break`/`return` |

## Why opt-in (not wholesale)

`tsconfig.base.json` is the bottom-line configuration inherited by **all**
packages. A wholesale flip of these gates onto the base would surface
**728 pre-existing TS6133/TS6196 violations** across `packages/core`
(423) and `packages/sdk` (286) — break CI on the first commit.

The overlay pattern lets packages opt in **after** they have completed
their own dead-code cleanup.

## Opt-in recipe (3 steps)

For a package `<pkg>` that is ready to join the strict gate:

```bash
# 1. Bulk-fix all TS6133/TS6196 violations in <pkg>
#    (verify: npx tsc --noEmit -p packages/<pkg>/tsconfig.json returns 0)

# 2. Switch the extends chain to include the overlay:
#    "extends": ["../../tsconfig.base.json", "../../tsconfig.strict.json"]

# 3. Verify CI green and that any new commits keep the gate clean
#    (no new TS6133/TS6196 errors from new code).
```

## Pilot

`packages/plugin-sdk/tsconfig.json` was the first leaf package with a
clean baseline. It was previously inlining the same 4 strict flags; it
now extends this overlay (inversion of the per-package duplication
pattern).

## Maintaining the overlay

`tsconfig.strict.json` declares an exhaustive **DO-NOT-OVERRIDE** list
matching every key set by `tsconfig.base.json`'s `compilerOptions`.
If `tsconfig.base.json`'s `compilerOptions` ever change, regenerate the
list to stay in sync — typically:

```bash
node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('tsconfig.base.json','utf8')); Object.keys(c.compilerOptions||{}).sort().forEach(k=>console.log(k))"
```

## See also

- `tsconfig.base.json` — bottom-line config every package extends.
- `tsconfig.strict.json` — this overlay (mirror of this doc).
- `packages/plugin-sdk/tsconfig.json` — pilot consumer.
- Each `packages/<pkg>/tsconfig.json` — opt-in candidate (must complete
  dead-code cleanup first).
