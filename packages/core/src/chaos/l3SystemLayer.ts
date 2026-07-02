// packages/core/src/chaos/l3SystemLayer.ts
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reportSilentFailure } from '../silentFailureReporter';

export interface CpuThrottleOpts {
  durationMs: number;
  percent: number;
}

export interface MemoryPressureOpts {
  limitMb: number;
}

export interface DiskFullOpts {
  constraintMb: number;
}

export class L3SystemLayer {
  async injectCpuThrottle(opts: CpuThrottleOpts): Promise<void> {
    const busyMs = (opts.durationMs * opts.percent) / 100;
    const sleepMs = opts.durationMs - busyMs;
    const end = Date.now() + busyMs;
    while (Date.now() < end) {
      // busy loop
    }
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  async injectMemoryPressure(opts: MemoryPressureOpts): Promise<void> {
    const targetBytes = opts.limitMb * 1024 * 1024;
    const buffers: Buffer[] = [];
    try {
      for (let i = 0; i < 1000; i++) {
        buffers.push(Buffer.alloc(targetBytes / 100));
        if (process.memoryUsage().heapUsed > os.totalmem()) {
          throw new Error('memory exhausted (heap > total)');
        }
      }
    } catch (err) {
      buffers.length = 0;
      throw err;
    }
  }

  async injectDiskFull(opts: DiskFullOpts): Promise<string> {
    const chaosDir = path.join(os.tmpdir(), `chaos-disk-${Date.now()}`);
    fs.mkdirSync(chaosDir);
    const constraintFile = path.join(chaosDir, 'fill.bin');
    const buf = Buffer.alloc(1024 * 1024);
    let written = 0;
    while (written < opts.constraintMb) {
      try {
        fs.appendFileSync(constraintFile, buf);
        written++;
      } catch (err) {
        reportSilentFailure(err, 'chaos:l3:diskFull');
        break;
      }
    }
    return chaosDir;
  }
}
