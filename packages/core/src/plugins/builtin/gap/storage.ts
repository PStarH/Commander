// packages/core/src/plugins/builtin/gap/storage.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reportSilentFailure } from '../../../silentFailureReporter';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function appendNdjson<T>(filePath: string, items: T[]): void {
  ensureDir(path.dirname(filePath));
  const lines = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf-8');
}

export function readNdjson<T = unknown>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  const result: T[] = [];
  for (const line of lines) {
    try {
      result.push(JSON.parse(line) as T);
    } catch (err) {
      reportSilentFailure(err, 'gap:storage:parse');
    }
  }
  return result;
}
