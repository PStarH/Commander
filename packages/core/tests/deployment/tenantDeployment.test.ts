import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CREATE_SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/create-tenant.sh');
const DESTROY_SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/destroy-tenant.sh');
const MIGRATE_SCRIPT = path.join(REPO_ROOT, 'deploy/scripts/migrate-tenant.sh');

describe('tenant deployment scripts', () => {
  let tmpDir: string;
  let configFile: string;
  let dataRoot: string;
  let keysFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdr-tenant-test-'));
    configFile = path.join(tmpDir, 'config', 'tenants.json');
    dataRoot = path.join(tmpDir, 'data');
    keysFile = path.join(tmpDir, 'keys', 'tenant-api-keys.json');

    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(path.dirname(keysFile), { recursive: true });

    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          $schema: '../commander.schema.json',
          description: 'Test tenant config',
          tenants: [],
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const env = () => ({
    ...process.env,
    TENANT_CONFIG_PATH: configFile,
    COMMANDER_DATA_ROOT: dataRoot,
    TENANT_KEYS_PATH: keysFile,
  });

  const loadConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  const loadKeys = () => JSON.parse(fs.readFileSync(keysFile, 'utf-8'));
  const tenantConfig = (tenantId: string) =>
    loadConfig().tenants.find((t: any) => t.tenantId === tenantId);

  it('creates a pool tenant without data directories', () => {
    execFileSync(CREATE_SCRIPT, ['pool-t1', 'starter', 'pool'], { env: env(), stdio: 'pipe' });

    const t = tenantConfig('pool-t1');
    expect(t).toBeDefined();
    expect(t.isolation).toBe('pool');
    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'pool-t1'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'pool-t1'))).toBe(false);
    expect(loadKeys()['pool-t1']?.apiKey).toHaveLength(64);
  });

  it('creates a bridge tenant with isolated subdirectories', () => {
    execFileSync(CREATE_SCRIPT, ['bridge-t1', 'standard', 'bridge'], { env: env(), stdio: 'pipe' });

    const t = tenantConfig('bridge-t1');
    expect(t.isolation).toBe('bridge');
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1', 'memory'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1', 'runs'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1', 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1', 'artifacts'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1', 'storage'))).toBe(true);
  });

  it('creates a silo tenant with isolated subdirectories', () => {
    execFileSync(CREATE_SCRIPT, ['silo-t1', 'premium', 'silo'], { env: env(), stdio: 'pipe' });

    const t = tenantConfig('silo-t1');
    expect(t.isolation).toBe('silo');
    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'silo-t1', 'memory'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'silo-t1', 'artifacts'))).toBe(true);
  });

  it('rejects duplicate tenant creation', () => {
    expect(() =>
      execFileSync(CREATE_SCRIPT, ['silo-t1', 'premium', 'silo'], { env: env(), stdio: 'pipe' }),
    ).toThrow();
  });

  it('migrates pool -> bridge and creates a data directory', () => {
    execFileSync(MIGRATE_SCRIPT, ['pool-t1', 'bridge'], { env: env(), stdio: 'pipe' });

    expect(tenantConfig('pool-t1').isolation).toBe('bridge');
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'pool-t1', 'memory'))).toBe(true);
  });

  it('dry-run does not copy bridge -> silo data', () => {
    const bridgeDir = path.join(dataRoot, 'bridge', 'bridge-t1', 'memory');
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, 'db.sqlite'), 'memory-data');

    execFileSync(MIGRATE_SCRIPT, ['bridge-t1', 'silo', '--dry-run'], { env: env(), stdio: 'pipe' });

    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'bridge-t1', 'memory', 'db.sqlite'))).toBe(
      false,
    );
  });

  it('migrates bridge -> silo and copies data', () => {
    execFileSync(MIGRATE_SCRIPT, ['bridge-t1', 'silo'], { env: env(), stdio: 'pipe' });

    expect(tenantConfig('bridge-t1').isolation).toBe('silo');
    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'bridge-t1', 'memory', 'db.sqlite'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(dataRoot, 'tenants', 'bridge-t1', 'memory', 'db.sqlite'), 'utf-8'),
    ).toBe('memory-data');
  });

  it('destroys tenants and cleans up data and keys', () => {
    execFileSync(DESTROY_SCRIPT, ['pool-t1', '--force'], { env: env(), stdio: 'pipe' });
    execFileSync(DESTROY_SCRIPT, ['bridge-t1', '--force'], { env: env(), stdio: 'pipe' });
    execFileSync(DESTROY_SCRIPT, ['silo-t1', '--force'], { env: env(), stdio: 'pipe' });

    const ids = loadConfig().tenants.map((t: any) => t.tenantId);
    expect(ids).not.toContain('pool-t1');
    expect(ids).not.toContain('bridge-t1');
    expect(ids).not.toContain('silo-t1');

    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'pool-t1'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'bridge', 'bridge-t1'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'tenants', 'silo-t1'))).toBe(false);

    const keys = loadKeys();
    expect(keys).not.toHaveProperty('pool-t1');
    expect(keys).not.toHaveProperty('bridge-t1');
    expect(keys).not.toHaveProperty('silo-t1');
  });

  it('fails to destroy a non-existent tenant', () => {
    expect(() =>
      execFileSync(DESTROY_SCRIPT, ['missing-tenant', '--force'], { env: env(), stdio: 'pipe' }),
    ).toThrow();
  });
});
