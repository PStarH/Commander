import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { isUrlSafe } from '../src/tools/_utils/urlSafety';
import { safeFetch, performFetch, SafeFetchError } from '../src/tools/_utils/httpClient';
import {
  getOutboundNetworkPolicy,
  pinnedHttpFetch,
  resetOutboundNetworkPolicy,
} from '../src/security/outboundNetworkPolicy';
import { atomicWriteFile } from '../src/tools/_utils/atomicWrite';

describe('isUrlSafe', () => {
  it('blocks localhost variants', () => {
    for (const host of [
      'http://localhost',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://127.0.0.1:8080',
      'http://127.0.0.2',
      'http://127.1.1.1',
      'http://0.0.0.0',
      'http://0.0.0.1',
      'http://[::1]',
    ]) {
      const r = isUrlSafe(host);
      assert.strictEqual(r.safe, false, `expected ${host} to be blocked`);
      assert.ok(r.reason, `expected a reason for ${host}`);
    }
  });

  it('blocks decimal/hex encoded loopback and metadata IPs', () => {
    // Node URL normalizes these to dotted form before our checks.
    assert.strictEqual(isUrlSafe('http://2130706433/').safe, false); // 127.0.0.1
    assert.strictEqual(isUrlSafe('http://0x7f000001/').safe, false);
    assert.strictEqual(isUrlSafe('http://127.1/').safe, false);
    assert.strictEqual(isUrlSafe('http://2852039166/').safe, false); // 169.254.169.254
  });

  it('blocks IPv4-mapped IPv6 private addresses', () => {
    for (const host of [
      'http://[::ffff:7f00:1]/', // 127.0.0.1
      'http://[::ffff:a9fe:a9fe]/', // 169.254.169.254
      'http://[::ffff:a00:1]/', // 10.0.0.1
      'http://[::ffff:c0a8:1]/', // 192.168.0.1
      'http://[::ffff:10.0.0.1]/',
    ]) {
      assert.strictEqual(isUrlSafe(host).safe, false, `expected ${host} to be blocked`);
    }
  });

  it('blocks cloud metadata endpoints', () => {
    assert.strictEqual(isUrlSafe('http://169.254.169.254/latest/meta-data').safe, false);
    assert.strictEqual(isUrlSafe('http://metadata.google.internal/').safe, false);
  });

  it('blocks private IPv4 ranges', () => {
    for (const host of [
      'http://10.0.0.1',
      'http://10.255.255.255',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.1',
      'http://169.254.1.1',
      'http://100.64.0.1', // CGNAT
    ]) {
      assert.strictEqual(isUrlSafe(host).safe, false, `expected ${host} to be blocked`);
    }
  });

  it('blocks IPv6 link-local and ULA', () => {
    assert.strictEqual(isUrlSafe('http://[fe80::1]/').safe, false);
    assert.strictEqual(isUrlSafe('http://[fc00::1]/').safe, false);
    assert.strictEqual(isUrlSafe('http://[fd12:3456:789a::1]/').safe, false);
  });

  it('blocks common internal service ports', () => {
    for (const port of [6379, 27017, 5432, 9200, 11211, 8500, 8300, 8501]) {
      assert.strictEqual(
        isUrlSafe(`http://example.com:${port}`).safe,
        false,
        `expected port ${port} to be blocked`,
      );
    }
  });

  it('allows public URLs with default ports', () => {
    for (const url of [
      'https://example.com',
      'https://example.com:443',
      'http://example.com:80',
      'https://api.github.com/users',
    ]) {
      assert.strictEqual(isUrlSafe(url).safe, true, `expected ${url} to be allowed`);
    }
  });

  it('blocks non-http protocols', () => {
    for (const url of [
      'ftp://example.com',
      'file:///etc/passwd',
      'gopher://example.com',
      'javascript:alert(1)',
    ]) {
      assert.strictEqual(isUrlSafe(url).safe, false, `expected ${url} to be blocked`);
    }
  });

  it('blocks unparseable URLs', () => {
    assert.strictEqual(isUrlSafe('not a url').safe, false);
    assert.strictEqual(isUrlSafe('').safe, false);
  });
});

describe('safeFetch', () => {
  it('throws SafeFetchError on unsafe URLs without making a request', async () => {
    await assert.rejects(
      () => safeFetch('http://localhost:3000'),
      (err: unknown) => err instanceof SafeFetchError && err.code === 'unsafe_url',
    );
  });

  it('fetches a small response and returns body + metadata', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello world');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await performFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body, 'hello world');
      assert.strictEqual(result.bytes, 11);
      assert.strictEqual(result.truncated, false);
      assert.match(result.contentType, /text\/plain/);
    } finally {
      server.close();
    }
  });

  it('truncates responses exceeding maxBytes', async () => {
    const payload = 'x'.repeat(10_000);
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': String(payload.length),
      });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await performFetch(`http://127.0.0.1:${port}/`, {
        timeoutMs: 5000,
        maxBytes: 100,
      });
      assert.strictEqual(result.truncated, true, 'expected truncated=true');
      assert.ok(result.bytes <= 100, `expected bytes <= 100, got ${result.bytes}`);
    } finally {
      server.close();
    }
  });

  it('times out when the server hangs', async () => {
    const server = http.createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await assert.rejects(
        () => performFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 100 }),
        (err: unknown) => err instanceof SafeFetchError && err.code === 'timeout',
      );
    } finally {
      server.close();
    }
  });

  it('propagates an AbortSignal to the pinned request and aborts a slow response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      setTimeout(() => res.end('late'), 500);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const request = pinnedHttpFetch(`http://127.0.0.1:${port}/`, '127.0.0.1', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25).unref();

    try {
      await assert.rejects(request, (error: unknown) => {
        return error instanceof Error && error.name === 'AbortError';
      });
    } finally {
      server.close();
    }
  });

  it('rejects an oversized chunked pinned response before buffering it in full', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      for (let index = 0; index < 6; index += 1) res.write(chunk);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await assert.rejects(
        () => pinnedHttpFetch(`http://127.0.0.1:${port}/`, '127.0.0.1'),
        /response body exceeds 5242880 bytes/,
      );
    } finally {
      server.close();
    }
  });

  it('preserves the original non-default port in the pinned Host header', async () => {
    let receivedHost: string | undefined;
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const response = await pinnedHttpFetch(
        `http://public.example.test:${port}/resource`,
        '127.0.0.1',
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(receivedHost, `public.example.test:${port}`);
    } finally {
      server.close();
    }
  });

  it('returns ok=false for non-2xx responses without throwing', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await performFetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 404);
      assert.strictEqual(result.body, 'not found');
    } finally {
      server.close();
    }
  });

  it('rejects a redirect to a private address before opening the next request', async () => {
    const policy = getOutboundNetworkPolicy({ enabled: true });
    const original = policy.ssrfCheckedFetch;
    const requested: string[] = [];
    policy.ssrfCheckedFetch = async (url: string) => {
      requested.push(url);
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/admin' },
      });
    };
    try {
      await assert.rejects(
        () => safeFetch('https://public.example.test/start'),
        (err: unknown) => err instanceof SafeFetchError && err.code === 'unsafe_url',
      );
      assert.deepStrictEqual(requested, ['https://public.example.test/start']);
    } finally {
      policy.ssrfCheckedFetch = original;
      resetOutboundNetworkPolicy();
    }
  });

  it('follows a public redirect while validating each hop', async () => {
    const policy = getOutboundNetworkPolicy({ enabled: true });
    const original = policy.ssrfCheckedFetch;
    const requested: string[] = [];
    policy.ssrfCheckedFetch = async (url: string) => {
      requested.push(url);
      if (url.endsWith('/start')) {
        return new Response('', {
          status: 302,
          headers: { location: '/article' },
        });
      }
      return new Response('public content', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    };
    try {
      const result = await safeFetch('https://public.example.test/start');
      assert.strictEqual(result.body, 'public content');
      assert.deepStrictEqual(requested, [
        'https://public.example.test/start',
        'https://public.example.test/article',
      ]);
    } finally {
      policy.ssrfCheckedFetch = original;
      resetOutboundNetworkPolicy();
    }
  });
});

describe('atomicWriteFile', () => {
  let tmpDir: string;

  it('creates a new file with the given content', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-'));
    const target = path.join(tmpDir, 'out.txt');
    const result = await atomicWriteFile(target, 'hello');
    assert.strictEqual(result.bytes, 5);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'hello');
    assert.ok(result.tmpPath.includes('.tmp'), 'tmpPath should include .tmp');
    assert.ok(!fs.existsSync(result.tmpPath), 'tmp file should be renamed away');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overwrites an existing file atomically', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-'));
    const target = path.join(tmpDir, 'over.txt');
    fs.writeFileSync(target, 'original');
    await atomicWriteFile(target, 'replaced');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'replaced');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces unique tmp filenames for concurrent invocations', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-'));
    const target = path.join(tmpDir, 'concurrent.txt');
    const results = await Promise.all(
      Array.from({ length: 50 }, () => atomicWriteFile(target, 'x')),
    );
    const tmpPaths = new Set(results.map((r) => r.tmpPath));
    assert.strictEqual(tmpPaths.size, 50, 'all tmp paths must be unique');
    assert.strictEqual(
      fs.readFileSync(target, 'utf-8'),
      'x',
      'final content should be one of the writes',
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes the tmp file when the write fails', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-'));
    const target = path.join(tmpDir, 'nonexistent-subdir', 'file.txt');
    await assert.rejects(() => atomicWriteFile(target, 'x'));
    const entries = fs.readdirSync(tmpDir);
    assert.strictEqual(entries.length, 0, 'no .tmp files should be left behind');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a Buffer with the exact byte length', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-atomic-'));
    const target = path.join(tmpDir, 'buf.bin');
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const result = await atomicWriteFile(target, data);
    assert.strictEqual(result.bytes, 4);
    assert.deepStrictEqual(fs.readFileSync(target), data);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
