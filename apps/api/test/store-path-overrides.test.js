'use strict';

/**
 * Regression tests for the COMMANDER_*_FILE / COMMANDER_MEMORY_DIR env-var
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
 *
 * Files included in the fixture:
 *   - src/store.ts               -> COMMANDER_WARROOM_FILE, COMMANDER_SQLITE_WARROOM_FILE
 *   - src/memoryStore.ts         -> COMMANDER_MEMORY_FILE
 *   - src/agentStateStore.ts     -> COMMANDER_AGENT_STATE_FILE
 *   - (removed) src/episodicMemoryStore.ts — health-only zombie deleted Phase B 2026-07-15
 *   - src/memoryIndexManager.ts  -> COMMANDER_MEMORY_DIR
 *   - src/actionRationale.ts     -> COMMANDER_ACTION_RATIONALE_FILE
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Set env vars BEFORE requiring the store modules. Top-level `const X = ??`
// is captured at module-load time, so the require order matters.
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-store-override-'));
process.env['COMMANDER_WARROOM_FILE'] = path.join(tmpRoot, 'war-room.json');
process.env['COMMANDER_MEMORY_FILE'] = path.join(tmpRoot, 'project-memory.json');
process.env['COMMANDER_AGENT_STATE_FILE'] = path.join(tmpRoot, 'agent-state.json');
process.env['COMMANDER_ACTION_RATIONALE_FILE'] = path.join(tmpRoot, 'action-rationales.json');
process.env['COMMANDER_MEMORY_DIR'] = path.join(tmpRoot, 'memory-index-dir');

// ---------------------------------------------------------------------------
// REQUIRES go AFTER env vars are set so module-top-level constants capture
// the overrides.
// ---------------------------------------------------------------------------

const { WarRoomStore, createWarRoomStore } = require('../dist/store.js');
const { ProjectMemoryStore } = require('../dist/memoryStore.js');
const { AgentStateStore } = require('../dist/agentStateStore.js');
const { ActionRationaleStore } = require('../dist/actionRationale.js');
const { MemoryIndexManager } = require('../dist/memoryIndexManager.js');

// ---------------------------------------------------------------------------
// Fallback paths mirror what each module would have used WITHOUT the env
// override. Compiled stores live at `apps/api/dist/*.js` so their
// `__dirname` is `apps/api/dist/` and `'../data/...'` resolves to
// `apps/api/data/...`. From this test (`apps/api/test/`), `../data/...`
// also resolves to `apps/api/data/...`. MemoryIndex fallback is
// `apps/api/memory/` (two levels up from `apps/api/dist/`).
// ---------------------------------------------------------------------------

const FALLBACK = {
  COMMANDER_WARROOM_FILE: path.resolve(__dirname, '..', 'data', 'war-room.json'),
  COMMANDER_MEMORY_FILE: path.resolve(__dirname, '..', 'data', 'project-memory.json'),
  COMMANDER_AGENT_STATE_FILE: path.resolve(__dirname, '..', 'data', 'agent-state.json'),
  COMMANDER_ACTION_RATIONALE_FILE: path.resolve(__dirname, '..', 'data', 'action-rationales.json'),
  COMMANDER_MEMORY_DIR: path.resolve(__dirname, '..', '..', 'memory'),
};

/**
 * Snapshot a file path AND its parent dir. Tolerates "parent doesn't exist"
 * via try/stat so a fresh clone (before any test has run) doesn't trip.
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
  if (before.file.exists) {
    const stat = fs.statSync(before.p);
    assert.equal(stat.mtimeMs, before.file.mtimeMs, `${label}: fallback ${before.p} mtime changed`);
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
// Per-store tests: "ONLY there" contract for each env var
// ---------------------------------------------------------------------------

test('WarRoomStore reads/writes only at COMMANDER_WARROOM_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_WARROOM_FILE);
  const store = new WarRoomStore();
  const projects = store.listProjects();
  assert.ok(projects.length > 0);
  assert.ok(fs.existsSync(process.env['COMMANDER_WARROOM_FILE']));
  assertFallbackNotTouched(before, 'WarRoomStore');
});

test('createWarRoomStore reads/writes only at COMMANDER_WARROOM_FILE', () => {
  const before = snapshot(FALLBACK.COMMANDER_WARROOM_FILE);
  const store = createWarRoomStore();
  const projects = store.listProjects();
  assert.ok(projects.length > 0);
  assert.ok(fs.existsSync(process.env['COMMANDER_WARROOM_FILE']));
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
  assert.ok(fs.existsSync(process.env['COMMANDER_MEMORY_FILE']));
  const items = JSON.parse(fs.readFileSync(process.env['COMMANDER_MEMORY_FILE'], 'utf8'));
  assert.ok(items.some((i) => i.id === item.id));
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
  assert.ok(fs.existsSync(process.env['COMMANDER_AGENT_STATE_FILE']));
  const items = JSON.parse(fs.readFileSync(process.env['COMMANDER_AGENT_STATE_FILE'], 'utf8'));
  assert.ok(
    items.some(
      (i) => i.projectId === 'project-override-test' && i.agentId === 'agent-override-test',
    ),
  );
  assertFallbackNotTouched(before, 'AgentStateStore');
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
  assert.ok(fs.existsSync(process.env['COMMANDER_ACTION_RATIONALE_FILE']));
  const items = JSON.parse(fs.readFileSync(process.env['COMMANDER_ACTION_RATIONALE_FILE'], 'utf8'));
  assert.ok(items.some((i) => i.actionType === 'test-action'));
  assertFallbackNotTouched(before, 'ActionRationaleStore');
});

test('MemoryIndexManager reads/writes only at COMMANDER_MEMORY_DIR', () => {
  const before = snapshot(path.join(FALLBACK.COMMANDER_MEMORY_DIR, 'index.json'));
  const mgr = new MemoryIndexManager('project-override-test');
  mgr.addDomain('Override-Test-Domain', 'Verifying env var redirect');
  const indexPath = path.join(process.env['COMMANDER_MEMORY_DIR'], 'index.json');
  assert.ok(fs.existsSync(indexPath));
  const raw = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(raw);
  assert.ok(index.pointers.some((p) => p.domain === 'Override-Test-Domain'));
  assertFallbackNotTouched(before, 'MemoryIndexManager');
});

// ---------------------------------------------------------------------------
// Asymmetric-config fail-fast: launched in a child Node process because the
// store constants are captured at module-load time in the parent's process.
// ---------------------------------------------------------------------------

function runChildProbe(probeBody) {
  const distDir = path.resolve(__dirname, '..', 'dist');
  const script = `
    const path = require('node:path');
    ${probeBody}
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: distDir });
}



