import { reportSilentFailure } from '@commander/core';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';

/**
 * Persistent API key store for the HTTP API layer.
 *
 * DESIGN:
 * - Keys are generated as `cmdr_` prefixed random tokens.
 * - Only a SHA-256 hash of the key is persisted; the plaintext is returned
 *   exactly once at creation time and is never recoverable.
 * - Storage is a JSON file in `.commander/api_keys.json` so the API server
 *   can run without better-sqlite3 if needed.
 */

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First 8 characters of the original key, shown in the UI for identification. */
  prefix: string;
  /** SHA-256 hex hash of the full key. */
  hash: string;
  scopes: string[];
  /** Optional tenant this key belongs to. */
  tenantId?: string;
  enabled: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface ApiKeyCreationResult {
  record: ApiKeyRecord;
  /** Plaintext key — returned only once. */
  key: string;
}

const KEYS_FILE = path.join(process.cwd(), '.commander', 'api_keys.json');
const KEY_PREFIX = 'cmdr_';
const KEY_BYTES = 32;

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function generateKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
}

function generateId(): string {
  return `ak_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureDir(): void {
  const dir = path.dirname(KEYS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readRecords(): ApiKeyRecord[] {
  // REL-4: 损坏或错形（如 {"keys":[...]}）均隔离，禁止 silent [] → create() 原地抹钥。
  const parsed = readJsonFileSafe<unknown>(KEYS_FILE, null, Array.isArray);
  return parsed === null ? [] : (parsed as ApiKeyRecord[]);
}

function writeRecords(records: ApiKeyRecord[]): void {
  try {
    // REL-3: fsync-then-rename so API key material is never half-written.
    atomicWriteFileSync(KEYS_FILE, JSON.stringify(records, null, 2));
  } catch (err) {
    reportSilentFailure(err, 'apiKeyStore:writeRecords');
  }
}

export class ApiKeyStore {
  private records: ApiKeyRecord[] = [];

  constructor() {
    this.records = readRecords();
  }

  /** Reload from disk — useful after external rotation. */
  reload(): void {
    this.records = readRecords();
  }

  list(): Omit<ApiKeyRecord, 'hash'>[] {
    return this.records.map(({ hash: _hash, ...rest }) => rest);
  }

  findByHash(hash: string): ApiKeyRecord | undefined {
    return this.records.find((r) => r.enabled && r.hash === hash);
  }

  create(
    name: string,
    scopes: string[] = ['read', 'write'],
    tenantId?: string,
  ): ApiKeyCreationResult {
    const key = generateKey();
    const record: ApiKeyRecord = {
      id: generateId(),
      name: name.trim() || 'API Key',
      prefix: key.slice(0, 8),
      hash: sha256(key),
      scopes: scopes.length > 0 ? scopes : ['read', 'write'],
      tenantId,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    writeRecords(this.records);
    return { record, key };
  }

  revoke(id: string): ApiKeyRecord | undefined {
    const record = this.records.find((r) => r.id === id);
    if (!record || !record.enabled) return undefined;
    record.enabled = false;
    record.revokedAt = new Date().toISOString();
    writeRecords(this.records);
    return record;
  }

  delete(id: string): boolean {
    const initial = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length !== initial) {
      writeRecords(this.records);
      return true;
    }
    return false;
  }
}

let storeSingleton: ApiKeyStore | null = null;

export function getApiKeyStore(): ApiKeyStore {
  if (!storeSingleton) {
    storeSingleton = new ApiKeyStore();
  }
  return storeSingleton;
}

export function resetApiKeyStore(): void {
  storeSingleton = null;
}
