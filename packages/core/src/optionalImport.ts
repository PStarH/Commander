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
