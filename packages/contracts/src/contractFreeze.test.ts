import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTITUTION_CONTRACT_VERSIONS,
  RUN_CONTRACT_VERSION,
  EVENT_CONTRACT_VERSION,
  EFFECT_CONTRACT_VERSION,
  GRANT_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
} from './versioned.js';
import {
  snapshotContracts,
  detectSchemaBreakingChanges,
  canonicalSchemaHash,
  fixtureHash,
} from './compatibility.v2.js';

describe('contract freeze — constitution constants', () => {
  it('exports five versioned contract constants', () => {
    assert.deepEqual(CONSTITUTION_CONTRACT_VERSIONS, [
      'commander.run/v2',
      'commander.event/v2',
      'commander.effect/v2',
      'commander.grant/v1',
      'commander.artifact/v1',
    ]);
    assert.equal(RUN_CONTRACT_VERSION, 'commander.run/v2');
    assert.equal(EVENT_CONTRACT_VERSION, 'commander.event/v2');
    assert.equal(EFFECT_CONTRACT_VERSION, 'commander.effect/v2');
    assert.equal(GRANT_CONTRACT_VERSION, 'commander.grant/v1');
    assert.equal(ARTIFACT_CONTRACT_VERSION, 'commander.artifact/v1');
  });
});

describe('contract freeze — snapshot v2', () => {
  it('snapshot includes five contracts with schema hashes and fixtures', () => {
    const snapshot = snapshotContracts();
    assert.equal(Object.keys(snapshot.contracts).length, 5);
    for (const key of ['run', 'event', 'effect', 'grant', 'artifact']) {
      const entry = snapshot.contracts[key];
      assert.ok(entry.schemaHash.length === 64, `${key} schemaHash`);
      assert.ok(entry.fixtureHashes.minimal?.length === 64, `${key} fixture hash`);
    }
  });

  it('detectSchemaBreakingChanges flags required field removal without version bump', () => {
    const baseline = snapshotContracts();
    const current = structuredClone(baseline);
    current.contracts.grant.required = current.contracts.grant.required.filter((f) => f !== 'nonce');
    const changes = detectSchemaBreakingChanges(baseline, current);
    assert.ok(changes.some((c) => c.includes('nonce')));
  });

  it('canonicalSchemaHash is stable for same input', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    assert.equal(canonicalSchemaHash(schema), canonicalSchemaHash(schema));
  });

  it('fixtureHash is deterministic', () => {
    assert.equal(fixtureHash('{"a":1}'), fixtureHash('{"a":1}'));
  });

  it('detectSchemaBreakingChanges flags additionalProperties relaxation', () => {
    const baseline = snapshotContracts();
    const current = structuredClone(baseline);
    current.contracts.run.additionalProperties = true;
    current.contracts.run.properties = {
      ...current.contracts.run.properties,
      baitField: { type: 'string' },
    };
    current.contracts.run.schemaHash = 'f'.repeat(64);
    const changes = detectSchemaBreakingChanges(baseline, current);
    assert.ok(changes.some((c) => c.includes('BREAKING') && c.includes('run')));
  });
});
