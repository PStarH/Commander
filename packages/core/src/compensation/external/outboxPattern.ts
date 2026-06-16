/**
 * Outbox Pattern — delayed commit for irreversible operations.
 *
 * Workflow:
 *   1. stage() → queue operation, return simulated result
 *   2. verify() → check if all staged operations are valid
 *   3. commit() → execute all staged operations
 *   4. discard() → clear queue, zero side effects
 */

import { randomBytes } from 'crypto';

export interface OutboxEntry<T = unknown> {
  id: string;
  operation: string;
  payload: T;
  status: 'staged' | 'committed' | 'discarded';
  stagedAt: string;
  committedAt?: string;
  error?: string;
}

export interface OutboxConfig {
  maxEntries?: number;
  commitTimeoutMs?: number;
}

export interface CommitResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

export class OutboxPattern<T = unknown> {
  private entries: OutboxEntry<T>[] = [];
  private maxEntries: number;
  private commitTimeoutMs: number;
  private executor?: (entry: OutboxEntry<T>) => Promise<{ success: boolean; error?: string }>;

  constructor(
    config: OutboxConfig = {},
    executor?: (entry: OutboxEntry<T>) => Promise<{ success: boolean; error?: string }>,
  ) {
    this.maxEntries = config.maxEntries ?? 1000;
    this.commitTimeoutMs = config.commitTimeoutMs ?? 30000;
    this.executor = executor;
  }

  stage(operation: string, payload: T): OutboxEntry<T> {
    if (this.entries.length >= this.maxEntries) {
      throw new Error(`Outbox full: ${this.entries.length}/${this.maxEntries} entries`);
    }

    const entry: OutboxEntry<T> = {
      id: randomBytes(8).toString('hex'),
      operation,
      payload,
      status: 'staged',
      stagedAt: new Date().toISOString(),
    };

    this.entries.push(entry);
    return entry;
  }

  async verify(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const staged = this.entries.filter((e) => e.status === 'staged');

    for (const entry of staged) {
      if (!entry.operation || entry.operation.length === 0) {
        issues.push(`Entry ${entry.id}: empty operation`);
      }
      if (entry.payload === undefined || entry.payload === null) {
        issues.push(`Entry ${entry.id}: null/undefined payload`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  async commit(): Promise<CommitResult> {
    const staged = this.entries.filter((e) => e.status === 'staged');
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const entry of staged) {
      try {
        if (this.executor) {
          const result = await this.executor(entry);
          if (result.success) {
            entry.status = 'committed';
            entry.committedAt = new Date().toISOString();
            succeeded++;
          } else {
            entry.status = 'discarded';
            entry.error = result.error;
            failed++;
            errors.push(`${entry.id}: ${result.error}`);
          }
        } else {
          entry.status = 'committed';
          entry.committedAt = new Date().toISOString();
          succeeded++;
        }
      } catch (err) {
        entry.status = 'discarded';
        entry.error = String(err);
        failed++;
        errors.push(`${entry.id}: ${String(err)}`);
      }
    }

    return { succeeded, failed, errors };
  }

  discard(): { discarded: number } {
    const staged = this.entries.filter((e) => e.status === 'staged');
    for (const entry of staged) {
      entry.status = 'discarded';
    }
    return { discarded: staged.length };
  }

  getEntries(): OutboxEntry<T>[] {
    return [...this.entries];
  }

  getStagedEntries(): OutboxEntry<T>[] {
    return this.entries.filter((e) => e.status === 'staged');
  }

  getCommittedEntries(): OutboxEntry<T>[] {
    return this.entries.filter((e) => e.status === 'committed');
  }

  getDiscardedEntries(): OutboxEntry<T>[] {
    return this.entries.filter((e) => e.status === 'discarded');
  }

  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }

  stagedSize(): number {
    return this.entries.filter((e) => e.status === 'staged').length;
  }
}

export function createOutboxCompensationHandler<T>(outbox: OutboxPattern<T>) {
  return async () => {
    const result = outbox.discard();
    return { success: true, discarded: result.discarded };
  };
}

export function registerOutboxCompensation<T>(
  registry: { register: (toolName: string, handler: () => Promise<{ success: boolean; discarded?: number }>) => void },
  outbox: OutboxPattern<T>,
  toolName: string = 'outbox:discard',
): void {
  registry.register(toolName, createOutboxCompensationHandler(outbox));
}
