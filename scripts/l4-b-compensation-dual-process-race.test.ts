import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('l4-b-compensation-dual-process-race cleanup', () => {
  it('stops and reaps both workers in the outer finally before tenant cleanup', () => {
    const source = readFileSync(
      new URL('./l4-b-compensation-dual-process-race.ts', import.meta.url),
      'utf8',
    );
    const raceSource = source.slice(
      source.indexOf('export async function runDualProcessRace'),
      source.indexOf('\nasync function main'),
    );
    const finallyBody = raceSource.slice(raceSource.lastIndexOf('  } finally {'));
    const stopAndReapWorkers = source.slice(
      source.indexOf('async function stopAndReapWorkers'),
      source.indexOf('\nasync function runWorkerLoop'),
    );

    assert.match(finallyBody, /await stopAndReapWorkers\(stopFile, publisherProc, consumerProc\)/);
    assert.match(stopAndReapWorkers, /await writeFile\(stopFile, 'stop'\)/);
    assert.match(source, /child\.kill\('SIGTERM'\)/);
    assert.match(source, /child\.kill\('SIGKILL'\)/);
    assert.ok(
      finallyBody.indexOf('await stopAndReapWorkers') <
        finallyBody.indexOf('DELETE FROM commander_compensation_finalization_receipts'),
    );
  });
});
