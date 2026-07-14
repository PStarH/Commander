// WARNING: Observability module contains 28 files and 6,362 lines.
// Many exported metrics/scoring functions are hardcoded formulas that produce
// numbers nobody acts on. experimentRunner.ts compares metric counts across
// runs with no statistical rigor. Consumers should verify that exported
// metrics feed into actual alerts, dashboards, or decisions.
export * from './types';
export { CostModel, getCostModel, resetCostModel, DEFAULT_PRICING } from './costModel';
export { buildTimeline, buildSpanTree } from './timelineBuilder';
export { buildDecisions, decisionsSummary } from './decisionProvenance';
export { eventToOtelAttrs, spanNameForEvent, SPAN_KIND_TO_OTEL_KIND } from './otelSemConv';
export { dryReplay } from './replay';
export { buildExecutiveSummary } from './executiveSummary';
export {
  handleObservabilityRequest,
  OBSERVABILITY_HTTP_ROUTES,
  type ObservabilityDeps,
  type ObservabilityResult,
} from './httpApi';
// Shared scoring primitives — single source of truth for "is this dataset
// expected value ungradable?" across evalScorer.ts and scripts/benchmark-gaia.ts.
// See normalizeExpected.ts for the cross-file contract that prevents silent
// drift between the production EvalScorer and the offline benchmark.
export {
  classifyExpected,
  classifyExpectedForSubstringMatch,
  isNormalizedSubstringMatch,
  normalizeForMatch,
  type ExpectedClassification,
  type GradedClassification,
  type UngradedClassification,
  type UngradedReason,
} from './normalizeExpected';
// Shared offline-benchmark scoring primitives — the 3-way verdict (CORRECT /
// INCORRECT / UNGRADED) that scripts/benchmark-gaia.ts and the vitest runtime
// tests in evalScorer.test.ts both import. See score.ts for the cross-file
// contract and the asymmetric parameter types invariant.
export { score, type Verdict, type ScoreResult } from './score';
// PagerDuty alerting — SLO violation → PagerDuty Events API v2 bridge
export {
  PagerDutyAlerter,
  SLOAlertBridge,
  getPagerDutyAlerter,
  setPagerDutyAlerter,
  resetPagerDutyAlerter,
  type PagerDutyAlert,
  type PagerDutySeverity,
  type SLOViolationEvent,
  type SLOViolationCallback,
} from './pagerDutyAlerting';
