/**
 * Single host entry for built-in CommanderPlugin registration.
 * Runtime (CLI/agent) and API share this so SPI, tools, and enable state stay consistent.
 */
import { getHookManager } from '../../hookManager';
import { getGlobalLogger } from '../../logging';
import type { CommanderPlugin } from '../../pluginTypes';
import { createRaspExtensionsPlugin } from './raspExtensionsPlugin';
import { createTaintTrackingPlugin } from './taintTrackingPlugin';
import { createRagPlugin } from './ragPlugin';
import { createGapPlugin } from './gap/gapPlugin';
import { createObservabilityPlugin } from './observabilityPlugin';

export type BuiltinPluginId =
  | 'builtin-rasp-extensions'
  | 'builtin-taint-tracking'
  | 'builtin-rag'
  | 'builtin-gap'
  | 'builtin-observability';

export interface RegisterBuiltinPluginsOptions {
  readonly rasp?: boolean;
  readonly taint?: boolean;
  readonly rag?: boolean;
  readonly ragDisabled?: boolean;
  readonly gap?: boolean;
  readonly observability?: boolean;
  readonly observabilityConfig?: {
    readonly enableSLOMonitoring?: boolean;
    readonly enableAlertRules?: boolean;
    readonly enableIncidentManagement?: boolean;
  };
  readonly extraPlugins?: readonly CommanderPlugin[];
}

export interface RegisterBuiltinPluginsResult {
  readonly registered: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly { readonly name: string; readonly error: string }[];
}

async function registerNamed(
  name: string,
  plugin: CommanderPlugin,
  config: Record<string, unknown>,
  result: {
    registered: string[];
    skipped: string[];
    errors: { name: string; error: string }[];
  },
): Promise<void> {
  const hm = getHookManager();
  if (hm.hasPlugin(name)) {
    result.skipped.push(name);
    return;
  }
  try {
    await hm.register(plugin, config);
    result.registered.push(name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push({ name, error: message });
    getGlobalLogger().warn('BuiltinPlugins', `Failed to register ${name}: ${message}`);
  }
}

export async function registerBuiltinPlugins(
  options: RegisterBuiltinPluginsOptions = {},
): Promise<RegisterBuiltinPluginsResult> {
  const {
    rasp = true,
    taint = true,
    rag = true,
    ragDisabled = true,
    gap = true,
    observability = true,
    observabilityConfig = {},
    extraPlugins = [],
  } = options;

  const result: {
    registered: string[];
    skipped: string[];
    errors: { name: string; error: string }[];
  } = { registered: [], skipped: [], errors: [] };

  if (rasp) {
    await registerNamed('builtin-rasp-extensions', createRaspExtensionsPlugin(), {}, result);
  }
  if (taint) {
    await registerNamed('builtin-taint-tracking', createTaintTrackingPlugin(), {}, result);
  }
  if (rag) {
    await registerNamed('builtin-rag', createRagPlugin(), {}, result);
    if (ragDisabled && getHookManager().hasPlugin('builtin-rag')) {
      getHookManager().disable('builtin-rag');
    }
  }
  if (gap) {
    await registerNamed('builtin-gap', createGapPlugin(), {}, result);
  }
  if (observability) {
    await registerNamed(
      'builtin-observability',
      createObservabilityPlugin(),
      {
        enableSLOMonitoring: observabilityConfig.enableSLOMonitoring ?? true,
        enableAlertRules: observabilityConfig.enableAlertRules ?? true,
        enableIncidentManagement: observabilityConfig.enableIncidentManagement ?? true,
      },
      result,
    );
  }

  for (const plugin of extraPlugins) {
    await registerNamed(plugin.name, plugin, {}, result);
  }

  getGlobalLogger().info('BuiltinPlugins', 'Built-in plugin registration complete', {
    registered: result.registered,
    skipped: result.skipped,
    errorCount: result.errors.length,
  });

  return {
    registered: result.registered,
    skipped: result.skipped,
    errors: result.errors,
  };
}
