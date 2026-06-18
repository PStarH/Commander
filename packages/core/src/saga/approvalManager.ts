import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ApprovalRequest {
  runId: string;
  nodeId: string;
  approver: string;
  payload: unknown;
  contextSummary?: string;
  requestedAt: string;
  expiresAt?: string;
  sagaName?: string;
  tenantId?: string;
}

export type ApprovalDecision = 'approve' | 'reject';

export interface ApprovalResult {
  decision: ApprovalDecision;
  decidedAt: string;
  decidedBy: string;
  reason?: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<void>;
  get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined>;
  record(request: ApprovalRequest, result: ApprovalResult): Promise<void>;
  outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined>;
  listPending(approver: string): Promise<ApprovalRequest[]>;
  delete(runId: string, nodeId: string): Promise<void>;
}

interface StoredApproval {
  request: ApprovalRequest;
  result?: ApprovalResult;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, StoredApproval>();

  private key(runId: string, nodeId: string): string {
    return `${runId}::${nodeId}`;
  }

  async create(request: ApprovalRequest): Promise<void> {
    const k = this.key(request.runId, request.nodeId);
    if (this.records.has(k)) {
      throw new ApprovalStoreError(
        `Approval already exists for ${request.runId}/${request.nodeId}`,
      );
    }
    this.records.set(k, { request });
  }

  async get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined> {
    return this.records.get(this.key(runId, nodeId))?.request;
  }

  async record(request: ApprovalRequest, result: ApprovalResult): Promise<void> {
    this.records.set(this.key(request.runId, request.nodeId), {
      request,
      result,
    });
  }

  async outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined> {
    return this.records.get(this.key(runId, nodeId))?.result;
  }

  async listPending(approver: string): Promise<ApprovalRequest[]> {
    const pending: ApprovalRequest[] = [];
    for (const entry of this.records.values()) {
      if (entry.result === undefined && entry.request.approver === approver) {
        pending.push(entry.request);
      }
    }
    return pending;
  }

  async delete(runId: string, nodeId: string): Promise<void> {
    this.records.delete(this.key(runId, nodeId));
  }
}

export interface FileApprovalStoreOptions {
  baseDir: string;
}

export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly options: FileApprovalStoreOptions) {}

  private pathFor(runId: string, nodeId: string): string {
    const safeNodeId = nodeId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.options.baseDir, runId, `${safeNodeId}.json`);
  }

  private async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async create(request: ApprovalRequest): Promise<void> {
    const path = this.pathFor(request.runId, request.nodeId);
    if (await this.exists(path)) {
      throw new ApprovalStoreError(
        `Approval already exists for ${request.runId}/${request.nodeId}`,
      );
    }
    await this.ensureDir(dirname(path));
    const tmp = path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ request }), 'utf8');
    await fs.rename(tmp, path);
  }

  async get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined> {
    const path = this.pathFor(runId, nodeId);
    const record = await this.readRecord(path);
    return record?.request;
  }

  async record(request: ApprovalRequest, result: ApprovalResult): Promise<void> {
    const path = this.pathFor(request.runId, request.nodeId);
    await this.ensureDir(dirname(path));
    const tmp = path + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ request, result }), 'utf8');
    await fs.rename(tmp, path);
  }

  async outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined> {
    const path = this.pathFor(runId, nodeId);
    const record = await this.readRecord(path);
    return record?.result;
  }

  async listPending(approver: string): Promise<ApprovalRequest[]> {
    const out: ApprovalRequest[] = [];
    const base = this.options.baseDir;
    let runDirs: string[] = [];
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    for (const runId of runDirs) {
      const runPath = join(base, runId);
      const files = await fs.readdir(runPath, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const filePath = join(runPath, f.name);
        const record = await this.readRecord(filePath);
        if (
          record &&
          record.request !== undefined &&
          record.request.approver === approver &&
          record.result === undefined
        ) {
          out.push(record.request);
        }
      }
    }
    return out;
  }

  async delete(runId: string, nodeId: string): Promise<void> {
    const path = this.pathFor(runId, nodeId);
    try {
      await fs.unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  private async readRecord(path: string): Promise<StoredApproval | undefined> {
    try {
      const content = await fs.readFile(path, 'utf8');
      return JSON.parse(content) as StoredApproval;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}

export interface ApprovalManagerOptions {
  store: ApprovalStore;
}

export interface ApprovalWaitOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export class ApprovalManager {
  constructor(private readonly options: ApprovalManagerOptions) {}

  async request(req: ApprovalRequest): Promise<void> {
    await this.options.store.create(req);
  }

  async decide(runId: string, nodeId: string, result: ApprovalResult): Promise<void> {
    const existing = await this.options.store.get(runId, nodeId);
    if (!existing) {
      throw new ApprovalError(`No approval request for ${runId}/${nodeId}`);
    }
    await this.options.store.record(existing, result);
  }

  async outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined> {
    return this.options.store.outcome(runId, nodeId);
  }

  async waitForDecision(
    runId: string,
    nodeId: string,
    options: ApprovalWaitOptions = {},
  ): Promise<ApprovalResult> {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const signal = options.signal;

    while (true) {
      if (signal?.aborted) {
        throw new ApprovalError('Approval wait aborted');
      }
      const result = await this.options.store.outcome(runId, nodeId);
      if (result) return result;
      await this.sleep(pollIntervalMs, signal);
    }
  }

  async listPending(approver: string): Promise<ApprovalRequest[]> {
    return this.options.store.listPending(approver);
  }

  async cancel(runId: string, nodeId: string): Promise<void> {
    await this.options.store.delete(runId, nodeId);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
    });
  }
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export class ApprovalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalStoreError';
  }
}
