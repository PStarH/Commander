/**
 * LM-22 / AUDIT api-completion#API-C06 — the knowledge store must verify a read
 * before trusting it, and must only publish cache after a durable commit.
 *
 * Before the fix:
 *   - `loadDocuments` swallowed every error and returned `[]`, and
 *     `loadIndex` swallowed every error and returned an empty manifest. A
 *     transient read failure or a corrupt file therefore looked like an empty
 *     knowledge base, and the next write persisted that empty state — losing
 *     every existing document.
 *   - `doInit` swallowed errors and never cleared `initPromise`, so the store
 *     could not recover after the underlying problem was fixed.
 *   - `addDocument` pushed into the live cache and persisted `documents.json`
 *     *before* the chunks/index existed, then mutated the cached record.
 *   - `deleteDocument` spliced the live cache before persisting.
 *
 * Failure injection uses real filesystem states (a directory where a file is
 * expected, a file where a directory is expected, malformed JSON, malformed
 * NDJSON) rather than chmod, so no permissions are mutated anywhere.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Application } from 'express';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  KnowledgeStore,
  KnowledgeStoreError,
  isKnowledgeStoreError,
  _resetKnowledgeStoreSingletonForTests,
} from '../src/knowledgeStore';
import { createKnowledgeBaseRouter } from '../src/knowledgeBaseEndpoints';

const DOCS_CONTENT = 'the quick brown fox jumps over the lazy dog '.repeat(30);
/** Distinct token sets so retrieval assertions cannot bleed across documents. */
const ALPHA_CONTENT = `${'zebra quokka narwhal '.repeat(40)}`;
const BETA_CONTENT = `${'tundra glacier fjord '.repeat(40)}`;

let tempDir: string;
let baseDir: string;

beforeEach(() => {
  tempDir = path.join(os.tmpdir(), `commander-lm22-${crypto.randomBytes(8).toString('hex')}`);
  baseDir = path.join(tempDir, 'kb');
  fs.mkdirSync(baseDir, { recursive: true });
  _resetKnowledgeStoreSingletonForTests();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function documentsPath(): string {
  return path.join(baseDir, 'documents.json');
}
function indexPath(): string {
  return path.join(baseDir, 'index.json');
}
function chunksDir(): string {
  return path.join(baseDir, 'chunks');
}
function readDocumentsFile(): { documents: Array<{ id: string; name: string; chunks: number }> } {
  return JSON.parse(fs.readFileSync(documentsPath(), 'utf-8'));
}

async function seedDocument(store: KnowledgeStore, name: string, content = DOCS_CONTENT) {
  return store.addDocument({ name, type: 'text/plain', content });
}

describe('LM-22: read failures fail closed instead of becoming an empty store', () => {
  it('rejects when documents.json is unreadable (EISDIR) instead of reporting empty', async () => {
    // A directory where the file is expected: readFile raises EISDIR, which is
    // a read error but not ENOENT, so it must not be treated as "no documents".
    fs.mkdirSync(documentsPath(), { recursive: true });

    const store = new KnowledgeStore(baseDir);
    await assert.rejects(
      () => store.listDocuments(),
      (err: unknown) => isKnowledgeStoreError(err) && err.code === 'KNOWLEDGE_STORE_UNAVAILABLE',
    );
  });

  it('rejects on malformed JSON instead of overwriting the file', async () => {
    fs.writeFileSync(documentsPath(), '{ this is not json', 'utf-8');
    const store = new KnowledgeStore(baseDir);

    await assert.rejects(() => store.addDocument({ name: 'x', type: 'text/plain', content: 'x' }));
    assert.equal(
      fs.readFileSync(documentsPath(), 'utf-8'),
      '{ this is not json',
      'a failed read must not lead to a write',
    );
  });

  it('rejects on an unexpected shape and on invalid records', async () => {
    fs.writeFileSync(documentsPath(), JSON.stringify({ documents: { not: 'an array' } }), 'utf-8');
    await assert.rejects(() => new KnowledgeStore(baseDir).listDocuments());

    fs.writeFileSync(
      documentsPath(),
      JSON.stringify({
        documents: [
          {
            id: 'd1',
            name: 'n',
            type: 'text/plain',
            status: 'ready',
            size: 1,
            chunks: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd1',
            name: 'dup',
            type: 'text/plain',
            status: 'ready',
            size: 1,
            chunks: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ],
      }),
      'utf-8',
    );
    await assert.rejects(() => new KnowledgeStore(baseDir).listDocuments(), /duplicate id/);

    fs.writeFileSync(
      documentsPath(),
      JSON.stringify({
        documents: [
          {
            id: 'd1',
            name: 'n',
            type: 'application/x-evil',
            status: 'ready',
            size: 1,
            chunks: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ],
      }),
      'utf-8',
    );
    await assert.rejects(() => new KnowledgeStore(baseDir).listDocuments(), /invalid record/);
  });

  it('rejects a corrupt index manifest and does not replace it with an empty one', async () => {
    const store = new KnowledgeStore(baseDir);
    await seedDocument(store, 'kept.txt');
    const before = fs.readFileSync(indexPath(), 'utf-8');
    assert.ok(JSON.parse(before).chunks && Object.keys(JSON.parse(before).chunks).length > 0);

    fs.writeFileSync(indexPath(), 'not json at all', 'utf-8');
    const restarted = new KnowledgeStore(baseDir);
    await assert.rejects(
      () => restarted.addDocument({ name: 'new.txt', type: 'text/plain', content: DOCS_CONTENT }),
      (err: unknown) => isKnowledgeStoreError(err),
    );
    assert.equal(
      fs.readFileSync(indexPath(), 'utf-8'),
      'not json at all',
      'a corrupt index must never be replaced by an empty manifest',
    );
  });

  it('rejects a corrupt chunk file instead of serving a truncated index', async () => {
    const store = new KnowledgeStore(baseDir);
    const doc = await seedDocument(store, 'corrupt-me.txt');

    const chunkFile = path.join(chunksDir(), `${doc.id}.ndjson`);
    const original = fs.readFileSync(chunkFile, 'utf-8');
    fs.writeFileSync(chunkFile, `${original}{ truncated json\n`, 'utf-8');

    const restarted = new KnowledgeStore(baseDir);
    await assert.rejects(
      () => restarted.search({ query: 'quick brown fox' }),
      (err: unknown) => isKnowledgeStoreError(err) && err.code === 'KNOWLEDGE_STORE_UNAVAILABLE',
    );
    await assert.rejects(() => restarted.stats());
  });

  it('recovers when init is retried after the fault is repaired', async () => {
    fs.writeFileSync(documentsPath(), 'broken', 'utf-8');
    const store = new KnowledgeStore(baseDir);
    await assert.rejects(() => store.init());

    fs.writeFileSync(documentsPath(), JSON.stringify({ documents: [] }), 'utf-8');
    await store.init();
    assert.deepEqual((await store.listDocuments()).documents, []);
  });
});

describe('LM-22: commit before publishing', () => {
  it('leaves documents.json byte-identical when preparation fails', async () => {
    const store = new KnowledgeStore(baseDir);
    await seedDocument(store, 'existing.txt');
    const before = fs.readFileSync(documentsPath(), 'utf-8');

    // Make the chunk directory unusable for the *next* store instance by
    // replacing it with a regular file: ensureDirs() can no longer create it.
    const savedChunks = `${chunksDir()}.saved`;
    fs.renameSync(chunksDir(), savedChunks);
    fs.writeFileSync(chunksDir(), 'not a directory', 'utf-8');

    const broken = new KnowledgeStore(baseDir);
    await assert.rejects(
      () => broken.addDocument({ name: 'never.txt', type: 'text/plain', content: DOCS_CONTENT }),
      (err: unknown) => isKnowledgeStoreError(err),
    );

    assert.equal(
      fs.readFileSync(documentsPath(), 'utf-8'),
      before,
      'a preparation failure must not write documents.json',
    );
    fs.rmSync(chunksDir(), { force: true });
    fs.renameSync(savedChunks, chunksDir());
  });

  it('does not publish a document whose chunks were never committed', async () => {
    const store = new KnowledgeStore(baseDir);
    await seedDocument(store, 'existing.txt', ALPHA_CONTENT);

    const savedChunks = `${chunksDir()}.saved`;
    fs.renameSync(chunksDir(), savedChunks);
    fs.writeFileSync(chunksDir(), 'not a directory', 'utf-8');

    const broken = new KnowledgeStore(baseDir);
    await assert.rejects(
      () => broken.addDocument({ name: 'never.txt', type: 'text/plain', content: BETA_CONTENT }),
      (err: unknown) => isKnowledgeStoreError(err),
    );

    fs.rmSync(chunksDir(), { force: true });
    fs.renameSync(savedChunks, chunksDir());

    // A working store sees the original document and nothing else.
    const fresh = new KnowledgeStore(baseDir);
    const listed = await fresh.listDocuments();
    assert.deepEqual(
      listed.documents.map((doc) => doc.name),
      ['existing.txt'],
      'the failed document must not be visible',
    );
    // Retrieval has no relevance threshold, so assert on provenance rather than
    // on an empty result set: every chunk must belong to the surviving document.
    const survivor = listed.documents[0]!.id;
    const retrieved = await fresh.search({ query: 'tundra glacier fjord' });
    assert.ok(retrieved.every((result) => result.docId === survivor));
    const manifest = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as {
      chunks: Record<string, { docId: string }>;
    };
    assert.ok(
      Object.values(manifest.chunks).every((entry) => entry.docId === survivor),
      'no index entry may reference the failed document',
    );
  });

  it('keeps the commit visible across a restart', async () => {
    const store = new KnowledgeStore(baseDir);
    const doc = await seedDocument(store, 'persisted.txt');

    const restarted = new KnowledgeStore(baseDir);
    const listed = await restarted.listDocuments();
    assert.equal(listed.documents.length, 1);
    assert.equal(listed.documents[0].id, doc.id);
    assert.equal(listed.documents[0].status, 'ready');
    const results = await restarted.search({ query: 'quick brown fox' });
    assert.ok(results.length > 0, 'committed chunks must be searchable after restart');
    assert.equal(results[0].docId, doc.id);
  });

  it('serialises concurrent writes so neither loses its index entries', async () => {
    const store = new KnowledgeStore(baseDir);
    const [a, b] = await Promise.all([
      store.addDocument({ name: 'a.txt', type: 'text/plain', content: `${DOCS_CONTENT} alpha` }),
      store.addDocument({ name: 'b.txt', type: 'text/plain', content: `${DOCS_CONTENT} beta` }),
    ]);

    const manifest = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as {
      chunks: Record<string, { docId: string }>;
    };
    const docIds = new Set(Object.values(manifest.chunks).map((entry) => entry.docId));
    assert.ok(docIds.has(a.id), 'document A index entries must survive the concurrent write');
    assert.ok(docIds.has(b.id), 'document B index entries must survive the concurrent write');

    const listed = await new KnowledgeStore(baseDir).listDocuments();
    assert.deepEqual(listed.documents.map((doc) => doc.id).sort(), [a.id, b.id].sort());
  });
});

describe('LM-22: delete commits first, then cleans up', () => {
  it('commits the removal even when post-commit cleanup fails', async () => {
    const store = new KnowledgeStore(baseDir);
    const a = await seedDocument(store, 'a.txt', `${DOCS_CONTENT} alpha`);
    const b = await seedDocument(store, 'b.txt', `${DOCS_CONTENT} beta`);

    // Force the chunk-file cleanup to fail: unlink() on a directory is not ENOENT.
    const chunkFile = path.join(chunksDir(), `${a.id}.ndjson`);
    fs.rmSync(chunkFile);
    fs.mkdirSync(chunkFile, { recursive: true });

    const deleted = await store.deleteDocument(a.id);
    assert.equal(deleted, true, 'the deletion is committed even if cleanup is incomplete');

    const listed = await store.listDocuments();
    assert.deepEqual(
      listed.documents.map((doc) => doc.id),
      [b.id],
      'the deleted document must not be readable',
    );
    assert.equal(await store.getDocument(a.id), null);
  });

  it('deleting A leaves B fully intact', async () => {
    const store = new KnowledgeStore(baseDir);
    const a = await seedDocument(store, 'a.txt', ALPHA_CONTENT);
    const b = await seedDocument(store, 'b.txt', BETA_CONTENT);

    assert.equal(await store.deleteDocument(a.id), true);

    const restarted = new KnowledgeStore(baseDir);
    const results = await restarted.search({ query: 'tundra glacier fjord' });
    assert.ok(results.length > 0, "B's chunks must survive deleting A");
    assert.ok(results.every((result) => result.docId === b.id));

    // A's chunks must be gone from the searchable set (retrieval has no
    // relevance threshold, so provenance is the meaningful assertion).
    const allChunks = await restarted.search({ query: 'zebra quokka narwhal', topK: 50 });
    assert.ok(
      allChunks.every((result) => result.docId !== a.id),
      "A's chunks must no longer be retrievable",
    );

    const manifest = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as {
      chunks: Record<string, { docId: string }>;
    };
    assert.ok(
      Object.values(manifest.chunks).every((entry) => entry.docId !== a.id),
      'A must not be left in the index manifest',
    );
  });

  it('returns false for an unknown id without touching the store', async () => {
    const store = new KnowledgeStore(baseDir);
    await seedDocument(store, 'a.txt');
    const before = fs.readFileSync(documentsPath(), 'utf-8');
    assert.equal(await store.deleteDocument('does-not-exist'), false);
    assert.equal(fs.readFileSync(documentsPath(), 'utf-8'), before);
  });
});

describe('LM-22: HTTP boundary reports storage failures honestly', () => {
  let server: ReturnType<Application['listen']>;
  let baseUrl: string;

  function tenantDir(): string {
    return path.join(tempDir, '.commander', 'knowledge-base', 'tenant_tenant-a');
  }

  async function startServer(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = 'tenant-a';
      req.user = { id: 'u', username: 'u', role: 'developer', tenantId: 'tenant-a' } as never;
      next();
    });
    app.use(createKnowledgeBaseRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers a corrupt store with a stable code, never an empty success', async () => {
    // tenant-scoped store lives under <cwd>/.commander/knowledge-base/tenant_<id>
    fs.mkdirSync(tenantDir(), { recursive: true });
    fs.writeFileSync(path.join(tenantDir(), 'documents.json'), '{{{ corrupt', 'utf-8');

    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      await startServer();
      const listResponse = await fetch(`${baseUrl}/api/knowledge/documents`, {
        headers: { 'x-tenant-id': 'tenant-a' },
      });
      assert.equal(listResponse.status, 503);
      const body = (await listResponse.json()) as { error: string };
      assert.equal(body.error, 'KNOWLEDGE_STORE_UNAVAILABLE');
      assert.ok(
        !JSON.stringify(body).includes(tempDir),
        'the response must not leak filesystem paths',
      );

      const searchResponse = await fetch(`${baseUrl}/api/knowledge/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({ query: 'anything' }),
      });
      assert.equal(searchResponse.status, 503);

      const uploadResponse = await fetch(`${baseUrl}/api/knowledge/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({ name: 'x.txt', type: 'text/plain', content: DOCS_CONTENT }),
      });
      assert.equal(uploadResponse.status, 503);
      assert.equal(
        fs.readFileSync(path.join(tenantDir(), 'documents.json'), 'utf-8'),
        '{{{ corrupt',
        'a failed upload must not overwrite the corrupt file',
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('never reports a failed ingest as success', async () => {
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      await startServer();
      fs.mkdirSync(tenantDir(), { recursive: true });
      // A regular file where the chunk directory belongs makes ensureDirs fail
      // after documents.json was read successfully.
      fs.writeFileSync(path.join(tenantDir(), 'chunks'), 'not a directory', 'utf-8');

      const uploadResponse = await fetch(`${baseUrl}/api/knowledge/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
        body: JSON.stringify({ name: 'x.txt', type: 'text/plain', content: DOCS_CONTENT }),
      });
      assert.ok(
        uploadResponse.status >= 400,
        `a failed ingest must not be reported as success (got ${uploadResponse.status})`,
      );
      const body = (await uploadResponse.json()) as { error: string };
      assert.ok(
        body.error === 'KNOWLEDGE_STORE_UNAVAILABLE' || body.error === 'KNOWLEDGE_INGEST_FAILED',
        `unexpected error code: ${body.error}`,
      );
      assert.ok(!fs.existsSync(path.join(tenantDir(), 'documents.json')));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('LM-22: error type', () => {
  it('carries a stable code and is recognisable', () => {
    const err = new KnowledgeStoreError('KNOWLEDGE_STORE_UNAVAILABLE', 'nope');
    assert.equal(err.code, 'KNOWLEDGE_STORE_UNAVAILABLE');
    assert.equal(isKnowledgeStoreError(err), true);
    assert.equal(isKnowledgeStoreError(new Error('nope')), false);
    assert.equal(isKnowledgeStoreError(undefined), false);
  });
});
