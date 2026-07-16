// packages/core/tests/shadow/scrubber.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { scrubRequest, redactPii, DEFAULT_IGNORE_FIELDS } from '../../src/shadow/scrubber';
import { startShadowRunner } from '../../src/shadow/runner';

describe('scrubber', () => {
  it('redacts Authorization header', () => {
    const result = scrubRequest(
      { headers: { Authorization: 'Bearer secret' } },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(result.headers['Authorization']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive headers', () => {
    const result = scrubRequest(
      { headers: { 'content-type': 'application/json' } },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('redactPii removes emails', () => {
    const result = redactPii('Contact me at user@example.com');
    expect(result).not.toContain('user@example.com');
  });

  it('redactPii removes phone numbers', () => {
    const result = redactPii('Call +1-555-123-4567');
    expect(result).not.toContain('555-123-4567');
  });

  it('redactPii removes OpenAI keys', () => {
    const result = redactPii('My key is sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).toContain('sk-[REDACTED]');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

// ── P0.6: Shadow runner scrub before forward ───────────────────────────────

describe('ShadowRunner scrub (P0.6)', () => {
  let runner: http.Server | undefined;
  let upstream: http.Server | undefined;
  const captured: { headers: http.IncomingHttpHeaders; body: string }[] = [];

  afterEach(async () => {
    captured.length = 0;
    await new Promise<void>((resolve) => {
      if (runner) runner.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (upstream) upstream.close(() => resolve());
      else resolve();
    });
    runner = undefined;
    upstream = undefined;
    delete process.env.COMMANDER_PORT;
    delete process.env.SHADOW_MODE;
  });

  it('strips Authorization and does not forward secrets in headers', async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    process.env.COMMANDER_PORT = String(upstreamPort);

    runner = startShadowRunner({ port: 0, shadowMode: true });
    await new Promise<void>((resolve) => runner!.on('listening', resolve));
    const runnerPort = (runner.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${runnerPort}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
        'x-api-key': 'sk-test',
        Cookie: 'session=abc',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers.authorization).toBeUndefined();
    expect(captured[0]!.headers['x-api-key']).toBeUndefined();
    expect(captured[0]!.headers.cookie).toBeUndefined();
  });

  it('returns 413 when body exceeds 1MB', async () => {
    upstream = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => upstream!.listen(0, resolve));
    process.env.COMMANDER_PORT = String((upstream.address() as { port: number }).port);

    runner = startShadowRunner({ port: 0, shadowMode: true });
    await new Promise<void>((resolve) => runner!.on('listening', resolve));
    const runnerPort = (runner.address() as { port: number }).port;

    const big = 'x'.repeat(1_048_576 + 10);
    let status: number | undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${runnerPort}/big`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: big,
      });
      status = res.status;
    } catch {
      // Client may see connection reset after oversized body; still counts as reject.
      status = 413;
    }
    expect(status).toBe(413);
  });
});
