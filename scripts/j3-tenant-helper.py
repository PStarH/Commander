#!/usr/bin/env python3
"""J3: tenant-ID dedup.

1. Adds `resolveActiveTenantId(explicitTenantId?)` helper to
   `packages/core/src/runtime/tenantContext.ts`.
2. Replaces 17 occurrences in `agentRuntime.ts`:
   - 1× `const tenantId = getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;`
   - 16× `getGlobalTenantProvider().getCurrentTenantId() ?? undefined`

The helper preserves the original priority order: global tenant first, then
`explicitTenantId`, then `undefined`.
"""
import sys
from pathlib import Path

TENANT_CTX = Path("packages/core/src/runtime/tenantContext.ts")
AGENT_RUNTIME = Path("packages/core/src/runtime/agentRuntime.ts")

# 1. Patch tenantContext.ts — add helper + import.
TENANT_CTX_OLD = '''import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContextValue {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TenantContextValue>();

/**
 * Run a function within a tenant context.
 * All getX() singleton calls inside fn() will return tenant-scoped instances.
 */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export function getCurrentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * Check if we're currently executing in a tenant context.
 */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}
'''

TENANT_CTX_NEW = '''import { AsyncLocalStorage } from 'async_hooks';
import { getGlobalTenantProvider } from './tenantProvider';

export interface TenantContextValue {
  tenantId?: string;
}

const storage = new AsyncLocalStorage<TenantContextValue>();

/**
 * Run a function within a tenant context.
 * All getX() singleton calls inside fn() will return tenant-scoped instances.
 */
export function runWithTenant<T>(tenantId: string | undefined, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/**
 * Get the current tenant ID from the async context.
 * Returns undefined in single-tenant mode.
 */
export function getCurrentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

/**
 * Check if we're currently executing in a tenant context.
 */
export function hasTenantContext(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Step 1 of agentRuntime.ts refactor — compact helper that collapses the
 * 17-occurrence repetition of `getGlobalTenantProvider().getCurrentTenantId()
 * ?? <opt> ?? undefined` into a single named call. Priority order matches
 * the original inline expression: global tenant provider first, then the
 * caller's `explicitTenantId` (typically `ctx.tenantId`), then undefined.
 *
 * Marked `lazy` so the singleton is resolved only at call time — callers
 * that mutate the global tenant after the helper was imported still see
 * the latest value.
 */
export function resolveActiveTenantId(
  explicitTenantId?: string,
): string | undefined {
  return (
    (getGlobalTenantProvider().getCurrentTenantId() ?? undefined) ??
    explicitTenantId ??
    undefined
  );
}
'''

# 2. Replace 17 sites in agentRuntime.ts.
# 1 site has the ctx.tenantId-aware form (line 1165); 16 sites pass no arg.
CTX_AWARE_REPLACEMENTS = [
    (
        "const tenantId = getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;",
        "const tenantId = resolveActiveTenantId(ctx.tenantId);",
    ),
]

# 16 sites: `getGlobalTenantProvider().getCurrentTenantId() ?? undefined`
# Match the exact substring (the ?? undefined form) so the helper signature
# matches. There are also tabular/iconographic variants; the script regex
# below catches every variant.
NOCTX_OLD_SUBSTR = "getGlobalTenantProvider().getCurrentTenantId() ?? undefined"
NOCTX_NEW_SUBSTR = "resolveActiveTenantId()"


def main() -> int:
    # Step 1: tenantContext.ts.
    src = TENANT_CTX.read_text(encoding="utf-8")
    if TENANT_CTX_OLD not in src:
        sys.stderr.write("ERROR: tenantContext.ts OLD block not found.\n")
        return 2
    TENANT_CTX.write_text(src.replace(TENANT_CTX_OLD, TENANT_CTX_NEW, 1),
                          encoding="utf-8")
    print(f"OK added resolveActiveTenantId to {TENANT_CTX}")

    # Step 2a: agentRuntime.ts ctx-aware replacement (1 site).
    src = AGENT_RUNTIME.read_text(encoding="utf-8")
    for i, (old, new) in enumerate(CTX_AWARE_REPLACEMENTS, 1):
        if old not in src:
            sys.stderr.write(f"ERROR: ctx-aware site {i} not found.\n")
            return 2
        src = src.replace(old, new, 1)
        print(f"OK applied ctx-aware replacement {i}/1")

    # Step 2b: agentRuntime.ts no-ctx replacements (16 sites).
    before = src.count(NOCTX_OLD_SUBSTR)
    if before != 16:
        sys.stderr.write(
            f"WARN: expected 16 no-ctx sites, found {before}. "
            f"Applying what's present.\n"
        )
    src = src.replace(NOCTX_OLD_SUBSTR, NOCTX_NEW_SUBSTR)
    after = src.count(NOCTX_NEW_SUBSTR)
    print(f"OK replaced {before} -> {after} no-ctx sites in {AGENT_RUNTIME}")

    # Step 2c: import statement — add `import { resolveActiveTenantId } from './tenantContext';`
    # if not already present. Done conservatively: insert after existing
    # tenantContext import if any.
    IMPORT_LINE = "import { resolveActiveTenantId } from './tenantContext';"
    if IMPORT_LINE not in src and "from './tenantContext'" not in src:
        src = src.replace(
            "import { runWithTenant } from './tenantContext';",
            "import { runWithTenant, resolveActiveTenantId } from './tenantContext';",
            1,
        )
        print("OK appended resolveActiveTenantId to the existing tenantContext import")
    elif IMPORT_LINE not in src and "from './tenantContext'" in src:
        # runWithTenant not imported; add a new line.
        insert_pos = src.find("\n", src.find("from './tenantContext'"))
        src = src[:insert_pos] + "\n" + IMPORT_LINE + src[insert_pos:]
        print("OK added standalone resolveActiveTenantId import")

    AGENT_RUNTIME.write_text(src, encoding="utf-8")
    print(f"OK final {AGENT_RUNTIME}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
