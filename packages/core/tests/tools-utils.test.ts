import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { isUrlSafe } from '../src/tools/_utils/urlSafety';
import { safeFetch, performFetch, SafeFetchError } from '../src/tools/_utils/httpClient';
import { atomicWriteFile } from '../src/tools/_utils/atomicWrite';

describe('isUrlSafe', () => {
  it('blocks localhost variants', () => {
    for (const host of [
      'http://localhost',
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://127.0.0.1:8080',
      'http://0.0.0.0',
      'http://[::1]',
    ]) {
      const r = isUrlSafe(host);
      assert.strictEqual(r.safe, false, `expected ${host} to be blocked`);
      assert.ok(r.reason, `expected a reason for ${host}`);
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
    ]) {
      assert.strictEqual(isUrlSafe(host).safe, false, `expected ${host} to be blocked`);
    }
  });

  it('blocks IPv6 link-local', () => {
    assert.strictEqual(isUrlSafe('http://[fe80::1]/').safe, false);
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
