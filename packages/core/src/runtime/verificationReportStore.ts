/**
 * VerificationReportStore — Persists full verification reports for replay.
 *
 * The UnifiedVerificationPipeline produces rich VerificationReport objects
 * (signals, snippets, suggestions, stages, confidence). Until now, only
 * a reduced boolean was recorded. This store captures the full report so
 * a failed verification can be replayed offline to understand which stage
 * and which signal triggered the failure.
 *
 * Storage: append-only NDJSON per run under .commander_verifications/.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { VerificationReport } from './unifiedVerificationTypes';

export interface StoredVerificationRecord {
  schemaVersion: 1;
  runId: string;
  agentId: string;
  tenantId?: string;
  attempt: number;
  goal: string;
  outputPrefix: string;
  passed: boolean;
  confidence: number;
  skipReason?: string;
  /** Full report for replay. Optional because very old records may lack it. */
  report: VerificationReport;
  capturedAt: string;
}

export class VerificationReportStore {
  private baseDir: string;
  private tenantId?: string;
  private writeQueue: Array<() => Promise<void>> = [];
  private flushing = false;

  constructor(baseDir?: string, tenantId?: string) {
    this.tenantId = tenantId;
    const base = baseDir ?? path.join(process.cwd(), '.commander_verifications');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch (err) {
      reportSilentFailure(err, 'verificationReportStore:47');
      /* best-effort */
    }
  }

  async write(record: StoredVerificationRecord): Promise<void> {
    const line = JSON.stringify(record) + '\n';
    this.enqueueWrite(async () => {
      const filePath = path.join(this.baseDir, `${sanitizeRunId(record.runId)}.ndjson`);
      fs.appendFileSync(filePath, line, 'utf-8');
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (err) {
        reportSilentFailure(err, 'verificationReportStore:60');
        /* best-effort */
      }
    });
  }

  readReports(runId: string): StoredVerificationRecord[] {
    const filePath = path.join(this.baseDir, `${sanitizeRunId(runId)}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const out: StoredVerificationRecord[] = [];
      for (const line of raw.split('\n')) {
        try {
          out.push(JSON.parse(line) as StoredVerificationRecord);
        } catch (err) {
          reportSilentFailure(err, 'verificationReportStore:77');
          // skip corrupt line
        }
      }
      return out;
    } catch (e) {
      getGlobalLogger().warn('VerificationReportStore', 'Failed to read verification reports', {
        error: (e as Error)?.message,
        runId,
      });
      return [];
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.writeQueue.length > 0) {
        const task = this.writeQueue.shift();
        if (task) await task();
      }
    } finally {
      this.flushing = false;
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue.push(task);
    if (!this.flushing) {
      void this.flush();
    }
  }
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const verificationStoreSingleton = createTenantAwareSingleton(() => new VerificationReportStore());

export function getVerificationReportStore(tenantId?: string): VerificationReportStore {
  if (tenantId) return verificationStoreSingleton.getForTenant(tenantId);
  return verificationStoreSingleton.get();
}

export function resetVerificationReportStore(): void {
  verificationStoreSingleton.reset();
}
