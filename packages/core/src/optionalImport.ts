/**
 * Shared optional import utility.
 *
 * Attempts to dynamically import a module. If the module is missing or its
 * initialization throws, `null` is returned instead of throwing. This lets
 * optional peer dependencies be loaded without try/catch boilerplate in every
 * consumer.
 *
 * @example
 *   const redis = await optionalImport('redis');
 *   if (redis) { ... }
 */
export async function optionalImport<T = unknown>(moduleName: string): Promise<T | null> {
  try {
    const mod = await import(moduleName);
    return (mod.default ?? mod) as T;
  } catch {
    return null;
  }
}

import { createRequire } from 'node:module';

/**
 * Synchronous variant for modules that have already been loaded/required.
 * Falls back to `require` semantics; returns `null` if the module is missing.
 *
 * Note: packages/core is ESM, so we construct a require function with
 * `module.createRequire` rather than calling the undefined global `require`.
 *
 * **`moduleName` must be a bare specifier** (`pg`, `node:fs`, `@scope/pkg`).
 * `createRequire` resolves *relative* specifiers against **this file's** URL,
 * not the caller's, so `optionalRequire('./sibling')` would resolve against
 * `src/` and fail with `MODULE_NOT_FOUND`. For a relative specifier, bind your
 * own require in the calling module:
 *
 * ```ts
 * import { createRequire } from 'node:module';
 * const nodeRequire = createRequire(import.meta.url);
 * const mod = nodeRequire('./sibling');
 * ```
 *
 * There is deliberately no shared `nodeRequire` export here: a single
 * module-scoped require silently mis-resolves relative specifiers, which is the
 * same class of "looks fine, fails at runtime" defect this module exists to
 * eliminate. Every module binds its own (see the 45 files that already do).
 */
const requireModule = createRequire(import.meta.url);
export function optionalRequire<T = unknown>(moduleName: string): T | null {
  try {
    const mod = requireModule(moduleName);
    return (mod.default ?? mod) as T;
  } catch {
    return null;
  }
}
