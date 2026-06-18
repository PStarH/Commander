/**
 * Git Shadow Workspace — automatic branch isolation for agent operations.
 *
 * Workflow:
 *   1. createShadowBranch() → save current HEAD, create agent branch
 *   2. During execution → changes are committed to shadow branch
 *   3. On success → mergeToMain() with PR description
 *   4. On failure → rollback() discards shadow branch entirely
 */

import { execSync, exec as execCb } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(execCb);

export interface GitShadowConfig {
  repoPath?: string;
  branchPrefix?: string;
  autoCommit?: boolean;
  commitMessagePrefix?: string;
  dryRun?: boolean;
}

export interface ShadowBranchInfo {
  branchName: string;
  baseCommit: string;
  createdAt: string;
}

export interface CommitResult {
  success: boolean;
  commitHash?: string;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  mergeCommit?: string;
  error?: string;
}

export class GitShadowWorkspace {
  private repoPath: string;
  private branchPrefix: string;
  private autoCommit: boolean;
  private commitMessagePrefix: string;
  private dryRun: boolean;
  private currentBranch: ShadowBranchInfo | null = null;

  constructor(config: GitShadowConfig = {}) {
    this.repoPath = config.repoPath ?? process.cwd();
    this.branchPrefix = config.branchPrefix ?? 'agent/';
    this.autoCommit = config.autoCommit ?? true;
    this.commitMessagePrefix = config.commitMessagePrefix ?? '[agent]';
    this.dryRun = config.dryRun ?? false;
  }

  private git(args: string): string {
    return execSync(`git ${args}`, {
      cwd: this.repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  private async gitAsync(args: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: this.repoPath,
      encoding: 'utf-8',
    });
    return stdout.trim();
  }

  async getCurrentBranch(): Promise<string> {
    return this.gitAsync('rev-parse --abbrev-ref HEAD');
  }

  async getCurrentCommit(): Promise<string> {
    return this.gitAsync('rev-parse HEAD');
  }

  async isClean(): Promise<boolean> {
    const status = await this.gitAsync('status --porcelain');
    return status.length === 0;
  }

  async createShadowBranch(taskId: string): Promise<ShadowBranchInfo> {
    const baseCommit = await this.getCurrentCommit();
    const currentBranch = await this.getCurrentBranch();
    const suffix = randomBytes(4).toString('hex');
    const branchName = `${this.branchPrefix}${taskId}-${suffix}`;

    if (this.dryRun) {
      this.currentBranch = {
        branchName,
        baseCommit,
        createdAt: new Date().toISOString(),
      };
      return this.currentBranch;
    }

    await this.gitAsync(`checkout -b ${branchName}`);

    this.currentBranch = {
      branchName,
      baseCommit,
      createdAt: new Date().toISOString(),
    };

    return this.currentBranch;
  }

  async commitChanges(description: string): Promise<CommitResult> {
    if (!this.currentBranch) {
      return { success: false, error: 'No shadow branch active' };
    }

    const isClean = await this.isClean();
    if (isClean) {
      return { success: true, commitHash: await this.getCurrentCommit() };
    }

    if (this.dryRun) {
      return { success: true, commitHash: 'dry-run-hash' };
    }

    try {
      await this.gitAsync('add .');
      const message = `${this.commitMessagePrefix} ${description}`;
      await this.gitAsync(`commit -m "${message}"`);
      const commitHash = await this.getCurrentCommit();
      return { success: true, commitHash };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async rollback(): Promise<{ success: boolean; error?: string }> {
    if (!this.currentBranch) {
      return { success: true };
    }

    if (this.dryRun) {
      this.currentBranch = null;
      return { success: true };
    }

    try {
      const mainBranch = await this.gitAsync('rev-parse --verify main')
        .catch(() => this.gitAsync('rev-parse --verify master'))
        .catch(() => 'main');

      await this.gitAsync(`checkout ${mainBranch}`);
      await this.gitAsync(`branch -D ${this.currentBranch.branchName}`);
      this.currentBranch = null;
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async mergeToMain(
    options: {
      prTitle?: string;
      prBody?: string;
      deleteBranch?: boolean;
    } = {},
  ): Promise<MergeResult> {
    if (!this.currentBranch) {
      return { success: false, error: 'No shadow branch active' };
    }

    if (this.dryRun) {
      this.currentBranch = null;
      return { success: true, mergeCommit: 'dry-run-merge' };
    }

    try {
      const mainBranch = await this.gitAsync('rev-parse --verify main')
        .catch(() => this.gitAsync('rev-parse --verify master'))
        .catch(() => 'main');

      await this.gitAsync(`checkout ${mainBranch}`);
      await this.gitAsync(
        `merge --no-ff ${this.currentBranch.branchName} -m "${options.prTitle ?? 'Merge agent changes'}"`,
      );

      const mergeCommit = await this.getCurrentCommit();

      if (options.deleteBranch !== false) {
        await this.gitAsync(`branch -d ${this.currentBranch.branchName}`);
      }

      this.currentBranch = null;
      return { success: true, mergeCommit };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async getDiff(): Promise<string> {
    if (!this.currentBranch) {
      return '';
    }

    if (this.dryRun) {
      return 'dry-run-diff';
    }

    return this.gitAsync(`diff ${this.currentBranch.baseCommit}..HEAD`);
  }

  async getStatus(): Promise<{
    branch: string | null;
    baseCommit: string | null;
    filesChanged: number;
    insertions: number;
    deletions: number;
  }> {
    if (!this.currentBranch) {
      return { branch: null, baseCommit: null, filesChanged: 0, insertions: 0, deletions: 0 };
    }

    if (this.dryRun) {
      return {
        branch: this.currentBranch.branchName,
        baseCommit: this.currentBranch.baseCommit,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
    }

    const diffStat = await this.gitAsync(`diff --stat ${this.currentBranch.baseCommit}..HEAD`);
    const lines = diffStat.split('\n');
    const lastLine = lines[lines.length - 1] || '';
    const match = lastLine.match(
      /(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/,
    );

    return {
      branch: this.currentBranch.branchName,
      baseCommit: this.currentBranch.baseCommit,
      filesChanged: match ? parseInt(match[1], 10) : 0,
      insertions: match?.[2] ? parseInt(match[2], 10) : 0,
      deletions: match?.[3] ? parseInt(match[3], 10) : 0,
    };
  }

  getActiveBranch(): ShadowBranchInfo | null {
    return this.currentBranch;
  }
}

export function createGitShadowCompensationHandler(workspace: GitShadowWorkspace) {
  return async () => {
    const result = await workspace.rollback();
    return result;
  };
}

export function registerGitShadowCompensation(
  registry: {
    register: (
      toolName: string,
      handler: () => Promise<{ success: boolean; error?: string }>,
    ) => void;
  },
  workspace: GitShadowWorkspace,
): void {
  registry.register('git:shadow:rollback', createGitShadowCompensationHandler(workspace));
}
