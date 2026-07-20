/**
 * CLI Commands — Barrel export for all Commander CLI commands.
 */
export { cmdRun, cmdCompany } from './core';
export { cmdInit } from './init';
export { cmdSwarm, cmdDrive } from './orchestrate';
export { cmdStatus, cmdConfig, cmdDoctor, cmdMode } from './manage';
export { cmdGui, cmdSkill, cmdReview, cmdHelp } from './misc';
export { cmdPlugin } from './plugin';
export { cmdUp } from './up';
export { cmdHistory } from './history';
export { cmdExperience } from './experience';
export { cmdDebugIntent } from './debug';
export { cmdBudget } from './budget';
export { cmdCheckpoint } from './checkpoint';
export { cmdGoalJudge } from './goalJudge';

export { cmdQuickstart } from './quickstart';
export { cmdCompletion } from './completion';
export { cmdFeedback } from './feedback';
export { cmdSaga } from './saga';

// Infrastructure commands (background tasks, notifications, scheduler, webhooks)
export { cmdJobs, cmdNotify, cmdSchedule, cmdWebhook } from './infra';
// Security batteries (red-team, compliance audit, adversarial tests)
export { cmdSecurity } from './security';
// Workflow scheduler (create/run/schedule workflows)
export { cmdWorkflow } from './workflow';
// V2 distributed stack diagnostics
export { cmdDiagnose } from './diagnose';
export { cmdAction } from './action';
export { cmdDev } from './dev';

// Small features
export {
  cmdAsk,
  cmdDiff,
  cmdCost,
  cmdUndo,
  cmdApprovalHistory,
  cmdIntelligence,
  cmdResume,
  cmdCompensation,
  processGlobalFlags,
  resolveAlias,
  COMMAND_ALIASES,
} from './small-features';

// Convenience commands
export {
  cmdPr,
  cmdCommit,
  cmdFix,
  cmdExplain,
  cmdTest,
  cmdRefactor,
  cmdLearn,
  cmdMonitor,
} from './convenience';
