import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { atomicWriteFileSync } from '../src/atomicWrite';

describe('atomicWriteFileSync', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-write-'));

  after(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('applies owner-only permissions when writing sensitive configuration', () => {
    const file = path.join(directory, 'sensitive.json');
    atomicWriteFileSync(file, '{"apiKey":"secret"}', 0o600);

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
