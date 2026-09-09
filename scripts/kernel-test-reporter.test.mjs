import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import reporter from './kernel-test-reporter.mjs';
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

test('failure evidence excludes arbitrary messages, names, and host paths', async () => {
  const events = [
    {
      type: 'test:fail',
      data: {
        name: 'private test label',
        file: 'C:\\agent\\packages\\kernel\\src\\kernel.test.ts',
        line: 42,
        column: 3,
        details: {
          error: {
            message: 'private failure details',
            code: 'ERR_TEST_FAILURE',
            failureType: 'testCodeFailure',
            cause: { code: 'ERR_ASSERTION', actual: 'private value' },
          },
        },
      },
    },
  ];
  let output = '';
  for await (const chunk of reporter(events)) output += chunk;
  assert.deepEqual(JSON.parse(output), {
    event: 'failure',
    file: 'packages/kernel/src/kernel.test.ts',
    line: 42,
    failureType: 'testCodeFailure',
    code: 'ERR_TEST_FAILURE',
    causeCode: 'ERR_ASSERTION',
  });
  assert.ok(!output.includes('private'));
  assert.ok(!output.includes('agent'));
});

test('the reporter preserves real test failure exit status', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter',
      fileURLToPath(new URL('./kernel-test-reporter.mjs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/kernel-reporter/failure.mjs', import.meta.url)),
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes('"event":"failure"'));
  assert.ok(!result.stdout.includes('private'));
});
