import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLegacyExecutionAllowed } from '../src/legacyExecutionGuard';

describe('legacy execution guard', () => {
  it('never allows the in-process authority in production', () => {
    const previous = { node: process.env.NODE_ENV, v2: process.env.COMMANDER_V2_MODE, legacy: process.env.COMMANDER_LEGACY_EXECUTION, profile: process.env.COMMANDER_PROFILE };
    try {
      process.env.NODE_ENV = 'production';
      process.env.COMMANDER_V2_MODE = '0';
      process.env.COMMANDER_LEGACY_EXECUTION = '1';
      assert.equal(isLegacyExecutionAllowed(), false);
    } finally {
      if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
      if (previous.v2 === undefined) delete process.env.COMMANDER_V2_MODE; else process.env.COMMANDER_V2_MODE = previous.v2;
      if (previous.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION; else process.env.COMMANDER_LEGACY_EXECUTION = previous.legacy;
      if (previous.profile === undefined) delete process.env.COMMANDER_PROFILE; else process.env.COMMANDER_PROFILE = previous.profile;
    }
  });

  it('never allows the in-process authority in enterprise profile even with legacy opt-in', () => {
    const previous = { node: process.env.NODE_ENV, v2: process.env.COMMANDER_V2_MODE, legacy: process.env.COMMANDER_LEGACY_EXECUTION, profile: process.env.COMMANDER_PROFILE };
    try {
      process.env.COMMANDER_PROFILE = 'enterprise';
      process.env.NODE_ENV = 'development';
      process.env.COMMANDER_V2_MODE = '0';
      process.env.COMMANDER_LEGACY_EXECUTION = '1';
      assert.equal(isLegacyExecutionAllowed(), false);
    } finally {
      if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
      if (previous.v2 === undefined) delete process.env.COMMANDER_V2_MODE; else process.env.COMMANDER_V2_MODE = previous.v2;
      if (previous.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION; else process.env.COMMANDER_LEGACY_EXECUTION = previous.legacy;
      if (previous.profile === undefined) delete process.env.COMMANDER_PROFILE; else process.env.COMMANDER_PROFILE = previous.profile;
    }
  });

  it('requires explicit local compatibility opt-in outside production', () => {
    const previous = { node: process.env.NODE_ENV, v2: process.env.COMMANDER_V2_MODE, legacy: process.env.COMMANDER_LEGACY_EXECUTION };
    try {
      process.env.NODE_ENV = 'development';
      process.env.COMMANDER_V2_MODE = '0';
      delete process.env.COMMANDER_LEGACY_EXECUTION;
      assert.equal(isLegacyExecutionAllowed(), false);
      process.env.COMMANDER_LEGACY_EXECUTION = '1';
      assert.equal(isLegacyExecutionAllowed(), true);
      process.env.COMMANDER_V2_MODE = '1';
      assert.equal(isLegacyExecutionAllowed(), false);
    } finally {
      if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
      if (previous.v2 === undefined) delete process.env.COMMANDER_V2_MODE; else process.env.COMMANDER_V2_MODE = previous.v2;
      if (previous.legacy === undefined) delete process.env.COMMANDER_LEGACY_EXECUTION; else process.env.COMMANDER_LEGACY_EXECUTION = previous.legacy;
    }
  });
});
