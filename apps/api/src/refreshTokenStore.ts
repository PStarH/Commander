/**
 * Minimal refresh-token jti store (JSON file under `.commander/`).
 *
 * Tracks active refresh tokens so they can be rotated and revoked.
 * Entries expire at `exp` (unix seconds); revoked jtis are rejected by
 * `isActive` / `consume` until expiry cleanup removes them.
 *
 * Persisted payload is HMAC-signed via IntegrityLayer. Mutations go through
 * a single-process critical section (`mutate`) so concurrent refresh of the
 * same jti cannot double-issue. Multi-replica deployments should migrate to
 * SQLite/Postgres with a unique jti constraint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IntegrityLayer, type SignedEntry } from '@commander/core/security/securityPrimitives';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  /** Unix expiry (seconds), matching JWT `exp`. */
  exp: number;
  revoked: boolean;
}

const STORE_DIR = path.resolve(process.cwd(), '.commander');
const STORE_FILE = path.join(STORE_DIR, 'refresh_tokens.json');

const integrity = new IntegrityLayer(process.env.COMMANDER_INTEGRITY_KEY);

let cache: RefreshTokenRecord[] | null = null;
/** Serialize all store mutations (Node is single-threaded; this also
 *  documents the critical section for future async backends). */
let mutating = false;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function pruneExpired(records: RefreshTokenRecord[]): RefreshTokenRecord[] {
  const t = nowSec();
  return records.filter((r) => r.exp > t);
}

function isSignedEnvelope(value: unknown): value is SignedEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_sig' in value &&
    '_ts' in value &&
    'data' in value
  );
}

function loadUnlocked(): RefreshTokenRecord[] {
  if (cache) {
    return cache;
  }
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cache = [];
      return cache;
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    // Preferred: IntegrityLayer envelope. Reject tampered/unsigned files.
    if (isSignedEnvelope(parsed)) {
      if (!integrity.verify(parsed)) {
        process.stderr.write('[refreshTokenStore] Integrity check failed — treating as empty\n');
        cache = [];
        return cache;
      }
      const records = parsed.data.records;
      cache = Array.isArray(records) ? (records as RefreshTokenRecord[]) : [];
      return cache;
    }

    // Legacy unsigned array — accept once, next save will re-sign.
    if (Array.isArray(parsed)) {
      cache = parsed as RefreshTokenRecord[];
      return cache;
    }

    cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

function saveUnlocked(records: RefreshTokenRecord[]): void {
  cache = records;
  try {
    if (!fs.existsSync(STORE_DIR)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
    }
    const signed = integrity.sign({ records } as Record<string, unknown>);
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(signed, null, 2), 'utf-8');
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    process.stderr.write(`[refreshTokenStore] Failed to write: ${err}\n`);
  }
}

function mutate<T>(fn: (records: RefreshTokenRecord[]) => T): T {
  if (mutating) {
    throw new Error('refreshTokenStore: re-entrant mutation');
  }
  mutating = true;
  try {
    const records = pruneExpired(loadUnlocked());
    return fn(records);
  } finally {
    mutating = false;
  }
}

/** Persist a newly issued refresh jti. */
export function persist(jti: string, userId: string, exp: number): void {
  mutate((records) => {
    const existing = records.findIndex((r) => r.jti === jti);
    if (existing >= 0) {
      records[existing] = { jti, userId, exp, revoked: false };
    } else {
      records.push({ jti, userId, exp, revoked: false });
    }
    saveUnlocked(records);
  });
}

/**
 * Atomically check that jti is active and revoke it.
 * Returns true only for the first successful consumer — concurrent refresh
 * of the same jti cannot both succeed.
 */
export function consume(jti: string): boolean {
  return mutate((records) => {
    const row = records.find((r) => r.jti === jti);
    if (!row || row.revoked || row.exp <= nowSec()) {
      return false;
    }
    row.revoked = true;
    saveUnlocked(records);
    return true;
  });
}

/** Mark a jti as revoked (logout / explicit revoke). */
export function revoke(jti: string): void {
  mutate((records) => {
    const row = records.find((r) => r.jti === jti);
    if (row && !row.revoked) {
      row.revoked = true;
      saveUnlocked(records);
    }
  });
}

/** True when jti exists, is not revoked, and has not expired. */
export function isActive(jti: string): boolean {
  const records = loadUnlocked();
  const row = records.find((r) => r.jti === jti);
  if (!row || row.revoked || row.exp <= nowSec()) {
    return false;
  }
  return true;
}

/** Revoke every active refresh token for a user (e.g. password reset). */
export function revokeAllForUser(userId: string): void {
  mutate((records) => {
    let changed = false;
    for (const row of records) {
      if (row.userId === userId && !row.revoked) {
        row.revoked = true;
        changed = true;
      }
    }
    if (changed) {
      saveUnlocked(records);
    }
  });
}

/** Test helper: clear in-memory + on-disk state. */
export function _resetRefreshTokenStoreForTests(): void {
  cache = [];
  try {
    if (fs.existsSync(STORE_FILE)) {
      fs.unlinkSync(STORE_FILE);
    }
  } catch {
    // ignore
  }
}
