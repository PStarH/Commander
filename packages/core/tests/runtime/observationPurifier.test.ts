import { describe, it, expect } from 'vitest';
import {
  looksLikeHtml,
  looksLikeJson,
  looksLikeStackTrace,
  purifyHtml,
  purifyJson,
  purifyStackTrace,
  purifyObservation,
  containsErrorSignal,
} from '../../src/runtime/observationPurifier';

describe('observationPurifier', () => {
  it('detects HTML content', () => {
    expect(looksLikeHtml('<html><body>hello</body></html>')).toBe(true);
    expect(looksLikeHtml('plain text')).toBe(false);
  });

  it('detects JSON content', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('[1,2,3]')).toBe(true);
    expect(looksLikeJson('plain text')).toBe(false);
  });

  it('detects stack traces', () => {
    const stack = `Error: boom
    at foo (/src/index.ts:10:5)
    at bar (/src/index.ts:20:5)
    at baz (/src/index.ts:30:5)`;
    expect(looksLikeStackTrace(stack)).toBe(true);
    expect(looksLikeStackTrace('plain text')).toBe(false);
  });

  it('purifies HTML to markdown-ish text', () => {
    const html = `<html>
      <head><style>body{color:red}</style></head>
      <body>
        <h1>Title</h1>
        <ul><li>Item 1</li><li>Item 2</li></ul>
        <p>Some text.</p>
      </body>
    </html>`;
    const purified = purifyHtml(html);
    expect(purified).not.toContain('<style>');
    expect(purified).not.toContain('<h1>');
    expect(purified).toContain('# Title');
    expect(purified).toContain('- Item 1');
    expect(purified).toContain('Some text');
  });

  it('minifies JSON', () => {
    const json = '{\n  "key": "value",\n  "arr": [1, 2, 3]\n}';
    const purified = purifyJson(json);
    expect(purified).not.toContain('\n');
    expect(purified).toContain('"key":"value"');
  });

  it('extracts JSON key when requested', () => {
    const json = '{"data":{"result":42},"meta":{"page":1}}';
    expect(purifyJson(json, { jsonKey: 'data' })).toBe('{"result":42}');
  });

  it('deduplicates and truncates stack traces', () => {
    const stack = `Error: recursive
    at foo (/src/a.ts:1:1)
    at bar (/src/b.ts:2:2)
    at baz (/src/c.ts:3:3)
    at qux (/src/d.ts:4:4)
    at quux (/src/e.ts:5:5)
    at foo (/src/a.ts:1:1)
    at bar (/src/b.ts:2:2)
    at baz (/src/c.ts:3:3)
    at qux (/src/d.ts:4:4)
    at quux (/src/e.ts:5:5)`;
    const purified = purifyStackTrace(stack, { stackFrames: 2 });
    expect(purified).toContain('identical frames omitted');
    expect(purified).not.toMatch(/at foo[\s\S]*at foo[\s\S]*at foo/);
  });

  it('routes observations by content type', () => {
    expect(purifyObservation('<html><body>x</body></html>')).toContain('x');
    expect(purifyObservation('{"a":1}')).not.toContain('\n');
    expect(purifyObservation('plain observation')).toBe('plain observation');
  });

  it('preserves short error outputs', () => {
    const error = 'Error: command failed with exit code 1';
    expect(purifyObservation(error, 'shell_execute')).toBe(error);
  });

  it('detects error signals', () => {
    expect(containsErrorSignal('Traceback (most recent call last)')).toBe(true);
    expect(containsErrorSignal('success')).toBe(false);
  });
});
