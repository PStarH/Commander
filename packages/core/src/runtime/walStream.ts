/**
 * WAL streaming utilities — read event-sourcing WAL lines without loading
 * the full file into memory (M5 segmented WAL foundation).
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';

export interface WalLineRef {
  /** Zero-based line index in the WAL file. */
  index: number;
  line: string;
}

/**
 * Stream non-empty WAL lines with their file index.
 */
export async function* streamWalLines(walPath: string): AsyncGenerator<WalLineRef> {
  if (!fs.existsSync(walPath)) return;

  const stream = fs.createReadStream(walPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let index = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) {
        yield { index, line: trimmed };
      }
      index++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Count non-empty lines in a WAL file without materializing event objects.
 */
export async function countWalLines(walPath: string): Promise<number> {
  let count = 0;
  for await (const _ of streamWalLines(walPath)) {
    count++;
  }
  return count;
}
