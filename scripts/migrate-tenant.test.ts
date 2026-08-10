import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const script = resolve('deploy/scripts/migrate-tenant.sh');

async function fixture(model: 'bridge' | 'silo') {
  const root = await mkdtemp(join(tmpdir(), 'commander-migrate-tenant-'));
  const data = join(root, 'data');
  const config = join(root, 'tenants.json');
  const source = join(data, model === 'bridge' ? 'bridge' : 'tenants', 'tenant-a');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'visible.txt'), 'visible\n');
  await writeFile(join(source, '.hidden'), 'hidden\n');
  await writeFile(
    config,
    `${JSON.stringify({ tenants: [{ tenantId: 'tenant-a', isolation: model }] }, null, 2)}\n`,
  );
  return { root, data, config, source };
}

function run(config: string, data: string, target: string, path = process.env.PATH) {
  return spawnSync('bash', [script, 'tenant-a', target, '--config', config], {
    encoding: 'utf8',
    env: { ...process.env, COMMANDER_DATA_ROOT: data, PATH: path },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('migrate-tenant data safety', () => {
  it('moves all data and only removes the source after the config switches', async () => {
    const state = await fixture('bridge');
    const result = run(state.config, state.data, 'silo');
    assert.equal(result.status, 0, result.stderr);
    const destination = join(state.data, 'tenants', 'tenant-a');
    assert.equal(await readFile(join(destination, 'visible.txt'), 'utf8'), 'visible\n');
    assert.equal(await readFile(join(destination, '.hidden'), 'utf8'), 'hidden\n');
    assert.equal(await exists(state.source), false);
    assert.equal(JSON.parse(await readFile(state.config, 'utf8')).tenants[0].isolation, 'silo');
  });

  it('preserves the source and config when the copy command fails', async () => {
    const state = await fixture('bridge');
    const bin = join(state.root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'cp'), '#!/bin/sh\nexit 23\n');
    await chmod(join(bin, 'cp'), 0o755);
    const result = run(state.config, state.data, 'silo', `${bin}:${process.env.PATH ?? ''}`);
    assert.notEqual(result.status, 0);
    assert.equal(await exists(state.source), true);
    assert.equal(JSON.parse(await readFile(state.config, 'utf8')).tenants[0].isolation, 'bridge');
  });

  it('retains on-disk data when explicitly downgrading to pool', async () => {
    const state = await fixture('silo');
    const result = run(state.config, state.data, 'pool');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(state.source), true);
    const tenant = JSON.parse(await readFile(state.config, 'utf8')).tenants[0];
    assert.equal(tenant.isolation, 'pool');
    assert.equal('workspacePath' in tenant, false);
    assert.equal('storagePath' in tenant, false);
  });
});
