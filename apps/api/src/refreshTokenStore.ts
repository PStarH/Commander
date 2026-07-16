/**
 * Minimal refresh-token jti store (JSON file under `.commander/`).
 *
 * Tracks active refresh tokens so they can be rotated and revoked.
 * Entries expire at `exp` (unix seconds); revoked jtis are rejected by
 * `isActive` until expiry cleanup removes them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  /** Unix expiry (seconds), matching JWT `exp`. */
  exp: number;
  revoked: boolean;
}

const STORE_DIR = path.resolve(process.cwd(), '.commander');
const STORE_FILE = path.join(STORE_DIR, 'refresh_tokens.json');

let cache: RefreshTokenRecord[] | null = null;

function load(): RefreshTokenRecord[] {
  if (cache) {
    return cache;
  }
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cache = [];
      return cache;
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as RefreshTokenRecord[];
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(records: RefreshTokenRecord[]): void {
  cache = records;
  try {
    if (!fs.existsSync(STORE_DIR)) {
      fs.mkdirSync(STORE_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    process.stderr.write(`[refreshTokenStore] Failed to write: ${err}\n`);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Drop expired rows so the file does not grow unbounded. */
function pruneExpired(records: RefreshTokenRecord[]): RefreshTokenRecord[] {
  const t = nowSec();
  return records.filter((r) => r.exp > t);
}

/** Persist a newly issued refresh jti. */
export function persist(jti: string, userId: string, exp: number): void {
  const records = pruneExpired(load());
  const existing = records.findIndex((r) => r.jti === jti);
  if (existing >= 0) {
    records[existing] = { jti, userId, exp, revoked: false };
  } else {
    records.push({ jti, userId, exp, revoked: false });
  }
  save(records);
}

/** Mark a jti as revoked (rotation / logout). */
export function revoke(jti: string): void {
  const records = pruneExpired(load());
  const row = records.find((r) => r.jti === jti);
  if (row) {
    row.revoked = true;
    save(records);
  }
}

/** True when jti exists, is not revoked, and has not expired. */
export function isActive(jti: string): boolean {
  const records = load();
  const row = records.find((r) => r.jti === jti);
  if (!row) {
    return false;
  }
  if (row.revoked) {
    return false;
  }
  if (row.exp <= nowSec()) {
    return false;
  }
  return true;
}

/** Revoke every active refresh token for a user (e.g. password reset). */
export function revokeAllForUser(userId: string): void {
  const records = pruneExpired(load());
  let changed = false;
  for (const row of records) {
    if (row.userId === userId && !row.revoked) {
      row.revoked = true;
      changed = true;
    }
  }
  if (changed) {
    save(records);
  }
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
