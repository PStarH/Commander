import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OutputTruncator, type TruncationResult } from '../src/runtime/outputTruncator';

describe('OutputTruncator', () => {
  let truncator: OutputTruncator;

  describe('disabled and no-op', () => {
    it('passes content through when disabled', () => {
      truncator = new OutputTruncator({ enabled: false });
      const big = 'x'.repeat(100_000);
      const r = truncator.truncate(big);
      assert.equal(r.truncated, false);
      assert.equal(r.content, big);
    });

    it('passes through with strategy=none', () => {
      truncator = new OutputTruncator({ strategy: 'none' });
      const big = 'x'.repeat(100_000);
      const r = truncator.truncate(big);
      assert.equal(r.truncated, false);
      assert.equal(r.content, big);
    });

    it('passes through small content', () => {
      truncator = new OutputTruncator();
      const small = 'hello world';
      const r = truncator.truncate(small);
      assert.equal(r.truncated, false);
      assert.equal(r.content, small);
      assert.equal(r.elidedBytes, 0);
    });
  });

  describe('head-tail strategy', () => {
    beforeEach(() => {
      truncator = new OutputTruncator({
        maxBytes: 500,
        headLines: 5,
        tailLines: 5,
        strategy: 'head-tail',
      });
    });

    it('keeps first N and last M lines', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
      const r = truncator.truncate(lines.join('\n'));
      assert.equal(r.truncated, true);
      assert.equal(r.strategy, 'head-tail');
      const out = r.content;
      assert.ok(out.startsWith('line 0\n'));
      assert.ok(out.includes('line 4'));
      assert.ok(out.includes('line 195'));
      assert.ok(out.endsWith('line 199'));
    });

    it('includes elision marker with byte counts', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `L${i}`);
      const r = truncator.truncate(lines.join('\n'));
      assert.match(r.content, /\[\d+ bytes elided from \d+ total\]/);
      assert.ok(r.elidedBytes > 0);
    });

    it('falls back to byte truncation when lines are very long', () => {
      truncator = new OutputTruncator({
        maxBytes: 1000,
        headLines: 1000,
        tailLines: 1000,
        headBytes: 100,
        tailBytes: 100,
        strategy: 'head-tail',
      });
      const content = 'a'.repeat(10_000);
      const r = truncator.truncate(content);
      assert.equal(r.truncated, true);
      assert.ok(r.content.length < content.length);
    });
  });

  describe('head-tail-bytes strategy', () => {
    beforeEach(() => {
      truncator = new OutputTruncator({
        maxBytes: 1000,
        headBytes: 200,
        tailBytes: 200,
        strategy: 'head-tail-bytes',
      });
    });

    it('preserves head and tail bytes', () => {
      const content = 'A'.repeat(100) + 'B'.repeat(5000) + 'C'.repeat(100);
      const r = truncator.truncate(content);
      assert.equal(r.truncated, true);
      assert.ok(r.content.startsWith('A'.repeat(50)));
      assert.ok(r.content.includes('C'.repeat(50)));
    });

    it('respects UTF-8 boundaries (does not split multi-byte chars)', () => {
      const content = '中'.repeat(2000);
      const r = truncator.truncate(content);
      assert.equal(r.truncated, true);
      for (const ch of r.content.replace(/\n\.\.\..*?\.\.\.\n/, '')) {
        assert.equal(ch, '中', 'UTF-8 character was split');
      }
    });

    it('does not split the surrogate pair boundary', () => {
      const content = '𝄞'.repeat(2000);
      const r = truncator.truncate(content);
      assert.equal(r.truncated, true);
    });
  });

  describe('smart-trim strategy', () => {
    beforeEach(() => {
      truncator = new OutputTruncator({
        maxBytes: 1000,
        headLines: 5,
        tailLines: 5,
        strategy: 'smart-trim',
        maxImportantLines: 3,
      });
    });

    it('retains error/exception lines from the middle', () => {
      const lines = [
        ...Array.from({ length: 100 }, (_, i) => `normal line ${i}`),
        'Error: something failed at line 50',
        '  at handleRequest (server.ts:42:5)',
        'TypeError: cannot read property foo of undefined',
        'SyntaxError: unexpected token',
        ...Array.from({ length: 200 }, (_, i) => `more normal ${i}`),
        'tail line 0',
      ];
      const r = truncator.truncate(lines.join('\n'));
      assert.equal(r.truncated, true);
      assert.ok(r.content.includes('retained 3 important middle lines'));
      assert.ok(r.content.includes('TypeError'));
    });

    it('does not retain important lines when none match', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `boring line ${i}`);
      const r = truncator.truncate(lines.join('\n'));
      assert.equal(r.truncated, true);
      assert.ok(!r.content.includes('retained'));
    });
  });

  describe('marker customization', () => {
    it('uses custom marker template', () => {
      truncator = new OutputTruncator({
        maxBytes: 100,
        headLines: 3,
        tailLines: 3,
        headBytes: 50,
        tailBytes: 50,
        markerTemplate: '\n<<elided: {elided} of {original}>>\n',
        strategy: 'head-tail',
      });
      const content = 'x'.repeat(2000);
      const r = truncator.truncate(content);
      assert.match(r.content, /<<elided: \d+ of \d+>>/);
    });
  });

  describe('config getters and updates', () => {
    it('returns a copy of the config', () => {
      truncator = new OutputTruncator();
      const a = truncator.getConfig();
      a.maxBytes = 1;
      const b = truncator.getConfig();
      assert.notEqual(b.maxBytes, 1);
    });

    it('updates config via updateConfig', () => {
      truncator = new OutputTruncator();
      truncator.updateConfig({ strategy: 'none' });
      assert.equal(truncator.getConfig().strategy, 'none');
    });
  });

  describe('byte counting', () => {
    it('reports originalBytes correctly for UTF-8 content', () => {
      truncator = new OutputTruncator({ maxBytes: 10 });
      const content = '中文中文中文';
      const r = truncator.truncate(content);
      assert.equal(r.originalBytes, Buffer.byteLength(content, 'utf-8'));
    });

    it('elidedBytes sums to roughly (original - kept) - marker', () => {
      truncator = new OutputTruncator({ maxBytes: 100, headLines: 3, tailLines: 3 });
      const content = 'x'.repeat(2000);
      const r: TruncationResult = truncator.truncate(content);
      const keptSize = Buffer.byteLength(r.content, 'utf-8');
      assert.equal(r.elidedBytes, r.originalBytes - keptSize);
    });
  });
});
