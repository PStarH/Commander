import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('architecture test build closure', () => {
  it('builds postgres-runtime before loading architecture tests', () => {
    const testArch = packageJson.scripts['test:arch'];
    assert.match(testArch, /pnpm --filter @commander\/postgres-runtime build/);
    assert.ok(
      testArch.indexOf('pnpm --filter @commander/postgres-runtime build') <
        testArch.indexOf('pnpm exec tsx --test'),
      'postgres-runtime must build before architecture test execution',
    );
  });
});
