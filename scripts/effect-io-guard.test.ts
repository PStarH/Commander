import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanEffectIo } from './effect-io-guard.js';
import { FIXED_ACTION_ADAPTER_MANIFESTS } from '../packages/contracts/src/actionAdapters.js';

describe('effect-io-guard', () => {
  it('baseline exceptions count matches config', () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'config/effect-io-exceptions.json'), 'utf-8'));
    assert.equal(config.exceptions.length, config.baselineCount);
  });

  it('registered adapter manifests have effectType', () => {
    for (const m of FIXED_ACTION_ADAPTER_MANIFESTS) {
      assert.ok(m.effectType, `${m.adapterId} effectType`);
    }
  });

  it('passes on current baseline', () => {
    const errors = scanEffectIo();
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('flags new fetch bypass outside baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-audit-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(join(root, 'config/effect-io-exceptions.json'), JSON.stringify({ baselineCount: 0, exceptions: [] }));
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));
      writeFileSync(
        join(root, 'packages/kernel/src/bypass.ts'),
        'export async function probe() { await fetch("https://example.com"); }\n',
      );
      const errors = scanEffectIo(root);
      assert.ok(errors.some((e) => e.includes('New external I/O bypass')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags expired exceptions', async () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), 'config/effect-io-exceptions.json'), 'utf-8'));
    const expired = config.exceptions.map((e: { expiresAt: string }) => ({
      ...e,
      expiresAt: '2020-01-01',
    }));
    const tmpRoot = process.cwd();
    const orig = config.exceptions;
    try {
      config.exceptions = expired;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(tmpRoot, 'config/effect-io-exceptions.json'), JSON.stringify(config, null, 2));
      const errors = scanEffectIo(tmpRoot);
      assert.ok(errors.some((e) => e.includes('Expired')));
    } finally {
      config.exceptions = orig;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(tmpRoot, 'config/effect-io-exceptions.json'), JSON.stringify(config, null, 2) + '\n');
    }
  });

  it('does not let a single exception pattern cover a second IO type in the same file', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-multi-'));
    try {
      for (const dir of ['config', 'packages/core/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({
          baselineCount: 1,
          exceptions: [
            {
              id: 'tmp-fetch-only',
              path: 'packages/core/src/multi.ts',
              expiresAt: '2099-01-01',
              patterns: ['fetch('],
            },
          ],
        }),
      );
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));
      writeFileSync(
        join(root, 'packages/core/src/multi.ts'),
        'import { spawn } from "child_process";\nexport async function probe() { await fetch("https://x"); spawn("true"); }\n',
      );
      const errors = scanEffectIo(root);
      assert.ok(
        errors.some((e) => e.includes('New external I/O bypass') && e.includes('child_process')),
        errors.join('\n'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
