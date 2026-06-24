/**
 * GitHub adapter — Settlement Layer vertical for the GitHub REST API.
 *
 * The kernel (atr/) is horizontal. This file is vertical: it knows about
 * pull requests, merge methods, and GitHub's PR state machine. The kernel
 * supplies idempotency, lease, checkpoint version, and saga rollback; this
 * adapter supplies the inverse operations that make rollback possible.
 *
 * Tools exposed:
 *   github_create_pr    → compensated by github_close_pr
 *   github_merge_pr     → compensated by github_revert_pr
 *   github_revert_pr    → non-compensable (a revert is itself a side effect)
 *   github_close_pr     → non-compensable (idempotent re-close is a no-op)
 *
 * Compensation design:
 *   - create_pr records the new PR number in the action result; close_pr
 *     reads that number to close the right PR.
 *   - merge_pr records the merge SHA; revert_pr reverts that SHA.
 *   - revert_pr is best-effort: the inverse of a revert is another revert
 *     and gets messy. We report failure and let the dead-letter queue take it.
 *
 * Testability:
 *   - `createGitHubTools(client?)` accepts a custom GitHubClient. Tests pass
 *     a mock; production uses `defaultGitHubClient` which reads GITHUB_TOKEN.
 *   - The default client throws on construction if no token is set, so the
 *     failure is loud and early (no silent network calls in tests).
 */

import { reportSilentFailure } from '../../silentFailureReporter';
import type { Tool } from '../../runtime/types';
import type { IdempotencyKeyContext } from '../../runtime/types';
import type {
  CompensableAction as LegacyCompensableAction,
  CompensationHandler,
} from '../../runtime/compensationRegistry';
import { canonicalJson, sha256OfCanonical } from '../canonicalJson';

export interface CreatePrArgs {
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface MergePrArgs {
  repo: string;
  number: number;
  method?: 'merge' | 'squash' | 'rebase';
}

export interface RevertPrArgs {
  repo: string;
  number: number;
}

export interface ClosePrArgs {
  repo: string;
  number: number;
}

export interface CreatePrResult {
  number: number;
  url: string;
}

export interface MergePrResult {
  merged: boolean;
  sha: string;
}

export interface RevertPrResult {
  sha: string;
}

export interface GitHubClient {
  createPr(args: CreatePrArgs): Promise<CreatePrResult>;
  mergePr(args: MergePrArgs): Promise<MergePrResult>;
  revertPr(args: RevertPrArgs): Promise<RevertPrResult>;
  closePr(args: ClosePrArgs): Promise<void>;
}

export class GitHubClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubClientError';
    this.status = status;
  }
}

export function defaultGitHubClient(token?: string): GitHubClient {
  const authToken = token ?? process.env.GITHUB_TOKEN;
  if (!authToken) {
    throw new Error(
      'GitHub adapter requires GITHUB_TOKEN env var (or pass a custom GitHubClient). ' +
        'The ATR kernel never reads tokens directly; the adapter owns credential resolution.',
    );
  }
  const base = 'https://api.github.com';
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${authToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'commander-atr/0.1',
  });

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubClientError(
        `GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    return res.json() as Promise<T>;
  };

  return {
    async createPr(args: CreatePrArgs) {
      return call<CreatePrResult>('POST', `/repos/${args.repo}/pulls`, {
        title: args.title,
        body: args.body,
        head: args.head,
        base: args.base,
      });
    },
    async mergePr(args: MergePrArgs) {
      return call<MergePrResult>('PUT', `/repos/${args.repo}/pulls/${args.number}/merge`, {
        merge_method: args.method ?? 'merge',
      });
    },
    async revertPr(args: RevertPrArgs) {
      return call<RevertPrResult>('POST', `/repos/${args.repo}/pulls/${args.number}/reverts`, {});
    },
    async closePr(args: ClosePrArgs) {
      await call<unknown>('PATCH', `/repos/${args.repo}/pulls/${args.number}`, {
        state: 'closed',
      });
    },
  };
}

function keyFor(prefix: string, payload: Record<string, unknown>): string {
  return `github:${prefix}:${sha256OfCanonical(canonicalJson(payload))}`;
}

function safeNumber(args: Record<string, unknown>): number | null {
  const n = args.number;
  if (typeof n === 'number' && Number.isInteger(n)) return n;
  return null;
}

export function createGitHubTools(client: GitHubClient): Map<string, Tool> {
  const tools = new Map<string, Tool>();

  tools.set('github_create_pr', {
    definition: {
      name: 'github_create_pr',
      description: 'Create a GitHub pull request. Compensable: closed on abort.',
      inputSchema: { type: 'object' },
    },
    externalSystem: 'github',
    riskLevel: 'medium',
    destructive: false,
    isIdempotent: true,
    idempotencyKey: (args, _ctx: IdempotencyKeyContext) =>
      keyFor('create_pr', args as Record<string, unknown>),
    execute: async (args) => {
      const r = await client.createPr(args as unknown as CreatePrArgs);
      return JSON.stringify(r);
    },
  });

  tools.set('github_merge_pr', {
    definition: {
      name: 'github_merge_pr',
      description: 'Merge a pull request. Compensable: reverted on abort.',
      inputSchema: { type: 'object' },
    },
    externalSystem: 'github',
    riskLevel: 'high',
    destructive: true,
    isIdempotent: true,
    idempotencyKey: (args, _ctx: IdempotencyKeyContext) =>
      keyFor('merge_pr', { repo: args.repo, number: args.number, method: args.method ?? 'merge' }),
    execute: async (args) => {
      const r = await client.mergePr(args as unknown as MergePrArgs);
      return JSON.stringify(r);
    },
  });

  tools.set('github_revert_pr', {
    definition: {
      name: 'github_revert_pr',
      description: 'Revert a merged pull request. Non-compensable.',
      inputSchema: { type: 'object' },
    },
    externalSystem: 'github',
    riskLevel: 'high',
    destructive: true,
    isIdempotent: true,
    idempotencyKey: (args, _ctx: IdempotencyKeyContext) =>
      keyFor('revert_pr', { repo: args.repo, number: args.number }),
    execute: async (args) => {
      const r = await client.revertPr(args as unknown as RevertPrArgs);
      return JSON.stringify(r);
    },
  });

  tools.set('github_close_pr', {
    definition: {
      name: 'github_close_pr',
      description: 'Close a pull request. Non-compensable; idempotent re-close is a no-op.',
      inputSchema: { type: 'object' },
    },
    externalSystem: 'github',
    riskLevel: 'medium',
    destructive: false,
    isIdempotent: true,
    idempotencyKey: (args, _ctx: IdempotencyKeyContext) =>
      keyFor('close_pr', { repo: args.repo, number: args.number }),
    execute: async (args) => {
      await client.closePr(args as unknown as ClosePrArgs);
      return JSON.stringify({ closed: true, number: (args as { number: number }).number });
    },
  });

  return tools;
}

export function getGitHubCompensationHandlers(
  client: GitHubClient,
): Record<string, CompensationHandler> {
  return {
    github_create_pr: async (
      action: LegacyCompensableAction,
    ): Promise<{ success: boolean; error?: string }> => {
      const repo = action.args.repo as string;
      let number: number | null = null;
      const result = (action as { result?: string }).result;
      if (result) {
        try {
          const parsed = JSON.parse(result) as { number?: number };
          number = safeNumber(parsed);
        } catch (err) {
          reportSilentFailure(err, 'github:252');
          /* swallow */
        }
      }
      if (!repo || number === null) {
        return {
          success: false,
          error: 'create_pr compensation missing repo/PR number in action result',
        };
      }
      try {
        await client.closePr({ repo, number });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },

    github_merge_pr: async (
      action: LegacyCompensableAction,
    ): Promise<{ success: boolean; error?: string }> => {
      const repo = action.args.repo as string;
      const number = safeNumber(action.args);
      if (!repo || number === null) {
        return { success: false, error: 'merge_pr compensation missing repo/PR number' };
      }
      try {
        await client.revertPr({ repo, number });
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },

    github_revert_pr: async (
      _action: LegacyCompensableAction,
    ): Promise<{ success: boolean; error?: string }> => {
      return {
        success: false,
        error:
          'github_revert_pr is non-compensable: a revert is itself a side effect. ' +
          'The original merge has already been undone; further automatic rollback is unsafe.',
      };
    },

    github_close_pr: async (
      _action: LegacyCompensableAction,
    ): Promise<{ success: boolean; error?: string }> => {
      return { success: true };
    },
  };
}

export const GITHUB_TOOL_NAMES = [
  'github_create_pr',
  'github_merge_pr',
  'github_revert_pr',
  'github_close_pr',
] as const;

export type GitHubToolName = (typeof GITHUB_TOOL_NAMES)[number];
