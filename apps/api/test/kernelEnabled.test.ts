import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getKernelDatabaseUrl,
  isCommanderKernelEnabled,
  isCommanderKernelExplicitlyDisabled,
} from '../src/v1GatewayKernel';

describe('isCommanderKernelEnabled', () => {
  it('defaults OFF without DSN outside production', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv),
      false,
    );
  });

  it('defaults ON when DATABASE_URL is set (even without explicit flag)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://commander:commander@127.0.0.1:5432/commander',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON when COMMANDER_KERNEL_DATABASE_URL is set', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel@127.0.0.1:5432/kernel',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON in production without explicit flag (flag no longer pure opt-in)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('honors explicit off even in production (startServer must refuse this)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: '0',
        DATABASE_URL: 'postgres://x',
      } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(
      isCommanderKernelExplicitlyDisabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: '0',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('honors explicit on without DSN (init will still require DSN)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_ENABLED: '1',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('defaults ON under COMMANDER_V2_MODE=1', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_V2_MODE: '1',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('treats empty COMMANDER_KERNEL_ENABLED as auto (not off)', () => {
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'development',
        COMMANDER_KERNEL_ENABLED: '',
        DATABASE_URL: 'postgres://x',
      } as NodeJS.ProcessEnv),
      true,
    );
  });

  it('accepts true/on/yes and false/off/no aliases', () => {
    assert.equal(
      isCommanderKernelEnabled({ COMMANDER_KERNEL_ENABLED: 'true' } as NodeJS.ProcessEnv),
      true,
    );
    assert.equal(
      isCommanderKernelEnabled({ COMMANDER_KERNEL_ENABLED: 'on' } as NodeJS.ProcessEnv),
      true,
    );
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: 'false',
      } as NodeJS.ProcessEnv),
      false,
    );
    assert.equal(
      isCommanderKernelEnabled({
        NODE_ENV: 'production',
        COMMANDER_KERNEL_ENABLED: 'off',
      } as NodeJS.ProcessEnv),
      false,
    );
  });
});

describe('getKernelDatabaseUrl', () => {
  it('prefers COMMANDER_KERNEL_DATABASE_URL over DATABASE_URL', () => {
    assert.equal(
      getKernelDatabaseUrl({
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel',
        DATABASE_URL: 'postgres://shared',
      } as NodeJS.ProcessEnv),
      'postgres://kernel',
    );
  });

  it('falls back to DATABASE_URL', () => {
    assert.equal(
      getKernelDatabaseUrl({
        DATABASE_URL: 'postgres://shared',
      } as NodeJS.ProcessEnv),
      'postgres://shared',
    );
  });

  it('returns empty string when neither is set', () => {
    assert.equal(getKernelDatabaseUrl({} as NodeJS.ProcessEnv), '');
  });
});
