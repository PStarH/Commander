import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRaspExtensionsPlugin } from '../../src/plugins/builtin/raspExtensionsPlugin';
import { getHookManager, resetHookManager } from '../../src/pluginManager';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import {
  registerResponseCallbacks,
  resetSecurityResponseState,
  startSecurityResponseEngine,
} from '../../src/security/securityResponseEngine';

/**
 * Verifies the M0 security bootstrap wiring pattern used in serviceInitializer.
 * Avoids constructing a full AgentRuntime (heavy sqlite/lease dependencies).
 */
describe('builtin security plugin registration', () => {
  beforeEach(() => {
    resetHookManager();
    resetMessageBus();
    resetSecurityResponseState();
  });

  afterEach(() => {
    resetHookManager();
    resetSecurityResponseState();
  });

  it('wires security.alert subscriber via startSecurityResponseEngine', () => {
    registerResponseCallbacks({});
    startSecurityResponseEngine();
    expect(getMessageBus().getSubscriberCount('security.alert')).toBe(1);
  });

  it('registers builtin-rasp-extensions through the hook manager', async () => {
    await getHookManager().register(createRaspExtensionsPlugin());
    const hm = getHookManager();
    expect(hm.hasPlugin('builtin-rasp-extensions')).toBe(true);
    expect(hm.isEnabled('builtin-rasp-extensions')).toBe(true);
  });
});
