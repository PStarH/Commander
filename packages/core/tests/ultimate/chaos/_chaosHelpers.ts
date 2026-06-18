import { fork, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TmpQueue {
  baseDir: string;
  dbPath: string;
  cleanup: () => void;
}

export function makeTmpQueue(): TmpQueue {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-queue-'));
  const dbPath = path.join(baseDir, 'work_queue.db');
  return {
    baseDir,
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(baseDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function forkWorker<TReq, TRes>(
  entryScript: string,
  req: TReq,
  timeoutMs = 60_000,
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = fork(entryScript, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker timeout after ${timeoutMs}ms. stderr: ${err.slice(-500)}`));
    }, timeoutMs);

    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      err += d.toString();
    });
    child.on('message', (msg) => {
      clearTimeout(timer);
      resolve(msg as TRes);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`worker error: ${e.message}. stderr: ${err.slice(-500)}`));
    });
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL' && signal !== 'SIGTERM') {
        clearTimeout(timer);
        reject(
          new Error(`worker exited code=${code} signal=${signal}. stderr: ${err.slice(-500)}`),
        );
      }
    });
    child.send(req);
  });
}
