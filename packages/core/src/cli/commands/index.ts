/**
 * CLI Commands — Barrel export for all Commander CLI commands.
 */
export { cmdRun, cmdCompany } from './core';
export { cmdSwarm, cmdDrive } from './orchestrate';
export { cmdStatus, cmdConfig, cmdDoctor, cmdMode } from './manage';
export { cmdGui, cmdSkill, cmdReview, cmdHelp } from './misc';
export { cmdPlugin } from './plugin';
export { cmdUp } from './up';
export { cmdHistory } from './history';

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
