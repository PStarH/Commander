import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { getCommanderProfile, isEnterpriseProfile } from '../src/profileSignal.js';

const ENV_KEYS = [
  'COMMANDER_PROFILE',
  'NODE_ENV',
  'COMMANDER_ENV',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

describe('profileSignal', () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => restoreEnv(snap));

  it('defaults to standard when no production signal is set', () => {
    assert.equal(getCommanderProfile(), 'standard');
    assert.equal(isEnterpriseProfile(), false);
  });

  it('explicit COMMANDER_PROFILE=enterprise wins over a non-production env', () => {
    process.env.COMMANDER_PROFILE = 'enterprise';
    assert.equal(getCommanderProfile(), 'enterprise');
    assert.equal(isEnterpriseProfile(), true);
  });

  it('explicit COMMANDER_PROFILE=standard wins over NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMANDER_PROFILE = 'standard';
    assert.equal(getCommanderProfile(), 'standard');
    assert.equal(isEnterpriseProfile(), false);
  });

  it('NODE_ENV=production implies enterprise', () => {
    process.env.NODE_ENV = 'production';
    assert.equal(getCommanderProfile(), 'enterprise');
  });

  it('COMMANDER_ENV=production implies enterprise', () => {
    process.env.COMMANDER_ENV = 'production';
    assert.equal(getCommanderProfile(), 'enterprise');
  });

  it('COMMANDER_ENV=prod implies enterprise', () => {
    process.env.COMMANDER_ENV = 'prod';
    assert.equal(getCommanderProfile(), 'enterprise');
  });

  it('ignores unknown COMMANDER_PROFILE values (falls back to env inference)', () => {
    process.env.COMMANDER_PROFILE = 'garbage';
    assert.equal(getCommanderProfile(), 'standard');
  });
});
