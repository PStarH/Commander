/**
 * Barrel exports + one-shot registration for the external compensation
 * handlers. Calling `registerAllExternalCompensation()` wires the
 * filesystem, database, GitHub, Slack, Stripe, Notion, Jira, Linear,
 * AWS, SendGrid, Git shadow, outbox, and convergence handlers.
 */

export * from './types';
export * from './httpClient';
export * as filesystem from './filesystem';
export * as database from './database';
export * as github from './github';
export * as slack from './slack';
export * as stripe from './stripe';
export * as notion from './notion';
export * as jira from './jira';
export * as linear from './linear';
export * as snapshotStore from './snapshotStore';
export * as aws from './aws';
export * as sendgrid from './sendgrid';
export * as gitShadow from './gitShadow';
export * as outboxPattern from './outboxPattern';
export * as agentConvergence from './agentConvergence';

import type { CompensationHandler } from '../../runtime/compensationRegistry';
import * as fs from './filesystem';
import * as db from './database';
import * as gh from './github';
import * as sl from './slack';
import * as st from './stripe';
import * as no from './notion';
import * as ji from './jira';
import * as li from './linear';
import * as awsMod from './aws';
import * as sg from './sendgrid';

/**
 * Register every external compensation handler. Idempotent — safe to
 * call multiple times. Does not require credentials at registration
 * time; credentials are read lazily on first compensation.
 */
export function registerAllExternalCompensation(registry?: {
  register: (toolName: string, handler: CompensationHandler) => void;
}): void {
  fs.registerFilesystemCompensation();
  db.registerDatabaseCompensation();
  gh.registerGitHubCompensation();
  sl.registerSlackCompensation();
  st.registerStripeCompensation();
  no.registerNotionCompensation();
  ji.registerJiraCompensation();
  li.registerLinearCompensation();
  if (registry) {
    awsMod.registerAWSCompensation(registry);
    sg.registerSendGridCompensation(registry);
  }
}

/**
 * Look up the risk tags for a tool. Combines filesystem, database,
 * and external tags. Returns an empty array if the tool is unknown.
 */
export function getToolTags(toolName: string): string[] {
  return (
    fs.FILESYSTEM_TOOL_TAGS[toolName] ??
    db.DATABASE_TOOL_TAGS[toolName] ??
    gh.GITHUB_TOOL_TAGS[toolName] ??
    sl.SLACK_TOOL_TAGS[toolName] ??
    st.STRIPE_TOOL_TAGS[toolName] ??
    no.NOTION_TOOL_TAGS[toolName] ??
    ji.JIRA_TOOL_TAGS[toolName] ??
    li.LINEAR_TOOL_TAGS[toolName] ??
    awsMod.AWS_TOOL_TAGS[toolName] ??
    sg.SENDGRID_TOOL_TAGS[toolName] ??
    []
  );
}

/**
 * Look up the dollar cost of a tool. Returns 0 if unknown.
 */
export function getToolCost(toolName: string): number {
  return gh.GITHUB_TOOL_COST_USD[toolName] ?? st.STRIPE_TOOL_COST_USD[toolName] ?? 0;
}
