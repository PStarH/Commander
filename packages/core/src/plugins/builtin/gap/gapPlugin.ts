/**
 * gapPlugin — Built-in CommanderPlugin for Gap Discovery & SLA Enforcement.
 *
 * Registers as `builtin-gap` (category: 'monitoring'). On load it initializes
 * the GapRegistry from the configured registry path. The registry, issue
 * auto-creator, SLA enforcer, and quarterly audit functions remain directly
 * importable from '@commander/core' (see re-exports in index.ts) so that
 * security/chaos/shadow gapDiscovery modules can use them without going
 * through the plugin hook system.
 *
 * No hooks installed — gap discovery is explicitly invoked by the security,
 * chaos, and shadow modules after they detect novel findings.
 */
import type { CommanderPlugin } from '../../../pluginTypes';
import { getGlobalLogger } from '../../../logging';
import { loadGapConfig } from './config';
import { GapRegistry } from './registry';

// Re-export the public API so @commander/core consumers see no change.
export { GapRegistry, type RecordGapInput, type ListFilter } from './registry';
export { IssueAutoCreate, type IssueDraft, type CreateResult } from './issueAutoCreate';
export { SlaEnforcer, type SlaEnforcerDeps } from './slaEnforcer';
export { computeMetrics, type GapMetrics } from './metrics';
export { loadGapConfig, type GapConfig } from './config';
export { appendNdjson, readNdjson, ensureDir } from './storage';
export {
  runQuarterlyAudit,
  saveAuditReport,
  renderAuditMarkdown,
  type AuditReport,
} from './quarterlyAudit';

// ============================================================================
// Gap Plugin factory
// ============================================================================

export function createGapPlugin(): CommanderPlugin {
  let registry: GapRegistry | null = null;

  return {
    name: 'builtin-gap',
    version: '0.1.0',
    description: 'Gap discovery registry, SLA enforcement, and quarterly audit',
    category: 'monitoring',
    configSchema: {
      type: 'object',
      properties: {
        registryFile: {
          type: 'string',
          description: 'Path to the gap registry NDJSON file',
          default: '.commander/gaps/registry.ndjson',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, issue auto-creation runs in dry-run mode',
          default: false,
        },
      },
    },

    onLoad: async (ctx) => {
      const cfg = ctx.config;
      // If a registryFile is provided in plugin config, use it; otherwise
      // fall back to the default from loadGapConfig().
      const gapConfig = loadGapConfig();
      const registryFile = (cfg.registryFile as string) ?? gapConfig.registryFile;
      registry = new GapRegistry(registryFile);
      getGlobalLogger().info('GapPlugin', `Gap registry loaded (file=${registryFile})`);
    },

    onUnload: async () => {
      registry = null;
      getGlobalLogger().info('GapPlugin', 'Gap registry unloaded');
    },
  };
}
