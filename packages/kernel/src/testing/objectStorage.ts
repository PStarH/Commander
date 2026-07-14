/**
 * Object storage abstraction for large payloads that should not be stored
 * in the relational database. This includes:
 *
 * - Large event payloads (prompts, completions, tool call arguments)
 * - Artifact content (files, screenshots, generated documents)
 * - Checkpoint snapshots (for run pause/resume)
 *
 * The interface is intentionally minimal — put, get, delete, exists —
 * because the kernel only needs to store and retrieve opaque blobs.
 *
 * Implementations:
 * - `LocalFileObjectStorage` — dev/test, writes to a local directory.
 * - Future: `S3ObjectStorage`, `GcsObjectStorage` for production.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ObjectStorageRef {
  /** Storage backend name (e.g., "local", "s3", "gcs"). */
  backend: string;
  /** Opaque object key / URI. */
  key: string;
  /** Content hash (SHA-256 hex) for integrity verification. */
  digest: string;
  /** Content length in bytes. */
  size: number;
  /** Content MIME type. */
  contentType: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

export interface ObjectStorage {
  /** Store a blob and return a reference. */
  put(input: {
    data: Buffer | string;
    contentType?: string;
    tenantId: string;
    runId: string;
    /** Optional explicit key. If omitted, a UUID is generated. */
    key?: string;
  }): Promise<ObjectStorageRef>;

  /** Retrieve a blob by key. Returns null if not found. */
  get(key: string): Promise<Buffer | null>;

  /** Delete a blob by key. Returns true if deleted. */
  delete(key: string): Promise<boolean>;

  /** Check if a blob exists. */
  exists(key: string): Promise<boolean>;

  /** Get metadata without downloading the blob. */
  head(key: string): Promise<ObjectStorageRef | null>;
}

// ──────────────────────────────────────────────────────────────────────────
// Local file system implementation (dev/test)
// ──────────────────────────────────────────────────────────────────────────

export class LocalFileObjectStorage implements ObjectStorage {
  readonly backend = 'local';
  private readonly basePath: string;

  constructor(basePath: string = '.commander/objects') {
    this.basePath = basePath;
  }

  async put(input: {
    data: Buffer | string;
    contentType?: string;
    tenantId: string;
    runId: string;
    key?: string;
  }): Promise<ObjectStorageRef> {
    const data = typeof input.data === 'string' ? Buffer.from(input.data) : input.data;
    const key = input.key ?? `${input.tenantId}/${input.runId}/${randomUUID()}`;
    const fullPath = this.resolvePath(key);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);

    const digest = createHash('sha256').update(data).digest('hex');

    return {
      backend: this.backend,
      key,
      digest,
      size: data.length,
      contentType: input.contentType ?? 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await unlink(this.resolvePath(key));
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async head(key: string): Promise<ObjectStorageRef | null> {
    try {
      const stats = await stat(this.resolvePath(key));
      const data = await readFile(this.resolvePath(key));
      const digest = createHash('sha256').update(data).digest('hex');
      return {
        backend: this.backend,
        key,
        digest,
        size: stats.size,
        contentType: 'application/octet-stream',
        createdAt: stats.birthtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  private resolvePath(key: string): string {
    // Prevent path traversal — strip leading slashes and ..
    const safe = key.replace(/^\/+/, '').replace(/\.\./g, '');
    return join(this.basePath, safe);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// No-op / null implementation (for tests that don't need object storage)
// ──────────────────────────────────────────────────────────────────────────

export class NullObjectStorage implements ObjectStorage {
  readonly backend = 'null';
  private readonly store = new Map<string, { data: Buffer; ref: ObjectStorageRef }>();

  async put(input: {
    data: Buffer | string;
    contentType?: string;
    tenantId: string;
    runId: string;
    key?: string;
  }): Promise<ObjectStorageRef> {
    const data = typeof input.data === 'string' ? Buffer.from(input.data) : input.data;
    const key = input.key ?? `${input.tenantId}/${input.runId}/${randomUUID()}`;
    const digest = createHash('sha256').update(data).digest('hex');
    const ref: ObjectStorageRef = {
      backend: this.backend,
      key,
      digest,
      size: data.length,
      contentType: input.contentType ?? 'application/octet-stream',
      createdAt: new Date().toISOString(),
    };
    this.store.set(key, { data, ref });
    return ref;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key)?.data ?? null;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async head(key: string): Promise<ObjectStorageRef | null> {
    return this.store.get(key)?.ref ?? null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let objectStorageInstance: ObjectStorage | null = null;

export function getObjectStorage(): ObjectStorage {
  if (!objectStorageInstance) {
    const basePath = process.env.COMMANDER_OBJECT_STORAGE_PATH ?? '.commander/objects';
    objectStorageInstance = new LocalFileObjectStorage(basePath);
  }
  return objectStorageInstance;
}

export function setObjectStorage(storage: ObjectStorage): void {
  objectStorageInstance = storage;
}

export function resetObjectStorage(): void {
  objectStorageInstance = null;
}
