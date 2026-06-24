#!/usr/bin/env node
/**
 * scripts/check-strict-overlay.mjs
 *
 * CI invariant: fails when the `@strict-list:` sentinel in
 * tsconfig.strict.json drifts from the actual compilerOptions keys in
 * tsconfig.base.json. The sentinel is a single structured comment line
 * of the form:
 *
 *     // @strict-list: target, module, ..., declaration
 *
 * It is the canonical source of truth for the DO-NOT-OVERRIDE list.
 *
 * Exit codes:
 *   0  parity holds (every base key claimed, no overclaim)
 *   1  parity drift
 *   2  structural error (sentinel not found)
 */
import fs from 'node:fs';

const root = new URL('..', import.meta.url).pathname;

const baseKeys = Object.keys(
  JSON.parse(fs.readFileSync(`${root}tsconfig.base.json`, 'utf8')).compilerOptions || {},
).sort();

const strictRaw = fs.readFileSync(`${root}tsconfig.strict.json`, 'utf8');
const sentinelMatch = strictRaw.match(/\/\/\s*@strict-list:\s*([^\n]+)/);
if (!sentinelMatch) {
  console.error('❌ tsconfig.strict.json: missing or malformed `// @strict-list: <keys>` sentinel');
  console.error('   tried pattern: /\\/\\/\\s*@strict-list:\\s*([^\\n]+)/');
  console.error(
    '   add a single sentinel line, e.g.:  // @strict-list: target, module, ..., declaration',
  );
  process.exit(2);
}

// Split on comma, trim, lowercase, dedupe, drop empties.
const claimTokens = [
  ...new Set(
    sentinelMatch[1]
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
].sort();

// Precompute lowercase base-key Set for O(1) lookup.
const baseKeysLower = new Set(baseKeys.map((k) => k.toLowerCase()));
const claimBaseKeys = baseKeys.filter((k) =>
  baseKeysLower.has(k.toLowerCase()) === false ? false : baseKeysLower.has(k.toLowerCase()),
);

const missing = baseKeys.filter((k) => !claimBaseKeys.includes(k));
const overclaim = claimBaseKeys.filter((k) => !baseKeys.includes(k));

if (missing.length === 0 && overclaim.length === 0) {
  console.log(
    `✅ tsconfig.strict.json DO-NOT-OVERRIDE parity: ${baseKeys.length}/${baseKeys.length} base keys claimed, zero overclaim.`,
  );
  process.exit(0);
}

console.error('❌ tsconfig.strict.json DO-NOT-OVERRIDE parity FAILED:');
if (missing.length > 0) {
  console.error(`   base keys NOT claimed: ${missing.join(', ')}`);
}
if (overclaim.length > 0) {
  console.error(`   overlay claims NOT in base: ${overclaim.join(', ')}`);
}
console.error('\nTo regenerate the list from base:');
console.error(
  "  node -e \"const c=require('./tsconfig.base.json');console.log(Object.keys(c.compilerOptions).sort().join(', '))\"",
);
process.exit(1);
