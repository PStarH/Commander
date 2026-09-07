import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function source(relativePath: string): string {
  const path = join(ROOT, relativePath);
  assert.ok(existsSync(path), `expected ${relativePath} to exist`);
  return readFileSync(path, 'utf8');
}

describe('legacy Shadow replay removal', () => {
  it('does not retain the transparent replay transport or runner', () => {
    const deletedPaths = [
      'packages/core/src/shadow/proxy.ts',
      'packages/core/src/shadow/runner.ts',
      'packages/core/src/shadow/driftReporter.ts',
      'packages/core/src/shadow/gapDiscovery.ts',
      'packages/core/src/shadow/types.ts',
      'packages/core/src/cli/commands/shadow.ts',
    ];

    for (const relativePath of deletedPaths) {
      assert.equal(
        existsSync(join(ROOT, relativePath)),
        false,
        `${relativePath} implements obsolete transparent request replay and must remain deleted`,
      );
    }
  });

  it('does not register or expose transparent replay', () => {
    const api = source('apps/api/src/index.ts');
    const exports = source('packages/core/src/index.ts');
    const shadow = source('packages/core/src/shadow/index.ts');

    assert.doesNotMatch(api, /ShadowProxy|loadShadowConfig|shadowProxy\.expressMiddleware/);
    assert.doesNotMatch(exports, /ShadowProxy|DriftReporter|loadShadowConfig|ShadowConfig/);
    assert.doesNotMatch(shadow, /proxy|runner|driftReporter|types/);
    assert.match(shadow, /scrubber/);
  });

  it('does not retain the replay configuration or environment toggle in runtime source', () => {
    const runtimeSources = [
      'apps/api/src/index.ts',
      'packages/core/src/index.ts',
      'packages/core/src/cliEntry.ts',
      'packages/core/src/shadow/index.ts',
      'packages/core/src/smoke/attackPoCs.ts',
      'packages/core/src/smoke/smokeTestE2E.ts',
      'packages/core/src/plugins/builtin/gap/types.ts',
      'packages/core/src/plugins/builtin/gap/gapPlugin.ts',
    ].map(source);

    for (const text of runtimeSources) {
      assert.doesNotMatch(
        text,
        /COMMANDER_SHADOW_ENABLED|shadow-config\.json|shadow:runner|shadow:drift|shadow-drift/,
      );
    }
  });

  it('keeps the historical evaluator free of effect-producing dependencies', () => {
    const packageJson = JSON.parse(source('packages/shadow-plane/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(packageJson.dependencies ?? {});

    for (const forbidden of [
      '@commander/effect-broker',
      '@kubernetes/client-node',
      'axios',
      'undici',
      'redis',
    ]) {
      assert.equal(
        dependencies.includes(forbidden),
        false,
        `@commander/shadow-plane must not depend on ${forbidden}`,
      );
    }
  });
});
