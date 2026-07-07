// packages/core/tests/plugins/gap/storage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendNdjson, readNdjson, ensureDir } from '../../../src/plugins/builtin/gap/storage';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-storage-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('storage', () => {
  it('ensureDir creates directory if missing', () => {
    const dir = path.join(tmpDir, 'sub', 'deep');
    ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('appendNdjson writes a single line per item', () => {
    const file = path.join(tmpDir, 'test.ndjson');
    appendNdjson(file, [{ a: 1 }, { a: 2 }]);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('readNdjson parses lines into objects', () => {
    const file = path.join(tmpDir, 'test.ndjson');
    appendNdjson(file, [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
    const result = readNdjson<{ a: number; b: string }>(file);
    expect(result).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('readNdjson returns empty array for missing file', () => {
    const file = path.join(tmpDir, 'missing.ndjson');
    expect(readNdjson(file)).toEqual([]);
  });
});
