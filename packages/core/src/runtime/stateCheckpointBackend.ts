/**
 * Pluggable persistence backend for StateCheckpointer (M5).
 *
 * Default: filesystem JSON under `.commander_state/`.
 * Optional: SQLite WAL table via COMMANDER_STATE_CHECKPOINT_BACKEND=sqlite.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getGlobalLogger } from '../logging';
import type { CheckpointState } from './stateCheckpointer';

export type StateCheckpointBackendType = 'filesystem' | 'sqlite';

export interface StateCheckpointBackend {
  readonly type: StateCheckpointBackendType;
  writeActive(runId: string, state: CheckpointState): void;
  readActive(runId: string): CheckpointState | null;
  readActiveAsync(runId: string): Promise<CheckpointState | null>;
  writeTerminal(runId: string, state: CheckpointState): void;
  readTerminal(runId: string): CheckpointState | null;
  deleteActive(runId: string): void;
}

export function resolveStateCheckpointBackendType(
  explicit?: StateCheckpointBackendType,
): StateCheckpointBackendType {
  if (explicit) return explicit;
  const env = process.env.COMMANDER_STATE_CHECKPOINT_BACKEND;
  if (env === 'sqlite' || env === 'filesystem') return env;
  return 'filesystem';
}

export function createStateCheckpointBackend(
  baseDir: string,
  type: StateCheckpointBackendType = resolveStateCheckpointBackendType(),
): StateCheckpointBackend {
  if (type === 'sqlite') {
    try {
      return new SqliteStateCheckpointBackend(baseDir);
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointBackend:sqliteFallback');
      getGlobalLogger().warn(
        'StateCheckpointBackend',
        'SQLite backend unavailable; falling back to filesystem',
        { error: (err as Error)?.message },
      );
    }
  }
  return new FilesystemStateCheckpointBackend(baseDir);
}

// ============================================================================
// Filesystem backend
// ============================================================================

export class FilesystemStateCheckpointBackend implements StateCheckpointBackend {
  readonly type = 'filesystem' as const;
  private readonly baseDir: string;
  private readonly completedDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.completedDir = path.join(baseDir, 'completed');
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.completedDir, { recursive: true, mode: 0o700 });
  }

  writeActive(runId: string, state: CheckpointState): void {
    const tmpPath = path.join(this.baseDir, `${runId}.tmp`);
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    fs.writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, chkPath);
  }

  readActive(runId: string): CheckpointState | null {
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    if (!fs.existsSync(chkPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(chkPath, 'utf-8')) as CheckpointState;
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointBackend:readActive');
      return null;
    }
  }

  async readActiveAsync(runId: string): Promise<CheckpointState | null> {
    const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
    try {
      const raw = await fs.promises.readFile(chkPath, 'utf-8');
      return JSON.parse(raw) as CheckpointState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      reportSilentFailure(err, 'stateCheckpointBackend:readActiveAsync');
      return null;
    }
  }

  writeTerminal(runId: string, state: CheckpointState): void {
    const donePath = path.join(this.completedDir, `${runId}.json`);
    const tmpPath = path.join(this.baseDir, `${runId}.terminal.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, donePath);
    this.deleteActive(runId);
  }

  readTerminal(runId: string): CheckpointState | null {
    const donePath = path.join(this.completedDir, `${runId}.json`);
    if (!fs.existsSync(donePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(donePath, 'utf-8')) as CheckpointState;
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointBackend:readTerminal');
      return null;
    }
  }

  deleteActive(runId: string): void {
    for (const p of [
      path.join(this.baseDir, `${runId}.checkpoint`),
      path.join(this.baseDir, `${runId}.tmp`),
    ]) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (err) {
          reportSilentFailure(err, 'stateCheckpointBackend:deleteActive');
        }
      }
    }
  }
}

// ============================================================================
// SQLite backend
// ============================================================================

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
}

interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
}

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch (err) {
  reportSilentFailure(err, 'stateCheckpointBackend:sqliteImport');
}

export class SqliteStateCheckpointBackend implements StateCheckpointBackend {
  readonly type = 'sqlite' as const;
  private db: BetterSqlite3DB;
  private stmtWriteActive!: BetterSqlite3Stmt;
  private stmtReadActive!: BetterSqlite3Stmt;
  private stmtWriteTerminal!: BetterSqlite3Stmt;
  private stmtReadTerminal!: BetterSqlite3Stmt;
  private stmtDeleteActive!: BetterSqlite3Stmt;
  /**
   * REL-11: read-through to any pre-existing filesystem checkpoints. Switching
   * COMMANDER_STATE_CHECKPOINT_BACKEND=sqlite otherwise strands every in-flight
   * run written by the filesystem backend (the SQLite tables start empty and
   * can never see the old `.checkpoint`/`completed/*.json` files). We lazily
   * import a legacy checkpoint into SQLite on the first read miss so subsequent
   * reads and the resume path find it under the new backend.
   */
  private readonly legacy: FilesystemStateCheckpointBackend;

  constructor(baseDir: string) {
    if (!BetterSqlite3) {
      throw new Error('SqliteStateCheckpointBackend requires better-sqlite3');
    }
    this.legacy = new FilesystemStateCheckpointBackend(baseDir);
    const filePath = path.join(baseDir, 'state_checkpoints.db');
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_checkpoints_active (
        run_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_checkpoints_terminal (
        run_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.stmtWriteActive = this.db.prepare(
      `INSERT INTO state_checkpoints_active (run_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    );
    this.stmtReadActive = this.db.prepare(
      `SELECT state_json FROM state_checkpoints_active WHERE run_id = ?`,
    );
    this.stmtWriteTerminal = this.db.prepare(
      `INSERT INTO state_checkpoints_terminal (run_id, state_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    );
    this.stmtReadTerminal = this.db.prepare(
      `SELECT state_json FROM state_checkpoints_terminal WHERE run_id = ?`,
    );
    this.stmtDeleteActive = this.db.prepare(
      `DELETE FROM state_checkpoints_active WHERE run_id = ?`,
    );

    // REL-11: switching COMMANDER_STATE_CHECKPOINT_BACKEND to sqlite must not
    // orphan runs already checkpointed on the filesystem. Import any existing
    // filesystem checkpoints (active + terminal) that this DB does not yet have,
    // so in-flight runs remain resumable across the backend switch. Idempotent
    // (INSERT ... DO NOTHING) and never overwrites newer SQLite state.
    this.migrateFilesystemCheckpoints(baseDir);
  }

  /** One-time best-effort import of filesystem checkpoints into SQLite. */
  private migrateFilesystemCheckpoints(baseDir: string): void {
    try {
      const insActive = this.db.prepare(
        `INSERT INTO state_checkpoints_active (run_id, state_json, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
      );
      const insTerminal = this.db.prepare(
        `INSERT INTO state_checkpoints_terminal (run_id, state_json, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING`,
      );
      let migrated = 0;

      const importDir = (dir: string, suffix: string, stmt: BetterSqlite3Stmt): void => {
        let names: string[];
        try {
          names = fs.readdirSync(dir);
        } catch {
          return; // dir absent → nothing to migrate
        }
        for (const name of names) {
          if (!name.endsWith(suffix)) continue;
          const runId = name.slice(0, -suffix.length);
          const full = path.join(dir, name);
          try {
            const raw = fs.readFileSync(full, 'utf-8');
            JSON.parse(raw); // validate before importing a torn/partial file
            const mtime = fs.statSync(full).mtime.toISOString();
            if (stmt.run(runId, raw, mtime).changes > 0) migrated += 1;
          } catch (err) {
            reportSilentFailure(err, 'stateCheckpointBackend:migrateEntry');
          }
        }
      };

      importDir(baseDir, '.checkpoint', insActive);
      importDir(path.join(baseDir, 'completed'), '.json', insTerminal);

      if (migrated > 0) {
        getGlobalLogger().info(
          'StateCheckpointBackend',
          `Imported ${migrated} filesystem checkpoint(s) into SQLite backend`,
        );
      }
    } catch (err) {
      reportSilentFailure(err, 'stateCheckpointBackend:migrate');
    }
  }

  writeActive(runId: string, state: CheckpointState): void {
    this.stmtWriteActive.run(runId, JSON.stringify(state), new Date().toISOString());
  }

  readActive(runId: string): CheckpointState | null {
    const row = this.stmtReadActive.get<{ state_json: string }>(runId);
    if (row?.state_json) {
      try {
        return JSON.parse(row.state_json) as CheckpointState;
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointBackend:sqliteReadActive');
        return null;
      }
    }
    // REL-11: read-through + one-time import of a legacy filesystem checkpoint.
    const migrated = this.legacy.readActive(runId);
    if (migrated) {
      try {
        this.writeActive(runId, migrated);
        this.legacy.deleteActive(runId);
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointBackend:sqliteImportActive');
      }
      return migrated;
    }
    return null;
  }

  async readActiveAsync(runId: string): Promise<CheckpointState | null> {
    return this.readActive(runId);
  }

  writeTerminal(runId: string, state: CheckpointState): void {
    this.stmtWriteTerminal.run(runId, JSON.stringify(state), new Date().toISOString());
    this.stmtDeleteActive.run(runId);
  }

  readTerminal(runId: string): CheckpointState | null {
    const row = this.stmtReadTerminal.get<{ state_json: string }>(runId);
    if (row?.state_json) {
      try {
        return JSON.parse(row.state_json) as CheckpointState;
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointBackend:sqliteReadTerminal');
        return null;
      }
    }
    // REL-11: read-through to a legacy terminal checkpoint written pre-switch.
    const migrated = this.legacy.readTerminal(runId);
    if (migrated) {
      try {
        this.stmtWriteTerminal.run(runId, JSON.stringify(migrated), new Date().toISOString());
      } catch (err) {
        reportSilentFailure(err, 'stateCheckpointBackend:sqliteImportTerminal');
      }
      return migrated;
    }
    return null;
  }

  deleteActive(runId: string): void {
    this.stmtDeleteActive.run(runId);
    // Also clear any legacy filesystem copy so it can't resurrect on next read.
    this.legacy.deleteActive(runId);
  }
}
