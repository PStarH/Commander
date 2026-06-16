/**
 * Integration tests for SearchConversationsTool / FTS5 conversation search.
 *
 * Creates a real SQLite database with FTS5, inserts conversation data,
 * and verifies that SearchConversationsTool.execute() returns the expected results.
 *
 * Requires better-sqlite3 (optional dependency) — tests gracefully skip if absent.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConversationStore } from '../../src/memory/conversationStore';
import { SearchConversationsTool, searchConversationsCLI } from '../../src/tools/conversationSearchTool';

// ── Helpers ────────────────────────────────────────────────────────────────

function canUseSqlite(): boolean {
  try {
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SearchConversationsTool — Integration', () => {
  if (!canUseSqlite()) {
    it.skip('all tests require better-sqlite3 — install with: pnpm add better-sqlite3');
    return;
  }

  let tempDir: string;
  let tool: SearchConversationsTool;

  // Set up the singleton ConversationStore once for all tests.
  // Each test creates unique data with different search terms, so additive
  // data does not cause cross-test interference.
  // No need to call store.init() here — every store operation (startSession,
  // addTurn, etc.) lazily calls await this.init() internally.
  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'commander-test-conv-'));
    const dbPath = join(tempDir, 'conversations.db');
    getConversationStore({ dbPath }); // Initialize the singleton with the temp path
    tool = new SearchConversationsTool();
  });

  // Close store before removing the temp directory to avoid race conditions.
  after(async () => {
    const store = getConversationStore();
    await store.close().catch(() => {});
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Isolate each test by closing the store and unlinking the DB file.
  // The next store operation will call init() which recreates the schema.
  beforeEach(async () => {
    const store = getConversationStore();
    await store.close().catch(() => {});
    const dbPath = join(tempDir, 'conversations.db');
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
  });

  // ── End-to-end tests ──────────────────────────────────────────────────

  describe('end-to-end: create → search → verify', () => {
    it('finds conversations matching full-text query', async () => {
      const store = getConversationStore();

      // 1. Create a session with meaningful content
      const session = await store.startSession({
        projectId: 'test-project',
        goal: 'Database schema design discussion',
      });

      await store.addTurn({
        sessionId: session.id,
        role: 'user',
        content: 'What database should we use for the new project? I think PostgreSQL would be best.',
      });
      await store.addTurn({
        sessionId: session.id,
        role: 'assistant',
        content: 'PostgreSQL is a great choice. We can use FTS5 full-text search for conversation history and implement proper indexing strategies.',
      });
      await store.addTurn({
        sessionId: session.id,
        role: 'user',
        content: 'What about the indexing strategy for our search feature?',
      });

      await store.endSession(session.id);

      // 2. Search via the tool for "PostgreSQL"
      const result = await tool.execute({
        query: 'PostgreSQL',
        projectId: 'test-project',
        limit: 5,
      });

      // 3. Assert the result contains the matching conversation
      assert.ok(result.includes('PostgreSQL'), 'Result should contain the matched term');
      assert.ok(result.includes('Database schema design discussion'), 'Result should include the session goal');
      assert.ok(result.includes('100%') || result.includes('Relevance:'), 'Result should show relevance');
      assert.ok(!result.startsWith('Error:'), 'Result should not start with error');
      assert.ok(!result.startsWith('No conversations'), 'Result should have matches');
    });

    it('searches across multiple sessions and returns best matches', async () => {
      const store = getConversationStore();

      // Session 1: unrelated topic
      const s1 = await store.startSession({ projectId: 'test-project', goal: 'Server setup' });
      await store.addTurn({ sessionId: s1.id, role: 'user', content: 'Install nginx on the server' });
      await store.addTurn({ sessionId: s1.id, role: 'assistant', content: 'Run apt-get install nginx' });
      await store.endSession(s1.id);

      // Session 2: target topic
      const s2 = await store.startSession({ projectId: 'test-project', goal: 'React component design' });
      await store.addTurn({ sessionId: s2.id, role: 'user', content: 'How to build a React search component with TypeScript?' });
      await store.addTurn({ sessionId: s2.id, role: 'assistant', content: 'We can create a SearchBar component using React hooks and TypeScript generics.' });
      await store.endSession(s2.id);

      // Session 3: another target topic
      const s3 = await store.startSession({ projectId: 'test-project', goal: 'Rust backend API' });
      await store.addTurn({ sessionId: s3.id, role: 'user', content: 'Should we write the API in TypeScript or Rust?' });
      await store.addTurn({ sessionId: s3.id, role: 'assistant', content: 'Rust with Actix-web gives better performance for the API layer.' });
      await store.endSession(s3.id);

      // Search for TypeScript — should match Sessions 2 and 3
      const result = await tool.execute({
        query: 'TypeScript',
        projectId: 'test-project',
        limit: 5,
      });

      assert.ok(result.includes('React component design'), 'Should find the TypeScript-related session');
      assert.ok(!result.startsWith('Error:'), 'No errors');
      assert.ok(result.match(/Found \d+ conversation/), 'Should report found count');
    });

    it('returns no results for unrelated query', async () => {
      const store = getConversationStore();

      const session = await store.startSession({ projectId: 'test-project', goal: 'Test goal' });
      await store.addTurn({ sessionId: session.id, role: 'user', content: 'Hello world' });
      await store.endSession(session.id);

      const result = await tool.execute({
        query: 'xyznonexistent',
        projectId: 'test-project',
        limit: 5,
      });

      assert.ok(result.includes('No conversations'), 'Should report no matches');
      assert.ok(result.includes('xyznonexistent'), 'Should include the query term');
    });

    it('isolates search by projectId', async () => {
      const store = getConversationStore();

      // Project A has the data
      const sA = await store.startSession({ projectId: 'project-a', goal: 'Project A discussion' });
      await store.addTurn({ sessionId: sA.id, role: 'user', content: 'This is about project A and Kubernetes' });
      await store.endSession(sA.id);

      // Project B does not
      const sB = await store.startSession({ projectId: 'project-b', goal: 'Project B discussion' });
      await store.addTurn({ sessionId: sB.id, role: 'user', content: 'This is about project B' });
      await store.endSession(sB.id);

      // Search project A for Kubernetes — should find
      const resultA = await tool.execute({
        query: 'Kubernetes',
        projectId: 'project-a',
        limit: 5,
      });
      assert.ok(resultA.includes('Project A'), 'Project A should find results');

      // Search project B for Kubernetes — should not find
      const resultB = await tool.execute({
        query: 'Kubernetes',
        projectId: 'project-b',
        limit: 5,
      });
      assert.ok(resultB.includes('No conversations'), 'Project B should not find results');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases and error handling', () => {
    it('returns error for empty query', async () => {
      const result = await tool.execute({ query: '' });
      assert.strictEqual(result, 'Error: query is required');
    });

    it('returns error for whitespace-only query', async () => {
      const result = await tool.execute({ query: '   ' });
      assert.strictEqual(result, 'Error: query is required');
    });

    it('handles special characters in query', async () => {
      const store = getConversationStore();
      const session = await store.startSession({ projectId: 'test', goal: 'Test special chars' });
      await store.addTurn({ sessionId: session.id, role: 'user', content: 'The C++ code uses lambda functions' });
      await store.endSession(session.id);

      const result = await tool.execute({
        query: 'lambda',
        projectId: 'test',
        limit: 5,
      });

      assert.ok(result.includes('lambda'), 'Should match the term');
    });

    it('filters by sinceDays parameter', async () => {
      const store = getConversationStore();

      // Create a session with current timestamp
      const session = await store.startSession({
        projectId: 'test-since',
        goal: 'Recent discussion about PostgreSQL indexing',
      });
      await store.addTurn({
        sessionId: session.id,
        role: 'user',
        content: 'We should add PostgreSQL indexing for better performance',
      });
      await store.endSession(session.id);

      // sinceDays: 0 means no date filter — should find the session
      const resultAll = await tool.execute({
        query: 'PostgreSQL',
        projectId: 'test-since',
        limit: 5,
        sinceDays: 0,
      });
      assert.ok(resultAll.includes('Recent discussion'), 'sinceDays=0 should include the session');

      // sinceDays: 36500 (100 years) — session created now is within range, should still find
      const resultWide = await tool.execute({
        query: 'PostgreSQL',
        projectId: 'test-since',
        limit: 5,
        sinceDays: 36500,
      });
      assert.ok(resultWide.includes('Recent discussion'), 'sinceDays=36500 should include recent sessions');

      // Test store-level since filtering with a future date (exclusion case)
      // This tests the actual filtering logic in ConversationStore.search()
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
      const storeResults = await store.search({
        query: 'PostgreSQL',
        projectId: 'test-since',
        since: futureDate,
      });
      assert.strictEqual(storeResults.length, 0,
        'since=tomorrow should exclude a session created today');

      // Without since filter, the session should be found
      const storeResultsAll = await store.search({
        query: 'PostgreSQL',
        projectId: 'test-since',
      });
      assert.ok(storeResultsAll.length >= 1,
        'Without since filter, the session should be found');
    });

    it('filters by minImportance parameter', async () => {
      const store = getConversationStore();

      const session = await store.startSession({
        projectId: 'test-importance',
        goal: 'Discussing architecture decisions',
      });

      // Turn 1: very high-importance content (~1.0)
      // user(+0.1) + decided(+0.15) + because(+0.1) + learned(+0.15) + .ts ref(+0.1)
      // 0.5 + 0.1 + 0.15 + 0.1 + 0.15 + 0.1 = 1.1 → clamped to 1.0
      await store.addTurn({
        sessionId: session.id,
        role: 'user',
        content: 'I decided to use TypeScript because I learned it reduces bugs in api/src/main.ts.',
      });

      // Turn 2: low-importance content (7 chars < 20 → -0.2)
      // user(+0.1) + short(-0.2) = 0.5 + 0.1 - 0.2 = 0.4
      await store.addTurn({
        sessionId: session.id,
        role: 'user',
        content: 'hi team',
      });

      // Turn 3: mid-high importance content (~0.7)
      // assistant(no role boost) + error(+0.1) + .ts ref(+0.1)
      // 0.5 + 0.1 + 0.1 = 0.7
      await store.addTurn({
        sessionId: session.id,
        role: 'assistant',
        content: 'Fixed the error in auth.ts by adding a try-catch block.',
      });

      await store.endSession(session.id);

      // Query "TypeScript" only matches Turn 1 (importance 1.0)
      // With minImportance=0.8, Turn 1 (1.0 >= 0.8) passes → session found
      const resultHigh = await tool.execute({
        query: 'TypeScript',
        projectId: 'test-importance',
        limit: 5,
        minImportance: 0.8,
      });
      assert.ok(resultHigh.includes('decided to use TypeScript'),
        'minImportance=0.8 should keep high-importance turn (score ~1.0)');
      assert.ok(resultHigh.match(/Found \d+ conversation/),
        'Should still report a result at high threshold');

      // Query "error" only matches Turn 3 (importance 0.7)
      // With minImportance=0.8, Turn 3 (0.7 < 0.8) is filtered → no results
      const resultMedium = await tool.execute({
        query: 'error',
        projectId: 'test-importance',
        limit: 5,
        minImportance: 0.8,
      });
      assert.ok(resultMedium.includes('No conversations'),
        'minImportance=0.8 should exclude mid-importance turn (score ~0.7)');

      // With minImportance=0, same query finds the session
      const resultMediumAll = await tool.execute({
        query: 'error',
        projectId: 'test-importance',
        limit: 5,
        minImportance: 0,
      });
      assert.ok(resultMediumAll.includes('Fixed the error'),
        'minImportance=0 should include mid-importance turn');

      // Query "hi" only matches Turn 2 (importance 0.4)
      // With minImportance=0.5, Turn 2 (0.4 < 0.5) is filtered → no results
      const resultLow = await tool.execute({
        query: 'hi',
        projectId: 'test-importance',
        limit: 5,
        minImportance: 0.5,
      });
      assert.ok(resultLow.includes('No conversations'),
        'minImportance=0.5 should exclude low-importance greeting (score ~0.4)');

      // With minImportance=0, same query finds the session
      const resultLowAll = await tool.execute({
        query: 'hi',
        projectId: 'test-importance',
        limit: 5,
        minImportance: 0,
      });
      assert.ok(resultLowAll.includes('hi team'),
        'minImportance=0 should include low-importance greeting');
    });

    it('returns results sorted by relevance score descending', async () => {
      const store = getConversationStore();

      // Create 3 sessions with varying relevance. All created at same time
      // (equal recency), but differ in match density and average importance.

      // Session A — highest relevance: 4 high-importance turns matching "TypeScript"
      const sA = await store.startSession({ projectId: 'test-sort', goal: 'Session A — Deep TypeScript discussion' });
      await store.addTurn({ sessionId: sA.id, role: 'user', content: 'I decided to use TypeScript because I learned it reduces bugs.' });           // ~1.0
      await store.addTurn({ sessionId: sA.id, role: 'user', content: 'The key takeaway is that TypeScript catches errors early.' });                    // ~0.75
      await store.addTurn({ sessionId: sA.id, role: 'assistant', content: 'We fixed a bug in main.ts because TypeScript found the issue.' });              // ~0.85
      await store.addTurn({ sessionId: sA.id, role: 'user', content: 'I realized TypeScript is a key advantage for our project.' });                       // ~0.75
      await store.endSession(sA.id);

      // Session B — medium relevance: 2 medium-importance turns matching "TypeScript"
      const sB = await store.startSession({ projectId: 'test-sort', goal: 'Session B — Brief TypeScript mention' });
      await store.addTurn({ sessionId: sB.id, role: 'user', content: 'TypeScript is a typed superset of JavaScript.' });                                  // ~0.6
      await store.addTurn({ sessionId: sB.id, role: 'assistant', content: 'TypeScript offers better IDE support for our team.' });                          // ~0.6
      await store.endSession(sB.id);

      // Session C — lowest relevance: 1 short low-importance turn matching "TypeScript"
      const sC = await store.startSession({ projectId: 'test-sort', goal: 'Session C — Casual TypeScript mention' });
      await store.addTurn({ sessionId: sC.id, role: 'user', content: 'I like TypeScript' });                                                              // ~0.4 (short < 20)
      await store.endSession(sC.id);

      // Search via JSON format to get structured scores
      const jsonResult = await searchConversationsCLI('TypeScript', {
        projectId: 'test-sort',
        limit: 10,
        format: 'json',
      });

      const results = JSON.parse(jsonResult);
      assert.ok(results.length >= 3, 'Should find all 3 matching sessions');

      // Verify results are sorted by relevanceScore descending
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1].relevanceScore >= results[i].relevanceScore,
          `Results should be sorted descending by relevanceScore. ` +
          `[${i - 1}]: ${results[i - 1].relevanceScore.toFixed(4)} ` +
          `(${results[i - 1].session.goal}) >= ` +
          `[${i}]: ${results[i].relevanceScore.toFixed(4)} ` +
          `(${results[i].session.goal})`
        );
      }

      // Verify the expected order: A >> B >> C with clear score gaps
      const goals = results.map((r: any) => r.session.goal);
      assert.ok(goals[0].includes('Session A'), 'Top result should be Session A (highest relevance)');
      assert.ok(goals[1].includes('Session B'), 'Middle result should be Session B (medium relevance)');
      assert.ok(goals[2].includes('Session C'), 'Last result should be Session C (lowest relevance)');

      // Verify score gaps are meaningful (> 0.1 difference between tiers)
      assert.ok(
        results[0].relevanceScore - results[1].relevanceScore > 0.1,
        `Score gap between A and B should be > 0.1, got ${(results[0].relevanceScore - results[1].relevanceScore).toFixed(4)}`
      );
      assert.ok(
        results[1].relevanceScore - results[2].relevanceScore > 0.05,
        `Score gap between B and C should be > 0.05, got ${(results[1].relevanceScore - results[2].relevanceScore).toFixed(4)}`
      );
    });

    it('respects the limit parameter', async () => {
      const store = getConversationStore();

      // Create multiple sessions each with matching content
      for (let i = 0; i < 5; i++) {
        const s = await store.startSession({ projectId: 'test-limit', goal: `Limit test Session ${i}` });
        await store.addTurn({ sessionId: s.id, role: 'user', content: `Discussion about index strategies part ${i}` });
        await store.endSession(s.id);
      }

      const resultLimited = await tool.execute({
        query: 'index',
        projectId: 'test-limit',
        limit: 2,
      });

      const matchCount = (resultLimited.match(/--- Result \d+ ---/g) || []).length;
      assert.ok(matchCount <= 2, `Should return at most 2 results, got ${matchCount}`);

      const resultFull = await tool.execute({
        query: 'index',
        projectId: 'test-limit',
        limit: 10,
      });

      const fullCount = (resultFull.match(/--- Result \d+ ---/g) || []).length;
      assert.ok(fullCount >= matchCount, 'Higher limit should return more or equal results');
    });
  });

  // ── searchConversationsCLI ────────────────────────────────────────────

  describe('searchConversationsCLI', () => {
    it('supports JSON output format', async () => {
      const store = getConversationStore();
      const session = await store.startSession({ projectId: 'test', goal: 'JSON test' });
      await store.addTurn({ sessionId: session.id, role: 'user', content: 'This is a test about JSON output' });
      await store.endSession(session.id);

      const jsonResult = await searchConversationsCLI('JSON output', {
        projectId: 'test',
        limit: 5,
        format: 'json',
      });

      const parsed = JSON.parse(jsonResult);
      assert.ok(Array.isArray(parsed), 'JSON result should be an array');
      assert.ok(parsed.length >= 1, 'Should have at least 1 result');
      assert.ok(parsed[0].session, 'Each result should have a session field');
      assert.strictEqual(parsed[0].session.goal, 'JSON test', 'Session goal should match');
      assert.ok(Array.isArray(parsed[0].matchingTurns), 'Should have matchingTurns array');
      assert.ok(typeof parsed[0].relevanceScore === 'number', 'Should have relevanceScore');
    });
  });
});
