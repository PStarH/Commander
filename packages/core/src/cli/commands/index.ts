/**
 * CLI Commands — Barrel export for all Commander CLI commands.
 */
export { cmdRun, cmdCompany } from './core';
export { cmdGoal, cmdSwarm, cmdDrive } from './orchestrate';
export { cmdStatus, cmdConfig, cmdDoctor, cmdMode } from './manage';
export { cmdWorkers, cmdGui, cmdSkill, cmdReview, cmdHelp } from './misc';
export { cmdPlugin } from './plugin';
export { cmdHistory } from './history';
export { cmdWorkflow } from './workflow';
export { cmdBenchmark } from './benchmark';
export { cmdMultiAgentBenchmark } from './multiAgentBenchmark';
export { cmdQuickstart } from './quickstart';
export { cmdCompletion } from './completion';
export { cmdFeedback } from './feedback';
export { cmdSaga } from './saga';

// Small features
export {
  cmdAsk,
  cmdDiff,
  cmdCost,
  cmdUndo,
  cmdApprovalHistory,
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
  cmdWatch,
} from './convenience';

// Deprecated aliases
export { cmdRun as cmdPlan } from './core';
// cmdWatch is already exported from convenience.ts (line 37), not an alias of cmdRun
export { cmdCompany as cmdGoalCompat } from './core';
