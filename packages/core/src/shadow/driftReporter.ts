// packages/core/src/shadow/driftReporter.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DriftEntry } from './types';
import { reportSilentFailure } from '../silentFailureReporter';

export class DriftReporter {
  private buffer: DriftEntry[] = [];

  constructor(private filePath: string) {}

  record(entry: DriftEntry): void {
    this.buffer.push(entry);
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(this.filePath, lines, 'utf-8');
    this.buffer = [];
  }

  detectAnomalies(minConsecutiveSamples: number = 10): DriftEntry[][] {
    if (!fs.existsSync(this.filePath)) return [];
    const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
    const entries: DriftEntry[] = lines
      .map((l) => {
        try {
          return JSON.parse(l) as DriftEntry;
        } catch (err) {
          reportSilentFailure(err, 'shadow:drift:parse');
          return null;
        }
      })
      .filter((e): e is DriftEntry => e !== null);

    const byEndpoint = new Map<string, DriftEntry[]>();
    for (const e of entries) {
      const list = byEndpoint.get(e.endpoint) ?? [];
      list.push(e);
      byEndpoint.set(e.endpoint, list);
    }

    const anomalies: DriftEntry[][] = [];
    for (const list of byEndpoint.values()) {
      let consecutive = 0;
      for (const e of list) {
        if (e.driftDetected) {
          consecutive++;
          if (consecutive >= minConsecutiveSamples) {
            anomalies.push(list.slice(-consecutive));
            break;
          }
        } else {
          consecutive = 0;
        }
      }
    }
    return anomalies;
  }
}
