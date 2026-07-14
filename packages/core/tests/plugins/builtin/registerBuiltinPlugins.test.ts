import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHookManager, resetHookManager } from '../../../src/pluginManager';
import {
  registerBuiltinPlugins,
  createGapPlugin,
  createObservabilityPlugin,
} from '../../../src/pluginManager';
import { getIMProviderRegistry, resetIMProviderRegistry } from '../../../src/im';
import type { CommanderPlugin } from '../../../src/pluginTypes';
import type { IMProvider } from '../../../src/im';
import { resetSLOOperations } from '../../../src/plugins/builtin/observability/sloOperations';
import { getSLOOperations } from '../../../src/plugins/builtin/observability/sloOperations';

const fakeIMProvider: IMProvider = {
  id: 'test-im',
  name: 'Test IM',
  verify: () => true,
  parseMessage: () => ({ text: 'hi', senderId: 'u1', conversationId: 'c1' }),
  formatReply: (reply) => ({ body: reply.text }),
  stripMention: (t) => t,
};

const fakeIMPlugin: CommanderPlugin = {
  name: 'im-test',
  version: '1.0.0',
  category: 'integration',
  provides: [{ service: 'im.provider', implementation: fakeIMProvider }],
};

describe('registerBuiltinPlugins', () => {
  beforeEach(() => {
    resetHookManager();
    resetIMProviderRegistry();
    resetSLOOperations();
  });

  afterEach(async () => {
    const hm = getHookManager();
    for (const name of hm.listPlugins()) {
      await hm.unregister(name);
    }
    resetHookManager();
    resetIMProviderRegistry();
    resetSLOOperations();
  });

  it('registers security and gap plugins by default', async () => {
    const result = await registerBuiltinPlugins({
      observability: false,
      rag: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.registered).toContain('builtin-rasp-extensions');
    expect(result.registered).toContain('builtin-taint-tracking');
    expect(result.registered).toContain('builtin-gap');
    expect(getHookManager().isEnabled('builtin-taint-tracking')).toBe(true);
    expect(getHookManager().hasPlugin('builtin-gap')).toBe(true);
  });

  it('registers RAG then disables when ragDisabled', async () => {
    await registerBuiltinPlugins({
      rasp: false,
      taint: false,
      gap: false,
      observability: false,
      rag: true,
      ragDisabled: true,
    });
    expect(getHookManager().hasPlugin('builtin-rag')).toBe(true);
    expect(getHookManager().isEnabled('builtin-rag')).toBe(false);
  });

  it('is idempotent on second call', async () => {
    await registerBuiltinPlugins({ observability: false, rag: false });
    const second = await registerBuiltinPlugins({ observability: false, rag: false });
    expect(second.skipped).toContain('builtin-rasp-extensions');
    expect(second.registered).not.toContain('builtin-rasp-extensions');
  });

  it('wires im.provider SPI into IMProviderRegistry on register', async () => {
    await registerBuiltinPlugins({
      rasp: false,
      taint: false,
      rag: false,
      gap: false,
      observability: false,
      extraPlugins: [fakeIMPlugin],
    });
    expect(getIMProviderRegistry().resolve('test-im')?.id).toBe('test-im');
  });

  it('removes im.provider from registry on unregister', async () => {
    await getHookManager().register(fakeIMPlugin);
    expect(getIMProviderRegistry().resolve('test-im')).toBeDefined();
    await getHookManager().unregister('im-test');
    expect(getIMProviderRegistry().resolve('test-im')).toBeUndefined();
  });
});

describe('createGapPlugin (merged)', () => {
  it('exposes gap tools and security category', () => {
    const plugin = createGapPlugin();
    expect(plugin.name).toBe('builtin-gap');
    expect(plugin.category).toBe('security');
    expect(plugin.tools?.map((t) => t.name)).toEqual([
      'gap_record',
      'gap_list',
      'gap_close',
      'gap_audit',
    ]);
  });
});

describe('createObservabilityPlugin', () => {
  beforeEach(() => {
    resetSLOOperations();
  });

  afterEach(async () => {
    resetSLOOperations();
  });

  it('initializes SLO operations when enableSLOMonitoring is true', async () => {
    const plugin = createObservabilityPlugin();
    await plugin.onLoad?.({
      config: {
        enableSLOMonitoring: true,
        enableAlertRules: true,
        enableIncidentManagement: true,
      },
    });
    const ops = getSLOOperations();
    expect(ops.getMonitoringEngine()).toBeDefined();
    await plugin.onUnload?.();
  });

  it('does not leave monitoring running when SLO is disabled', async () => {
    const plugin = createObservabilityPlugin();
    await plugin.onLoad?.({
      config: {
        enableSLOMonitoring: false,
        enableAlertRules: false,
        enableIncidentManagement: false,
      },
    });
    await plugin.onUnload?.();
  });
});
