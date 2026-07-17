/**
 * L3-05 — One Run Authority architecture gates.
 *
 * Ensures WarRoomStore / ATR RunLedger cannot silently become /v1 run authority.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const API_SRC = join(ROOT, 'apps/api/src');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

describe('L3-05 one run authority invariants', () => {
  it('v2-migration-guide declares kernel as /v1 authority and WarRoom as demoted', () => {
    const doc = read('docs/v2-migration-guide.md');
    assert.match(doc, /POST\/GET \/v1\/runs\*/);
    assert.match(doc, /KERNEL_UNAVAILABLE/);
    assert.match(doc, /War Room missions.*Demoted.*not the durable run authority/s);
  });

  it('RunLedger module declares it is not the /v1 durable run authority', () => {
    const src = read('packages/core/src/atr/runLedger.ts');
    assert.match(
      src,
      /not the \/v1 durable run authority|non-`\/v1`|settlement/i,
      'RunLedger header must demote itself from /v1 authority',
    );
  });

  it('WarRoomStore factory declares missions/UI-only role', () => {
    const src = read('apps/api/src/store.ts');
    assert.match(src, /missions\/UI store only/);
    assert.match(src, /not the \/v1 durable run authority/);
  });

  it('apps/api has no RunLedger import anywhere under src/', () => {
    for (const file of walkTsFiles(API_SRC)) {
      const src = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        src,
        /\bRunLedger\b|\brunLedger\b/,
        `${file} must not reference ATR RunLedger`,
      );
    }
  });

  it('v1 gateway source files never import ./store', () => {
    for (const file of ['v1GatewayEndpoints.ts', 'v1GatewayKernel.ts']) {
      const src = read(`apps/api/src/${file}`);
      assert.doesNotMatch(src, /from\s+['"]\.\/store/);
    }
  });

  it('PRINCIPLES §2 records no WarRoomStore fallback for /v1', () => {
    const doc = read('PRINCIPLES.md');
    assert.match(doc, /Missing kernel → HTTP 503 `KERNEL_UNAVAILABLE` — no WarRoomStore fallback/);
  });
});
