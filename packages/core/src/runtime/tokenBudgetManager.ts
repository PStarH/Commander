/**
 * TokenBudgetManager — backward-compatible re-export.
 *
 * The per-run budget allocation API has been merged into TokenGovernor.
 * Keep this file so existing imports from './tokenBudgetManager' continue
 * to work without changes.
 */
export {
  TokenBudgetManager,
  getTokenBudgetManager,
  resetTokenBudgetManager,
} from './tokenGovernor';
export type { SubAgentAllocation, RunBudgetStatus, TokenBudgetConfig } from './tokenGovernor';
