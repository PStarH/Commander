import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { InMemoryMemoryService, MemoryStoreFacade } from '@commander/core';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter';

// Set memory index dir BEFORE requiring MemoryIndexManager. Its top-level
// constant captures the env var at module-load time, so the import must happen
// after this assignment.
const MEMORY_DIR = path.join(
  os.tmpdir(),
  `commander-memory-index-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
fs.mkdirSync(MEMORY_DIR, { recursive: true });
process.env['COMMANDER_MEMORY_DIR'] = MEMORY_DIR;

const createStore = () => new MemoryStoreFacade(new InMemoryMemoryService(), 'test-tenant');

after(async () => {
  fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
});

describe('ProjectMemoryStoreAdapter', () => {
  it('appends and retrieves a memory', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    const item = await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'test memory',
      content: 'test content',
      tags: ['t1'],
      duration: 'EPISODIC',
    });

    assert.ok(item.id);
    assert.equal(item.title, 'test memory');

    const listed = await adapter.list('p1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].title, 'test memory');
  });

  it('returns an overview', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'overview test',
      content: 'content',
      tags: ['tag-a'],
      duration: 'EPISODIC',
    });

    const overview = await adapter.overview('p1');
    assert.equal(overview.totalItems, 1);
    assert.equal(overview.kindCounts.LESSON, 1);
    assert.equal(overview.topTags.length, 1);
    assert.equal(overview.topTags[0].tag, 'tag-a');
  });

  it('searches by query', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);

    await adapter.append({
      projectId: 'p1',
      kind: 'LESSON',
      title: 'auth flow',
      content: 'Use OAuth2 PKCE for mobile auth',
      tags: ['auth'],
      duration: 'LONG_TERM',
    });

    await adapter.append({
      projectId: 'p1',
      kind: 'DECISION',
      title: 'db config',
      content: 'Enable WAL mode for SQLite',
      tags: ['db'],
      duration: 'LONG_TERM',
    });

    const results = await adapter.search('p1', { query: 'OAuth' });
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'auth flow');
  });
});

describe('MemoryIndexManager + ProjectMemoryStoreAdapter integration', () => {
  let MemoryIndexManager: typeof import('../src/memoryIndexManager').MemoryIndexManager;

  before(async () => {
    ({ MemoryIndexManager } = await import('../src/memoryIndexManager'));
  });

  it('mirrors domain entries into the adapter-backed project memory store', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-mirror', adapter);
    manager.addDomain('Decisions', 'Architectural decisions');

    const entry = await manager.writeEntry('Decisions', {
      type: 'decision',
      title: 'Use SQLite for memory',
      content: 'We decided to use SQLite for long-term project memory.',
      tags: ['db', 'sqlite'],
    });

    assert.ok(entry);
    assert.equal(entry.title, 'Use SQLite for memory');

    const items = await adapter.search('project-mirror', { query: 'SQLite' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Use SQLite for memory');
    assert.equal(items[0].kind, 'DECISION');
    assert.equal(items[0].duration, 'LONG_TERM');
    assert.deepEqual(items[0].tags, ['db', 'sqlite']);
  });

  it('maps all memory-index entry types to ProjectMemoryItem kinds', async () => {
    const store = createStore();
    const adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-kinds', adapter);
    manager.addDomain('AllTypes', 'Kind mapping coverage');

    await manager.writeEntry('AllTypes', {
      type: 'issue',
      title: 'Issue entry',
      content: 'Issue content',
      tags: ['issue'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'lesson',
      title: 'Lesson entry',
      content: 'Lesson content',
      tags: ['lesson'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'context',
      title: 'Context entry',
      content: 'Context content',
      tags: ['context'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'pattern',
      title: 'Pattern entry',
      content: 'Pattern content',
      tags: ['pattern'],
    });
    await manager.writeEntry('AllTypes', {
      type: 'preference',
      title: 'Preference entry',
      content: 'Preference content',
      tags: ['preference'],
    });

    const all = await adapter.list('project-kinds');
    assert.equal(all.length, 5);
    assert.equal(all.filter((i) => i.kind === 'ISSUE').length, 1);
    assert.equal(all.filter((i) => i.kind === 'LESSON').length, 1);
    assert.equal(all.filter((i) => i.kind === 'SUMMARY').length, 3);
  });

});

describe('memoryIndexEndpoints with ProjectMemoryStoreAdapter', () => {
  let createMemoryIndexRouter: typeof import('../src/memoryIndexEndpoints').createMemoryIndexRouter;
  let MemoryIndexManager: typeof import('../src/memoryIndexManager').MemoryIndexManager;
  let server: http.Server;
  let baseUrl: string;
  let adapter: ProjectMemoryStoreAdapter;

  before(async () => {
    [{ createMemoryIndexRouter }, { MemoryIndexManager }] = await Promise.all([
      import('../src/memoryIndexEndpoints'),
      import('../src/memoryIndexManager'),
    ]);

    const store = createStore();
    adapter = new ProjectMemoryStoreAdapter(store);
    const manager = new MemoryIndexManager('project-endpoints', adapter);
    manager.addDomain('Decisions', 'Architectural decisions');
    const router = createMemoryIndexRouter(manager);

    const app = express();
    app.use(express.json());
    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST /projects/:projectId/memory-index/domains/:domain/entries writes through adapter', async () => {
    const response = await fetch(
      `${baseUrl}/projects/project-endpoints/memory-index/domains/Decisions/entries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'decision',
          title: 'Endpoint decision',
          content: 'Adapter-backed endpoint works.',
          tags: ['api'],
        }),
      },
    );
    assert.equal(response.status, 201);

    const body = await response.json();
    assert.equal(body.title, 'Endpoint decision');

    const items = await adapter.search('project-endpoints', { query: 'Adapter-backed' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Endpoint decision');
    assert.equal(items[0].kind, 'DECISION');
  });
});
