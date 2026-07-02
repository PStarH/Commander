/**
 * gapPlugin - Built-in CommanderPlugin for security/compliance gap tracking,
 * SLA enforcement, and quarterly architecture audits.
 *
 * Registers as 'builtin-gap' (category: 'security'). Gap tracking is an
 * enterprise compliance feature - production agents don't need it at runtime.
 * The plugin exposes gap management as tools and keeps the public API
 * (GapRegistry, IssueAutoCreate, SlaEnforcer, runQuarterlyAudit) stable so
 * security/chaos/shadow gapDiscovery consumers can continue importing them.
 *
 * No hooks installed - gaps are discovered and reported by external systems
 * (red-team, chaos, shadow) via the exported helper functions, not automatically.
 */
import type { CommanderPlugin } from '../../pluginManager';
import { getGlobalLogger } from '../../logging';

// Re-export the public API so consumers see no change.
export { GapRegistry } from './gap/registry';
export type { RecordGapInput, ListFilter } from './gap/registry';
export { IssueAutoCreate } from './gap/issueAutoCreate';
export type { IssueDraft, CreateResult } from './gap/issueAutoCreate';
export { SlaEnforcer } from './gap/slaEnforcer';
export type { SlaEnforcerDeps } from './gap/slaEnforcer';
export { computeMetrics } from './gap/metrics';
export type { GapMetrics } from './gap/metrics';
export { loadGapConfig } from './gap/config';
export type { GapConfig } from './gap/config';
export { appendNdjson, readNdjson, ensureDir } from './gap/storage';
export { runQuarterlyAudit, saveAuditReport, renderAuditMarkdown } from './gap/quarterlyAudit';
export type { AuditReport } from './gap/quarterlyAudit';
export type { GapEntry, GapSource, GapSeverity, GapStatus, GapRegressionCheck } from './gap/types';
export { isCritical, isOverdue, computeSlaDeadline, computeRepairDeadline } from './gap/types';

export function createGapPlugin(): CommanderPlugin {
  return {
    name: 'builtin-gap',
    version: '0.1.0',
    description: 'Security/compliance gap tracking, SLA enforcement, and quarterly audits',
    category: 'security',
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
          description: 'When true, IssueAutoCreate logs instead of creating GitHub issues',
          default: false,
        },
      },
    },

    onLoad: async (ctx) => {
      getGlobalLogger().info(
        'GapPlugin',
        'Gap tracking loaded (registry=' +
          (ctx.config.registryFile ?? '.commander/gaps/registry.ndjson') +
          ')',
      );
    },

    onUnload: async () => {
      getGlobalLogger().info('GapPlugin', 'Gap tracking unloaded');
    },

    tools: [
      {
        name: 'gap_record',
        description:
          'Record a new security/compliance gap. The gap is signed (HMAC) and persisted to the registry. ' +
          'Returns the created gap entry with its generated ID and SLA deadline.',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              enum: [
                'chaos',
                'shadow-drift',
                'redteam-missed',
                'postmortem',
                'cve-feed',
                'customer-report',
                'security-audit',
                'quarterly-audit',
              ],
              description: 'Where the gap was discovered',
            },
            severity: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'info'],
              description: 'Gap severity (determines SLA deadline)',
            },
            title: { type: 'string', description: 'Short title (sanitized)' },
            description: { type: 'string', description: 'Detailed description (sanitized)' },
            owner: { type: 'string', description: 'Optional owner identifier' },
          },
          required: ['source', 'severity', 'title', 'description'],
        },
        execute: async (args) => {
          const { GapRegistry } = await import('./gap/registry');
          const { loadGapConfig } = await import('./gap/config');
          const config = loadGapConfig();
          const registry = new GapRegistry(config.registryFile);
          const entry = registry.record({
            source: args.source as never,
            severity: args.severity as never,
            title: String(args.title),
            description: String(args.description),
            owner: args.owner as string | undefined,
          });
          return JSON.stringify({ ok: true, gap: entry });
        },
      },
      {
        name: 'gap_list',
        description:
          'List gaps from the registry with optional filters (source, severity, status). ' +
          'Returns matching gap entries.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Filter by source' },
            severity: { type: 'string', description: 'Filter by severity' },
            status: { type: 'string', description: 'Filter by status' },
          },
        },
        execute: async (args) => {
          const { GapRegistry } = await import('./gap/registry');
          const { loadGapConfig } = await import('./gap/config');
          const config = loadGapConfig();
          const registry = new GapRegistry(config.registryFile);
          const filter: Record<string, unknown> = {};
          if (args.source) filter.source = args.source;
          if (args.severity) filter.severity = args.severity;
          if (args.status) filter.status = args.status;
          const entries = registry.list(
            Object.keys(filter).length > 0 ? (filter as never) : undefined,
          );
          return JSON.stringify({ count: entries.length, gaps: entries });
        },
      },
      {
        name: 'gap_close',
        description:
          'Close a gap as fixed. Requires regression test IDs to prevent false closure. ' +
          'The gap entry is updated with resolution notes and a regression check record.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Gap ID to close' },
            notes: { type: 'string', description: 'Resolution notes' },
            regressionTestIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Test IDs that verify the fix (required, must not be empty)',
            },
          },
          required: ['id', 'notes', 'regressionTestIds'],
        },
        execute: async (args) => {
          const { GapRegistry } = await import('./gap/registry');
          const { loadGapConfig } = await import('./gap/config');
          const config = loadGapConfig();
          const registry = new GapRegistry(config.registryFile);
          const testIds = args.regressionTestIds as string[];
          if (!testIds || testIds.length === 0) {
            return JSON.stringify({ error: 'regressionTestIds must not be empty' });
          }
          registry.close(String(args.id), String(args.notes), testIds);
          return JSON.stringify({ ok: true, id: args.id, status: 'fixed' });
        },
      },
      {
        name: 'gap_audit',
        description:
          'Run a quarterly architecture audit. Scans the gap registry and returns a report ' +
          'with metrics (open, overdue, avg time to fix), recent gaps, and top sources. ' +
          'Optionally saves the report as markdown.',
        inputSchema: {
          type: 'object',
          properties: {
            save: {
              type: 'boolean',
              description: 'When true, saves the report to docs/audits/',
              default: false,
            },
          },
        },
        execute: async (args) => {
          const { runQuarterlyAudit, saveAuditReport, renderAuditMarkdown } =
            await import('./gap/quarterlyAudit');
          const report = runQuarterlyAudit();
          let savedPath: string | undefined;
          if (args.save) {
            savedPath = saveAuditReport(report);
          }
          return JSON.stringify({
            quarter: report.quarter,
            open: report.metrics.open,
            fixedThisQuarter: report.fixedThisQuarter,
            overdue: report.overdueCount,
            savedPath,
            markdown: renderAuditMarkdown(report),
          });
        },
      },
    ],
  };
}
