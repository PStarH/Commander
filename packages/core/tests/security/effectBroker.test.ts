import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  type EffectBroker,
  isEffectBrokerCompatEnabled,
  requireEffectBrokerCompatAudit,
  setEffectBroker,
  getEffectBroker,
} from '../../src/security/effectBroker';

describe('EffectBroker enforcement', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_V2_MODE = process.env.COMMANDER_V2_MODE;
  const ORIGINAL_COMPAT = process.env.COMMANDER_EFFECT_BROKER_COMPAT;

  beforeEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.COMMANDER_V2_MODE;
    delete process.env.COMMANDER_EFFECT_BROKER_COMPAT;
    setEffectBroker(null);
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.COMMANDER_V2_MODE = ORIGINAL_V2_MODE;
    process.env.COMMANDER_EFFECT_BROKER_COMPAT = ORIGINAL_COMPAT;
    setEffectBroker(null);
  });

  it('production without broker fails closed', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COMMANDER_EFFECT_BROKER_COMPAT;
    expect(isEffectBrokerCompatEnabled()).toBe(false);
  });

  it('V2 mode without compat fails closed', () => {
    process.env.NODE_ENV = 'test';
    process.env.COMMANDER_V2_MODE = '1';
    delete process.env.COMMANDER_EFFECT_BROKER_COMPAT;
    expect(isEffectBrokerCompatEnabled()).toBe(false);
  });

  it('compat requires all three flags', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.COMMANDER_V2_MODE;
    process.env.COMMANDER_EFFECT_BROKER_COMPAT = '1';
    expect(isEffectBrokerCompatEnabled()).toBe(true);
  });

  it('setEffectBroker / getEffectBroker round-trip', () => {
    const broker: EffectBroker = { kind: 'effect_broker', admit: (req) => req };
    setEffectBroker(broker);
    expect(getEffectBroker()).toBe(broker);
  });

  it('requireEffectBrokerCompatAudit is safe when compat is disabled', () => {
    process.env.NODE_ENV = 'production';
    expect(() => requireEffectBrokerCompatAudit()).not.toThrow();
  });
});
