'use strict';

/**
 * Regression tests for the COMMANDER_*_FILE / COMMANDER_MEMORY_INDEX env-var
 * overrides on apps/api persistent stores.
 *
 * Each test sets the relevant env vars BEFORE requiring any store module so
 * the module's top-level constant captures the override path. We then assert
 * two outcomes for the "ONLY there" contract:
 *   1. The override path received the write.
 *   2. The default `__dirname`-derived fallback path AND its parent dir were
 *      NOT touched (no writes, no parent-dir creation).
 *
 * Parallel-test launchers set these env vars so each child writes to a unique
 * tmp path; if env is ignored, two launches clobber each other.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Set env vars BEFORE requiring the store modules. Top-level `const X = ??`
// is captured at module-load time, so the require order matters.
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-store-override-'));
process.env['COMMANDER_WARROOM_FILE'] = path.join(tmpRoot, 'war-room.json');
process.env['COMMANDER_MEMORY_FILE'] = path.join(tmpRoot, 'project-memory.json');
process.env['COMMANDER_EPISODIC_FILE'] = path.join(tmpRoot, 'episodic-memory.json');
process.env['COMMANDER_VECTOR_INDEX_FILE'] = path.join(
  tmpRoot,
  'episodic-memory-vectors.json',
);
process.env['COMMANDER_AGENT_STATE_FILE'] = path.join(tmpRoot, 'agent-state.json');
process.env['COMMANDER_ACTION_RATIONALE_FILE'] = path.join(tmpRoot, 'action-rationales.json');
process.env['COMMANDER_MEMORY_INDEX'] = path.join(tmpRoot, 'memory-index-dir');

// ---------------------------------------------------------------------------
// REQUIRES go AFTER env vars are set so module-top-level constants capture
// the overrides.
// ---------------------------------------------------------------------------

const { WarRoomStore, createWarRoomStore } = require('../dist/store.js');
const { ProjectMemoryStore } = require('../dist/memoryStore.js');
const { AgentStateStore } = require('../dist/agentStateStore.js');
const { EpisodicMemoryStore } = require('../dist/episodicMemoryStore.js');
const { ActionRationaleStore } = require('../dist/actionRationale.js');
const { MemoryIndexManager } = require('../dist/memoryIndexManager.js');

// ---------------------------------------------------------------------------
// Fallback paths mirror what each module would have used WITHOUT the env
// override. Compiled stores live at `apps/api/dist/*.js` so their
// `__dirname` is `apps/api/dist/` and `'../data/...'` resolves to
// `apps/api/data/...`. From this test (`apps/api/test/`), `../data/...`
// also resolves to `apps/api/data/...`. MemoryIndexManager fallback is
// `apps/api/memory/` (two levels up from `apps/api/dist/`).
// ---------------------------------------------------------------------------

const FALLBACK = {
  COMMANDER_WARROOM_FILE: path.resolve(__dirname, '..', 'data', 'war-room.json'),
  COMMANDER_MEMORY_FILE: path.resolve(__dirname, '..', 'data', 'project-memory.json'),
  COMMANDER_EPISODIC_FILE: path.resolve(__dirname, '..', 'data', 'episodic-memory.json'),
  COMMANDER_VECTOR_INDEX_FILE: path.resolve(
    __dirname,
    '..',
    'data',
    'episodic-memory-vectors.json',
  ),
  COMMANDER_AGENT_STATE_FILE: path.resolve(__dirname, '..', 'data', 'agent-state.json'),
  COMMANDER_ACTION_RATIONALE_FILE: path.resolve(
    __dirname,
    '..',
    'data',
    'action-rationales.json',
  ),
  COMMANDER_MEMORY_INDEX: path.resolve(__dirname, '..', '..', 'memory'),
};

/**
 * Snapshot a file path AND its parent dir. Returns a frozen record so we can
 * detect both file-level writes (mtime bump) and parent-dir creation
 * (`fs.mkdirSync(path.dirname(file), { recursive: true })`).
 *
 * Tolerates the "parent doesn't exist" case via try/stat so a fresh clone
 * (before any test has run) doesn't trip with ENOENT.
 */
function snapshot(p) {
  const file = !fs.existsSync(p)
    ? { exists: false, mtimeMs: null, size: 0, content: null }
    : (() => {
        const stat = fs.statSync(p);
        return {
          exists: true,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          content: fs.readFileSync(p, 'utf8'),
        };
      })();

  const parent = path.dirname(p);
  let parentExistedBefore = false;
  let parentMtimeMsBefore = null;
  try {
    parentMtimeMsBefore = fs.statSync(parent).mtimeMs;
    parentExistedBefore = true;
  } catch {
    parentExistedBefore = false;
  }

  return Object.freeze({
    p,
    file,
    parent,
    parentExistedBefore,
    parentMtimeMsBefore,
  });
}

function assertFallbackNotTouched(before, label) {
  // File-level check
  if (before.file.exists) {
    const stat = fs.statSync(before.p);
    assert.equal(
      stat.mtimeMs,
      before.file.mtimeMs,
      `${label}: fallback ${before.p} mtime changed (was ${before.file.mtimeMs}, now ${stat.mtimeMs})`,
    );
    assert.equal(
      fs.readFileSync(before.p, 'utf8'),
      before.file.content,
      `${label}: fallback ${before.p} content changed`,
    );
  } else {
    assert.equal(
      fs.existsSync(before.p),
      false,
      `${label}: fallback ${before.p} should not have been created`,
    );
  }

  // Parent-dir check
  if (!before.parentExistedBefore) {
    assert.equal(
      fs.existsSync(before.parent),
      false,
      `${label}: fallback parent ${before.parent} should not have been created`,
    );
  } else {
    const parentStat = fs.statSync(before.parent);
    assert.equal(
      parentStat.mtimeMs,
      before.parentMtimeMsBefore,
      `${label}: fallback parent ${before.parent} mtime changed`,
    );
  }
}

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('WarRoomStore reads/writes only at COMMANDER_WARROOM_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_WARROOM_FILE);
  // WarRoomStore auto-seeds the file on first construction; that write goes
  // to the override, not the fallback.
  const store = new WarRoomStore();
  const projects = store.listProjects();
  assert.ok(projects.length > 0, 'WarRoomStore seed should expose at least one project');
  assert.ok(
    fs.existsSync(process.env['COMMANDER_WARROOM_FILE']),
    'override war-room.json should exist after WarRoomStore construction',
  );
  assertFallbackNotTouched(before, 'WarRoomStore');
});

test('createWarRoomStore reads/writes only at COMMANDER_WARROOM_FILE', () => {
  // Confirms the public factory (the entry point most call sites use) also
  // resolves the JSON variant's path through the env var.
  const before = snapshot(FALLBACK.COMMANDER_WARROOM_FILE);
  const store = createWarRoomStore();
  const projects = store.listProjects();
  assert.ok(projects.length > 0, 'createWarRoomStore seed should expose at least one project');
  assert.ok(
    fs.existsSync(process.env['COMMANDER_WARROOM_FILE']),
    'override war-room.json should exist after createWarRoomStore()',
  );
  store.close();
  assertFallbackNotTouched(before, 'createWarRoomStore');
});

test('ProjectMemoryStore reads/writes only at COMMANDER_MEMORY_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_MEMORY_FILE);
  const store = new ProjectMemoryStore();
  const item = store.append({
    projectId: 'project-override-test',
    kind: 'LESSON',
    title: 'Override test',
    content: 'Verifying env var redirect',
    tags: ['test'],
    agentId: 'agent-override-test',
  });
  assert.ok(
    fs.existsSync(process.env['COMMANDER_MEMORY_FILE']),
    'override project-memory.json should exist',
  );
  const items = JSON.parse(fs.readFileSync(process.env['COMMANDER_MEMORY_FILE'], 'utf8'));
  assert.ok(
    items.some((i) => i.id === item.id),
    'appended memory should be at override path',
  );
  assertFallbackNotTouched(before, 'ProjectMemoryStore');
});

test('AgentStateStore reads/writes only at COMMANDER_AGENT_STATE_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_AGENT_STATE_FILE);
  const store = new AgentStateStore();
  store.upsert({
    projectId: 'project-override-test',
    agentId: 'agent-override-test',
    summary: 'Override test',
    tags: ['test'],
  });
  assert.ok(
    fs.existsSync(process.env['COMMANDER_AGENT_STATE_FILE']),
    'override agent-state.json should exist',
  );
  const items = JSON.parse(fs.readFileSync(process.env['COMMANDER_AGENT_STATE_FILE'], 'utf8'));
  assert.ok(
    items.some(
      (i) => i.projectId === 'project-override-test' && i.agentId === 'agent-override-test',
    ),
    'upserted agent state should be at override path',
  );
  assertFallbackNotTouched(before, 'AgentStateStore');
});

test('EpisodicMemoryStore reads/writes ONLY at COMMANDER_EPISODIC_FILE + COMMANDER_VECTOR_INDEX_FILE', () => {
  // Both episodic + vector must be env-overridden to satisfy "ONLY there".
  const beforeEp = snapshot(FALLBACK.COMMANDER_EPISODIC_FILE);
  const beforeVec = snapshot(FALLBACK.COMMANDER_VECTOR_INDEX_FILE);
  const store = new EpisodicMemoryStore();
  store.write({
    projectId: 'project-override-test',
    title: 'Override episodic test',
    content: 'Verifying env var redirect',
    type: 'decision',
    importance: 0.7,
    tags: ['test'],
    agentId: 'agent-override-test',
  });
  assert.ok(
    fs.existsSync(process.env['COMMANDER_EPISODIC_FILE']),
    'override episodic-memory.json should exist',
  );
  assert.ok(
    fs.existsSync(process.env['COMMANDER_VECTOR_INDEX_FILE']),
    'override episodic-memory-vectors.json should exist',
  );
  const episodicItems = JSON.parse(
    fs.readFileSync(process.env['COMMANDER_EPISODIC_FILE'], 'utf8'),
  );
  assert.ok(
    episodicItems.some((m) => m.title === 'Override episodic test'),
    'written episodic memory should be at override path',
  );
  assertFallbackNotTouched(beforeEp, 'EpisodicMemoryStore.episodic');
  assertFallbackNotTouched(beforeVec, 'EpisodicMemoryStore.vector');
});

test('ActionRationaleStore reads/writes only at COMMANDER_ACTION_RATIONALE_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_ACTION_RATIONALE_FILE);
  const store = new ActionRationaleStore();
  store.record({
    projectId: 'project-override-test',
    missionId: 'mission-override-test',
    agentId: 'agent-override-test',
    actionType: 'test-action',
    rationale: 'Override test',
    confidenceScore: 0.8,
    triggerSource: 'agent-initiated',
    goalContext: 'Verify env var redirect',
  });
  assert.ok(
    fs.existsSync(process.env['COMMANDER_ACTION_RATIONALE_FILE']),
    'override action-rationales.json should exist',
  );
  const items = JSON.parse(
    fs.readFileSync(process.env['COMMANDER_ACTION_RATIONALE_FILE'], 'utf8'),
  );
  assert.ok(
    items.some(
      (i) => i.projectId === 'project-override-test' && i.actionType === 'test-action',
    ),
    'recorded rationale should be at override path',
  );
  assertFallbackNotTouched(before, 'ActionRationaleStore');
});

test('MemoryIndexManager reads/writes only at COMMANDER_MEMORY_INDEX', () => {
  const before = snapshot(path.join(FALLBACK.COMMANDER_MEMORY_INDEX, 'index.json'));
  const mgr = new MemoryIndexManager('project-override-test');
  mgr.addDomain('Override-Test-Domain', 'Verifying env var redirect');
  const indexPath = path.join(process.env['COMMANDER_MEMORY_INDEX'], 'index.json');
  assert.ok(fs.existsSync(indexPath), 'override memory-index-dir should exist with index.json');
  const raw = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(raw);
  assert.ok(
    index.pointers.some((p) => p.domain === 'Override-Test-Domain'),
    'domain pointer should be at override MEMORY_DIR',
  );
  assertFallbackNotTouched(before, 'MemoryIndexManager');
});
