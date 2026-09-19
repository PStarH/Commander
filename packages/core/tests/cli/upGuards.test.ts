import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as path from 'node:path';
import type * as http from 'node:http';

import { bindLoopbackWithRetry, resolveStaticFilePath } from '../../src/cli/commands/up';
import { checkWorkerPlaneHealth } from '../../src/cli/commands/diagnose';

// ============================================================================
// CLI-05 — static file containment must be a real directory-boundary check
// ============================================================================

describe('commander up static file containment (CLI-05)', () => {
  const webDist = path.join(path.sep, 'srv', 'commander', 'apps', 'web', 'dist');

  it('serves a path inside the web root', () => {
    assert.strictEqual(
      resolveStaticFilePath(webDist, '/assets/app.js'),
      path.join(webDist, 'assets', 'app.js'),
    );
  });

  it('refuses a sibling directory whose resolved path shares the web-root prefix', () => {
    // `<webDist>-private/secret.txt` passes a string-prefix check but is outside.
    assert.strictEqual(resolveStaticFilePath(webDist, '/../dist-private/secret.txt'), null);
  });

  it('refuses parent traversal above the web root', () => {
    assert.strictEqual(resolveStaticFilePath(webDist, '/../../commander.env'), null);
  });

  it('keeps an in-root entry whose name merely starts with dots', () => {
    assert.strictEqual(
      resolveStaticFilePath(webDist, '/..data/chunk.js'),
      path.join(webDist, '..data', 'chunk.js'),
    );
  });
});

// ============================================================================
// CLI-04 — the EADDRINUSE retry must keep the loopback host and be bounded
// ============================================================================

describe('commander up listen retry (CLI-04)', () => {
  function fakeServer(options: {
    initialPort: number;
    failAlways?: boolean;
    failFirst?: boolean;
  }): { server: http.Server; calls: Array<{ port: number; host?: string }> } {
    const calls: Array<{ port: number; host?: string }> = [];
    let errorListener: ((err: NodeJS.ErrnoException) => void) | undefined;
    const server = {
      on(event: string, listener: (err: NodeJS.ErrnoException) => void) {
        if (event === 'error') errorListener = listener;
        return server;
      },
      listen(port: number, hostOrCallback?: string | (() => void), maybeCallback?: () => void) {
        const host = typeof hostOrCallback === 'string' ? hostOrCallback : undefined;
        const callback = typeof hostOrCallback === 'function' ? hostOrCallback : maybeCallback;
        calls.push({ port, host });
        const collides =
          options.failAlways === true ||
          (options.failFirst === true && port === options.initialPort);
        queueMicrotask(() => {
          if (collides) errorListener?.({ code: 'EADDRINUSE' } as NodeJS.ErrnoException);
          else callback?.();
        });
        return server;
      },
    };
    return { server: server as unknown as http.Server, calls };
  }

  it('pins 127.0.0.1 on the retry after EADDRINUSE', async () => {
    const { server, calls } = fakeServer({ initialPort: 5100, failFirst: true });
    const bound = await bindLoopbackWithRetry(server, 5100);
    assert.strictEqual(bound, 5101);
    assert.deepStrictEqual(calls, [
      { port: 5100, host: '127.0.0.1' },
      { port: 5101, host: '127.0.0.1' },
    ]);
  });

  it('stops retrying after the bounded retry count', async () => {
    const { server, calls } = fakeServer({ initialPort: 5200, failAlways: true });
    await assert.rejects(() => bindLoopbackWithRetry(server, 5200, 3), /no free port/);
    assert.strictEqual(calls.length, 4); // initial bind + 3 retries
    assert.ok(calls.every((call) => call.host === '127.0.0.1'));
  });
});

// ============================================================================
// CLI-05 sub-claim — diagnostics must not print DATABASE_URL credentials
// ============================================================================

describe('commander diagnose env redaction (CLI-05)', () => {
  it('redacts DATABASE_URL credentials in the worker-plane result', () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://admin:s3cretPass@db.internal:5432/prod';
    try {
      const result = checkWorkerPlaneHealth().find((r) => r.label === 'DATABASE_URL');
      assert.ok(result, 'DATABASE_URL check result must exist');
      assert.ok(
        !result.message.includes('s3cretPass'),
        `credential leaked into diagnostics: ${result.message}`,
      );
      assert.ok(
        result.message.includes('//****@'),
        `expected the redacted form: ${result.message}`,
      );
      assert.ok(
        result.message.includes('db.internal:5432/prod'),
        `host must stay visible for diagnostics: ${result.message}`,
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
