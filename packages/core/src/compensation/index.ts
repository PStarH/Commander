export { FailureInjector, SCENARIOS, runScenario } from './failureInjection';
export type {
  FailureCategory,
  FailureMode,
  FailureTarget,
  FaultRule,
  InjectedFailure,
  ScenarioReport,
} from './failureInjection';
export {
  registerCompensationMetadata,
  registerResourceKeys,
  generateRollbackPlan,
  executeRollbackPlan,
} from './rollbackPlanner';
export type { PlannedToolCall, PlanInput, ExecutePlanOptions } from './rollbackPlanner';
export {
  validatePlanFeasibility,
  assertPlanFeasible,
  CompensationPlanInfeasibleError,
} from './planValidator';
export type { FeasibilityReport, HandlerMap } from './planValidator';
