import type { CommanderPlugin, PluginLoadContext } from '../../pluginTypes';
import { harmfulContentRules } from './rules';

/**
 * Built-in harmful content rules plugin.
 *
 * The actual rules are declared in plugin.json via the `contentScannerRules`
 * manifest field; the host (PluginLoader) reads that declaration and registers
 * the pack with the ContentScanner. This entry point exists for direct imports
 * and future lifecycle hooks.
 */
const plugin: CommanderPlugin = {
  name: 'harmful-content-rules',
  version: '1.0.0',
  description: 'Built-in harmful content detection rule pack for AgentSafetyBench and AgentHarm.',
  category: 'security',
  contentScannerRules: {
    export: {
      module: './rules.ts',
      name: 'harmfulContentRules',
    },
  },
  async onLoad(_ctx: PluginLoadContext) {
    // Rules are registered by the host via the manifest contentScannerRules field.
  },
};

export default plugin;
export { harmfulContentRules };
