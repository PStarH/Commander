import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORITY_CLASSIFIER_MANIFEST_V1,
  AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
  authorityClassifierManifestSha256,
  exportAuthorityClassifierManifest,
  verifyAuthorityClassifierCatalog,
  verifyAuthorityClassifierManifest,
} from './authorityClassifierManifest.js';
import { canonicalBootstrapJson } from './canonicalBootstrap.js';

test('loads a literal versioned authority-classifier manifest', () => {
  assert.equal(AUTHORITY_CLASSIFIER_MANIFEST_V1.version, 'authority_classifier_manifest/v1');
  assert.ok(AUTHORITY_CLASSIFIER_MANIFEST_V1.rows.length > 0);
  assert.ok(Object.isFrozen(AUTHORITY_CLASSIFIER_MANIFEST_V1));
  assert.ok(Object.isFrozen(AUTHORITY_CLASSIFIER_MANIFEST_V1.rows));
  assert.match(authorityClassifierManifestSha256(), /^[a-f0-9]{64}$/);
  assert.equal(
    AUTHORITY_CLASSIFIER_MANIFEST_SHA256,
    'e2d15e6403cc363e050bfe092de8e28197c86b7980f1fe83e0f079fb20a7d008',
  );
  assert.equal(authorityClassifierManifestSha256(), AUTHORITY_CLASSIFIER_MANIFEST_SHA256);
  assert.deepEqual(
    verifyAuthorityClassifierManifest(AUTHORITY_CLASSIFIER_MANIFEST_V1),
    AUTHORITY_CLASSIFIER_MANIFEST_V1,
  );
});

test('covers every finite authority category with exact named entries', () => {
  assert.deepEqual(
    new Set(AUTHORITY_CLASSIFIER_MANIFEST_V1.rows.map((row) => row.category)),
    new Set([
      'app-context',
      'tenant-authority-issuer',
      'app-product-shared',
      'runtime-daemon',
      'owner-lifecycle',
      'private-helper',
      'structural-trigger',
    ]),
  );
  assert.ok(AUTHORITY_CLASSIFIER_MANIFEST_V1.rows.some((row) => row.signature === 'issue_app_tenant_context(text,oid,integer,xid8)'));
  assert.ok(AUTHORITY_CLASSIFIER_MANIFEST_V1.rows.some((row) => row.signature === 'commander_runtime_configuration_identity()'));
  assert.deepEqual(
    AUTHORITY_CLASSIFIER_MANIFEST_V1.rows.find(
      (row) => row.signature === 'reject_tenant_cutover_operation_mutation()',
    )?.triggerBinding,
    {
      relation: 'public.commander_tenant_cutover_operations',
      events: ['DELETE', 'UPDATE'],
      columns: [],
    },
  );
  assert.equal(
    AUTHORITY_CLASSIFIER_MANIFEST_V1.policies.filter((policy) => policy.role === 'commander_worker').length,
    18,
  );
});

test('exports canonical JSON independently of catalog row ordering', () => {
  const reordered = {
    ...AUTHORITY_CLASSIFIER_MANIFEST_V1,
    rows: [...AUTHORITY_CLASSIFIER_MANIFEST_V1.rows].reverse(),
    policies: [...AUTHORITY_CLASSIFIER_MANIFEST_V1.policies].reverse(),
  };
  assert.equal(
    exportAuthorityClassifierManifest(reordered),
    exportAuthorityClassifierManifest(AUTHORITY_CLASSIFIER_MANIFEST_V1),
  );
  assert.match(exportAuthorityClassifierManifest(AUTHORITY_CLASSIFIER_MANIFEST_V1), /^\{"policies":/);
  assert.equal(
    exportAuthorityClassifierManifest(AUTHORITY_CLASSIFIER_MANIFEST_V1),
    canonicalBootstrapJson({
      version: AUTHORITY_CLASSIFIER_MANIFEST_V1.version,
      rows: [...AUTHORITY_CLASSIFIER_MANIFEST_V1.rows].sort((a, b) =>
        a.signature.localeCompare(b.signature)),
      policies: [...AUTHORITY_CLASSIFIER_MANIFEST_V1.policies].sort((a, b) =>
        `${a.relation}:${a.role}:${a.name}:${a.command}`.localeCompare(
          `${b.relation}:${b.role}:${b.name}:${b.command}`,
        )),
    }),
  );
});

const comparisonFixture = {
  version: 'authority_classifier_manifest/v1',
  rows: [
    {
      signature: 'admit_class_a_effect(text)',
      category: 'app-product-shared',
      owner: 'commander_owner',
      executableRoles: ['commander_app'],
      allowedSessionUsers: ['commander_app'],
      allowedRelations: ['public.commander_effects'],
      appResolverRequired: true,
      triggerBinding: null,
    },
    {
      signature: 'enforce_effect_scope()',
      category: 'structural-trigger',
      owner: 'commander_owner',
      executableRoles: [],
      allowedSessionUsers: [],
      allowedRelations: ['public.commander_effects'],
      appResolverRequired: false,
      triggerBinding: {
        relation: 'public.commander_effects',
        events: ['INSERT'],
        columns: ['tenant_id'],
      },
    },
  ],
  policies: [
    {
      relation: 'public.commander_effects',
      role: 'commander_app',
      name: 'commander_app_authenticated_tenant',
      command: 'ALL',
    },
  ],
} as const;

test('rejects malformed or wildcard literal rows', () => {
  const duplicate = structuredClone(comparisonFixture);
  duplicate.rows.push(structuredClone(duplicate.rows[0]));
  assert.throws(() => verifyAuthorityClassifierManifest(duplicate), /duplicate signatures/);

  const wildcard = structuredClone(comparisonFixture);
  wildcard.rows[0].allowedRelations[0] = 'public.*';
  assert.throws(() => verifyAuthorityClassifierManifest(wildcard), /must be an exact string list/);

  const extraField = structuredClone(comparisonFixture) as Record<string, unknown>;
  extraField.unapproved = true;
  assert.throws(() => verifyAuthorityClassifierManifest(extraField), /keys must exactly match/);
});

test('rejects catalog rows and policies that differ from the literal manifest', () => {
  const expected = verifyAuthorityClassifierManifest(comparisonFixture);
  assert.deepEqual(verifyAuthorityClassifierCatalog(expected, expected), expected);

  const cases: Array<[string, unknown]> = [
    ['missing', { ...expected, rows: expected.rows.slice(1) }],
    ['extra', { ...expected, rows: [...expected.rows, { ...expected.rows[0], signature: 'extra()' }] }],
    ['category', { ...expected, rows: [{ ...expected.rows[0], category: 'runtime-daemon' }, expected.rows[1]] }],
    ['dependency', { ...expected, rows: [{ ...expected.rows[0], allowedRelations: ['public.commander_runs'] }, expected.rows[1]] }],
    ['grant', { ...expected, rows: [{ ...expected.rows[0], executableRoles: [] }, expected.rows[1]] }],
    ['trigger', { ...expected, rows: [expected.rows[0], { ...expected.rows[1], triggerBinding: { ...expected.rows[1].triggerBinding!, events: ['UPDATE'] } }] }],
    ['policy', { ...expected, policies: [{ ...expected.policies[0], role: 'commander_worker' }] }],
  ];

  for (const [name, observed] of cases) {
    assert.throws(() => verifyAuthorityClassifierCatalog(expected, observed), new RegExp(`CATALOG_MISMATCH: ${name}`));
  }
});
