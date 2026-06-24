import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

export interface FreezeRunInfo {
  runId: string;
  agentId: string;
  phase: string;
  stepNumber: number;
  goal: string;
  frozenAt: string;
  completedToolCalls: number;
}

export interface FreezeManifest {
  version: number;
  frozenAt: string;
  runs: FreezeRunInfo[];
  suggestedCommand: string;
  cwd: string;
}

export interface ActiveRunState {
  runId: string;
  agentId: string;
  phase: string;
  stepNumber: number;
  goal: string;
  completedToolCalls: number;
}

const FREEZE_VERSION = 1;
const MANIFEST_FILE = 'freeze.manifest.json';
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

export class FreezeDryManager {
  private stateDir: string;
  private activeRuns: Map<string, ActiveRunState> = new Map();
  private frozen = false;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? path.join(process.cwd(), '.commander_state');
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  setActiveRuns(runs: Map<string, ActiveRunState>): void {
    this.activeRuns = new Map(runs);
  }

  setRunState(runId: string, state: ActiveRunState): void {
    this.activeRuns.set(runId, state);
  }

  removeRun(runId: string): void {
    this.activeRuns.delete(runId);
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  freeze(): FreezeManifest | null {
    if (this.frozen) return null;
    this.frozen = true;

    const log = getGlobalLogger();
    const now = new Date().toISOString();
    const runEntries: FreezeRunInfo[] = [];

    for (const [runId, runState] of this.activeRuns) {
      const runDir = path.join(this.stateDir, runId);
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

      runEntries.push({
        runId,
        agentId: runState.agentId,
        phase: runState.phase,
        stepNumber: runState.stepNumber,
        goal: runState.goal.slice(0, 500),
        frozenAt: now,
        completedToolCalls: runState.completedToolCalls,
      });

      log.info(
        'FreezeDry',
        `Frozen run ${runId} at step ${runState.stepNumber} (${runState.phase})`,
      );
    }

    const manifest: FreezeManifest = {
      version: FREEZE_VERSION,
      frozenAt: now,
      runs: runEntries,
      suggestedCommand: 'commander up --resume',
      cwd: process.cwd(),
    };

    const manifestPath = path.join(this.stateDir, MANIFEST_FILE);
    const tmpPath = manifestPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.renameSync(tmpPath, manifestPath);
      log.info(
        'FreezeDry',
        `Freeze manifest written to ${manifestPath} (${runEntries.length} runs)`,
      );
    } catch (e) {
      log.error('FreezeDry', 'Failed to write freeze manifest', e as Error);
      this.frozen = false;
      return null;
    }

    return manifest;
  }

  detectFreeze(): FreezeManifest | null {
    const manifestPath = path.join(this.stateDir, MANIFEST_FILE);
    try {
      if (!fs.existsSync(manifestPath)) return null;
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(raw) as FreezeManifest;
    } catch (err) {
      reportSilentFailure(err, 'freezeDry:126');
      return null;
    }
  }

  thaw(): FreezeManifest | null {
    const manifest = this.detectFreeze();
    if (!manifest) return null;

    const log = getGlobalLogger();
    log.info('FreezeDry', `Thawing ${manifest.runs.length} frozen run(s)`);

    const manifestPath = path.join(this.stateDir, MANIFEST_FILE);
    try {
      const archived = manifestPath + '.thawed';
      fs.renameSync(manifestPath, archived);
      log.info('FreezeDry', `Freeze manifest archived to ${archived}`);
    } catch (e) {
      log.warn('FreezeDry', 'Failed to archive freeze manifest', { error: (e as Error).message });
    }

    return manifest;
  }

  prune(): number {
    let pruned = 0;
    const now = Date.now();
    try {
      const entries = fs.readdirSync(this.stateDir);
      for (const entry of entries) {
        if (entry.endsWith('.thawed') || entry.endsWith('.archived')) {
          const filePath = path.join(this.stateDir, entry);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > PRUNE_AFTER_MS) {
              fs.unlinkSync(filePath);
              pruned++;
            }
          } catch (err) {
            reportSilentFailure(err, 'freezeDry:165');
            void 0;
          }
        }
      }
    } catch (err) {
      reportSilentFailure(err, 'freezeDry:171');
      void 0;
    }
    return pruned;
  }

  static getManifestPath(stateDir?: string): string {
    return path.join(stateDir ?? path.join(process.cwd(), '.commander_state'), MANIFEST_FILE);
  }
}

let _freezeInstance: FreezeDryManager | null = null;

export function getFreezeDryManager(stateDir?: string): FreezeDryManager {
  if (!_freezeInstance) {
    _freezeInstance = new FreezeDryManager(stateDir);
  }
  return _freezeInstance;
}

export function resetFreezeDryManager(): void {
  _freezeInstance = null;
}
