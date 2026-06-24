import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SagaStateSnapshot, SagaEvent } from './types';

export interface SagaStore {
  appendEvent(event: SagaEvent): Promise<void>;
  readEvents(runId: string): Promise<SagaEvent[]>;
  writeSnapshot(snapshot: SagaStateSnapshot): Promise<void>;
  readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined>;
  /** Look up a completed snapshot by business-level idempotency key.
   *  Returns the COMMITTED snapshot if found, undefined otherwise.
   *  This enables cross-request deduplication: if the same idempotencyKey
   *  is submitted again (e.g. gateway retry), the existing result is
   *  returned without re-execution. */
  findByIdempotencyKey(key: string): Promise<SagaStateSnapshot | undefined>;
  listRunIds(): Promise<string[]>;
  deleteRun(runId: string): Promise<void>;
}

export interface FileSagaStoreOptions {
  baseDir: string;
  prettyPrint?: boolean;
}

export class FileSagaStore implements SagaStore {
  constructor(private readonly options: FileSagaStoreOptions) {}

  private eventsPath(runId: string): string {
    return join(this.options.baseDir, runId, 'events.ndjson');
  }

  private snapshotPath(runId: string): string {
    return join(this.options.baseDir, runId, 'snapshot.json');
  }

  private async ensureDir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  async appendEvent(event: SagaEvent): Promise<void> {
    const path = this.eventsPath(event.runId);
    await this.ensureDir(dirname(path));
    await fs.appendFile(path, JSON.stringify(event) + '\n', 'utf8');
  }

  async readEvents(runId: string): Promise<SagaEvent[]> {
    const path = this.eventsPath(runId);
    try {
      const content = await fs.readFile(path, 'utf8');
      return content
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SagaEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async writeSnapshot(snapshot: SagaStateSnapshot): Promise<void> {
    const path = this.snapshotPath(snapshot.runId);
    const tmpPath = path + '.tmp';
    await this.ensureDir(dirname(path));
    const body = this.options.prettyPrint
      ? JSON.stringify(snapshot, null, 2)
      : JSON.stringify(snapshot);
    await fs.writeFile(tmpPath, body, 'utf8');
    await fs.rename(tmpPath, path);
  }

  async readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined> {
    const path = this.snapshotPath(runId);
    try {
      const content = await fs.readFile(path, 'utf8');
      return JSON.parse(content) as SagaStateSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async listRunIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.options.baseDir, {
        withFileTypes: true,
      });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async findByIdempotencyKey(key: string): Promise<SagaStateSnapshot | undefined> {
    try {
      const ids = await this.listRunIds();
      for (const runId of ids) {
        const snapshot = await this.readSnapshot(runId);
        if (snapshot?.idempotencyKey === key && snapshot.state === 'COMMITTED') {
          return snapshot;
        }
      }
    } catch (err) {
      console.warn('[Catch]', err);
      // If listing fails, silently return undefined
    }
    return undefined;
  }

  async deleteRun(runId: string): Promise<void> {
    const path = join(this.options.baseDir, runId);
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

export class InMemorySagaStore implements SagaStore {
  private readonly events = new Map<string, SagaEvent[]>();
  private readonly snapshots = new Map<string, SagaStateSnapshot>();
  /** Reverse index: idempotencyKey → runId */
  private readonly idempotencyIndex = new Map<string, string>();

  async appendEvent(event: SagaEvent): Promise<void> {
    const list = this.events.get(event.runId) ?? [];
    list.push(event);
    this.events.set(event.runId, list);
  }

  async readEvents(runId: string): Promise<SagaEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  async writeSnapshot(snapshot: SagaStateSnapshot): Promise<void> {
    this.snapshots.set(snapshot.runId, snapshot);
    if (snapshot.idempotencyKey) {
      this.idempotencyIndex.set(snapshot.idempotencyKey, snapshot.runId);
    }
  }

  async readSnapshot(runId: string): Promise<SagaStateSnapshot | undefined> {
    return this.snapshots.get(runId);
  }

  async findByIdempotencyKey(key: string): Promise<SagaStateSnapshot | undefined> {
    const runId = this.idempotencyIndex.get(key);
    if (!runId) return undefined;
    const snapshot = this.snapshots.get(runId);
    if (snapshot && snapshot.state !== 'COMMITTED') return undefined;
    return snapshot;
  }

  async listRunIds(): Promise<string[]> {
    const ids = new Set<string>([...this.events.keys(), ...this.snapshots.keys()]);
    return Array.from(ids);
  }

  async deleteRun(runId: string): Promise<void> {
    const snapshot = this.snapshots.get(runId);
    if (snapshot?.idempotencyKey) {
      this.idempotencyIndex.delete(snapshot.idempotencyKey);
    }
    this.events.delete(runId);
    this.snapshots.delete(runId);
  }
}
