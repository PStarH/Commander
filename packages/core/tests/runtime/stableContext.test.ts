import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StablePrefix, AppendOnlyLog, buildCachedRequest } from '../../src/runtime/stableContext.js';
import type { LLMMessage } from '../../src/runtime/types.js';

describe('StablePrefix', () => {
  it('builds system + governance + tool messages in stable order', () => {
    const prefix = new StablePrefix({
      systemPrompt: 'You are a helpful assistant.',
      toolDefinitions: [
        { name: 'file_read', description: 'read a file' },
        { name: 'file_write', description: 'write a file' },
      ],
      governanceProfile: 'No PII allowed.',
    });
    assert.equal(prefix.messages.length, 3);
    assert.equal(prefix.messages[0].role, 'system');
    assert.match(prefix.messages[0].content, /helpful assistant/);
    assert.match(prefix.messages[1].content, /Governance/);
    assert.match(prefix.messages[2].content, /Available Tools/);
  });

  it('computes a stable hash from content', () => {
    const a = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    const b = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    assert.equal(a.hash, b.hash);
  });

  it('detects content changes via hash', () => {
    const a = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    const b = new StablePrefix({ systemPrompt: 'Y', toolDefinitions: [] });
    assert.notEqual(a.hash, b.hash);
  });

  it('matches() returns true only for equivalent prefixes', () => {
    const a = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [{ name: 't', description: 'd' }] });
    const b = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [{ name: 't', description: 'd' }] });
    const c = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [{ name: 't', description: 'e' }] });
    assert.equal(a.matches(b), true);
    assert.equal(a.matches(c), false);
  });

  it('skips governance/tools sections when empty', () => {
    const prefix = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    assert.equal(prefix.messages.length, 1);
  });
});

describe('AppendOnlyLog', () => {
  function msg(role: LLMMessage['role'], content: string): LLMMessage {
    return { role, content };
  }

  it('appends messages in order', () => {
    const log = new AppendOnlyLog();
    log.append(msg('user', 'hi'));
    log.append(msg('assistant', 'hello'));
    assert.equal(log.size(), 2);
    assert.deepEqual(log.getAll().map(m => m.content), ['hi', 'hello']);
  });

  it('supports batch append', () => {
    const log = new AppendOnlyLog();
    log.append([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')]);
    assert.equal(log.size(), 3);
  });

  it('returns last N entries', () => {
    const log = new AppendOnlyLog();
    for (let i = 0; i < 10; i++) log.append(msg('user', String(i)));
    assert.deepEqual(log.last(3).map(m => m.content), ['7', '8', '9']);
  });

  it('deltaFrom returns entries from index to end', () => {
    const log = new AppendOnlyLog();
    log.append([msg('user', 'a'), msg('user', 'b'), msg('user', 'c')]);
    assert.deepEqual(log.deltaFrom(1).map(m => m.content), ['b', 'c']);
    assert.deepEqual(log.deltaFrom(0).map(m => m.content), ['a', 'b', 'c']);
    assert.deepEqual(log.deltaFrom(99), []);
  });

  it('replaceAll replaces the log entirely', () => {
    const log = new AppendOnlyLog();
    log.append(msg('user', 'old1'));
    log.append(msg('user', 'old2'));
    log.replaceAll([msg('system', 'NEW'), msg('user', 'new')]);
    assert.equal(log.size(), 2);
    assert.equal(log.getAll()[0].role, 'system');
    assert.equal(log.getAll()[0].content, 'NEW');
  });

  it('clear empties the log', () => {
    const log = new AppendOnlyLog();
    log.append(msg('user', 'x'));
    log.clear();
    assert.equal(log.size(), 0);
  });
});

describe('buildCachedRequest', () => {
  it('concatenates prefix messages + log entries', () => {
    const prefix = new StablePrefix({ systemPrompt: 'SYSTEM', toolDefinitions: [] });
    const log = new AppendOnlyLog();
    log.append([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
    const result = buildCachedRequest({ prefix, log });
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].content, 'SYSTEM');
    assert.equal(result.messages[1].content, 'hi');
    assert.equal(result.messages[2].content, 'hello');
    assert.equal(result.prefixBoundary, 1);
  });

  it('returns a stable cacheKey for matching prefixes', () => {
    const a = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    const b = new StablePrefix({ systemPrompt: 'X', toolDefinitions: [] });
    const r1 = buildCachedRequest({ prefix: a, log: new AppendOnlyLog() });
    const r2 = buildCachedRequest({ prefix: b, log: new AppendOnlyLog() });
    assert.equal(r1.cacheKey, r2.cacheKey);
  });
});
