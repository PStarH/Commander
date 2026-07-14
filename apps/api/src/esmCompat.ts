/**
 * ESM compatibility helpers for source files that still reference CommonJS
 * globals such as `__dirname` and `require`. Import these at the top of a
 * module and bind them to local constants.
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function getDirname(metaUrl: string): string {
  return fileURLToPath(new URL('.', metaUrl));
}

export function getRequire(metaUrl: string) {
  return createRequire(metaUrl);
}
