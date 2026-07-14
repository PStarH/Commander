import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHookManager, resetHookManager } from '../../src/pluginManager';
import { registerBuiltinPlugins } from '../../src/plugins/builtin/registerBuiltinPlugins';
import { getMessageBus, resetMessageBus } from '../../src/runtime/messageBus';
import {
  registerResponseCallbacks,
  resetSecurityResponseState,
  startSecurityResponseEngine,
} from '../../src/security/securityResponseEngine';
import { resetSLOOperations } from '../../src/plugins/builtin/observability/sloOperations';

/**
 * Verifies the M0 security bootstrap wiring pattern used in serviceInitializer.
 * Avoids constructing a full AgentRuntime (heavy sqlite/lease dependencies).
 */
describe('builtin security plugin registration', () => {
  beforeEach(() => {
    resetHookManager();
    resetMessageBus();
    resetSecurityResponseState();
    resetSLOOperations();
  });

  afterEach(async () => {
    for (const name of getHookManager().listPlugins()) {
      await getHookManager().unregister(name);
    }
    resetHookManager();
    resetSecurityResponseState();
    resetSLOOperations();
  });

  it('wires security.alert subscriber via startSecurityResponseEngine', () => {
    registerResponseCallbacks({});
    startSecurityResponseEngine();
    expect(getMessageBus().getSubscriberCount('security.alert')).toBe(1);
  });

  it('registerBuiltinPlugins wires RASP and taint like serviceInitializer', async () => {
    const result = await registerBuiltinPlugins({
      rag: false,
      gap: false,
      observability: false,
    });
    expect(result.errors).toEqual([]);
    const hm = getHookManager();
    expect(hm.hasPlugin('builtin-rasp-extensions')).toBe(true);
    expect(hm.isEnabled('builtin-rasp-extensions')).toBe(true);
    expect(hm.hasPlugin('builtin-taint-tracking')).toBe(true);
    expect(hm.isEnabled('builtin-taint-tracking')).toBe(true);
  });
});
