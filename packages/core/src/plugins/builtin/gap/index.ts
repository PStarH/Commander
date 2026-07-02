// packages/core/src/plugins/builtin/gap/index.ts
export * from './types';
export { GapRegistry, RecordGapInput, ListFilter } from './registry';
export { IssueAutoCreate, IssueDraft, CreateResult } from './issueAutoCreate';
export { SlaEnforcer, SlaEnforcerDeps } from './slaEnforcer';
export { computeMetrics, GapMetrics } from './metrics';
export { loadGapConfig, GapConfig } from './config';
export { appendNdjson, readNdjson, ensureDir } from './storage';
export {
  runQuarterlyAudit,
  saveAuditReport,
  renderAuditMarkdown,
  AuditReport,
} from './quarterlyAudit';
