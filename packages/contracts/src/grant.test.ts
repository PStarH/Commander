import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRANT_CONTRACT_VERSION, wrapGrantV1, type GrantV1 } from './grant.js';
import { upcastLegacyGrantToV1 } from './upcasters/grant-legacy-to-v1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '../fixtures/grant/v1/minimal.json');
const SCHEMA_PATH = join(__dirname, '../schemas/commander.grant/v1.json');

interface JsonSchemaNode {
  $id?: string;
  type?: string;
  const?: unknown;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
}

/**
 * Structural JSON-Schema check over the subset the published grant schema uses
 * (type / const / required / properties / items / additionalProperties). The
 * point is that `schemas/commander.grant/v1.json` is now exercised: it was
 * shipped in the image (Dockerfile:117) but loaded by no code or test, so it
 * could drift from the fixture and the TypeScript `GrantV1` contract in silence.
 */
function assertMatchesSchema(path: string, schema: JsonSchemaNode, value: unknown): void {
  assert.ok(value !== undefined, `${path} is present`);
  if (schema.const !== undefined) {
    assert.equal(value, schema.const, `${path} must equal ${String(schema.const)}`);
  }
  if (schema.type === 'object') {
    assert.ok(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      `${path} must be an object`,
    );
    const obj = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) {
      assert.ok(field in obj, `${path}.${field} is required by the schema`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in obj) assertMatchesSchema(`${path}.${key}`, child, obj[key]);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        assert.ok(key in properties, `${path}.${key} is not declared by the schema`);
      }
    }
    return;
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    for (const [index, item] of (value as unknown[]).entries()) {
      assertMatchesSchema(`${path}[${index}]`, schema.items ?? {}, item);
    }
    return;
  }
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} must be a string`);
}

function loadSchema(): JsonSchemaNode {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as JsonSchemaNode;
}

const GRANT_V1_SAMPLE: GrantV1 = {
  schemaVersion: GRANT_CONTRACT_VERSION,
  jti: 'j1',
  tenantId: 't1',
  runId: 'r1',
  stepId: 's1',
  effectTypes: ['connector.github.pull-request.create'],
  expiresAt: '2026-12-31T00:00:00.000Z',
  issuer: 'i',
  audience: 'a',
  issuedAt: '2026-01-01T00:00:00.000Z',
  notBefore: '2026-01-01T00:00:00.000Z',
  keyId: 'k',
  requestHash: 'h',
  workloadId: 'w',
  policySnapshotId: 'p',
  nonce: 'n',
};

describe('GrantV1', () => {
  it('fixture has all required fields', () => {
    const raw = readFileSync(join(__dirname, '../fixtures/grant/v1/minimal.json'), 'utf-8');
    const envelope = JSON.parse(raw);
    assert.equal(envelope.schemaVersion, GRANT_CONTRACT_VERSION);
    const required = [
      'schemaVersion',
      'jti',
      'tenantId',
      'runId',
      'stepId',
      'effectTypes',
      'expiresAt',
      'issuer',
      'audience',
      'issuedAt',
      'notBefore',
      'keyId',
      'requestHash',
      'workloadId',
      'policySnapshotId',
      'nonce',
    ];
    for (const field of required) {
      assert.ok(field in envelope.payload, `missing ${field}`);
    }
  });

  it('legacy upcast fills schemaVersion and required defaults', () => {
    const grant = upcastLegacyGrantToV1(
      {
        jti: 'j1',
        tenantId: 't1',
        runId: 'r1',
        stepId: 's1',
        effectTypes: ['http.get'],
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
      { issuer: 'iss', audience: 'aud', keyId: 'k1' },
    );
    assert.equal(grant.schemaVersion, GRANT_CONTRACT_VERSION);
    assert.equal(grant.issuer, 'iss');
    assert.ok(grant.nonce);
  });

  it('wrapGrantV1 produces envelope', () => {
    const wrapped = wrapGrantV1({
      schemaVersion: GRANT_CONTRACT_VERSION,
      jti: 'j1',
      tenantId: 't1',
      runId: 'r1',
      stepId: 's1',
      effectTypes: [],
      expiresAt: '2026-12-31T00:00:00.000Z',
      issuer: 'i',
      audience: 'a',
      issuedAt: '2026-01-01T00:00:00.000Z',
      notBefore: '2026-01-01T00:00:00.000Z',
      keyId: 'k',
      requestHash: 'h',
      workloadId: 'w',
      policySnapshotId: 'p',
      nonce: 'n',
    });
    assert.equal(wrapped.kind, 'grant');
  });

  it('fixture effectTypes align with GitHub production descriptor', async () => {
    const { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } = await import('./actionAdapters.js');
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const envelope = JSON.parse(raw);
    assert.deepEqual(envelope.payload.effectTypes, [
      GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.effectType,
    ]);
  });

  describe('published JSON schema', () => {
    it('accepts the fixture envelope', () => {
      const schema = loadSchema();
      const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
      assert.equal(schema.$id, GRANT_CONTRACT_VERSION);
      assertMatchesSchema('grant', schema, envelope);
    });

    it('rejects an undeclared field (additionalProperties: false)', () => {
      const schema = loadSchema();
      const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
      assert.throws(() => assertMatchesSchema('grant', schema, { ...envelope, smuggled: 'x' }));
    });

    it('rejects a payload missing a required field', () => {
      const schema = loadSchema();
      const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
      const { nonce: _nonce, ...withoutNonce } = envelope.payload as Record<string, unknown>;
      assert.throws(() =>
        assertMatchesSchema('grant', schema, { ...envelope, payload: withoutNonce }),
      );
    });

    it('rejects a payload field of the wrong type', () => {
      const schema = loadSchema();
      const envelope = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
      assert.throws(() =>
        assertMatchesSchema('grant', schema, {
          ...envelope,
          payload: { ...envelope.payload, nonce: 7 },
        }),
      );
    });

    it('schema payload surface matches the TypeScript GrantV1 contract exactly', () => {
      const schema = loadSchema();
      const payloadSchema = schema.properties?.payload;
      assert.ok(payloadSchema, 'schema must declare a payload object');
      const schemaKeys = Object.keys(payloadSchema.properties ?? {}).sort();
      const typeKeys = Object.keys(GRANT_V1_SAMPLE).sort();
      assert.deepEqual(
        schemaKeys,
        typeKeys,
        'schema payload properties and GrantV1 fields have drifted apart',
      );
      // GrantV1 declares no optional field, so the schema must require them all.
      assert.deepEqual([...(payloadSchema.required ?? [])].sort(), typeKeys);
      // The envelope the runtime produces must satisfy the published schema.
      assertMatchesSchema('grant', schema, wrapGrantV1(GRANT_V1_SAMPLE));
    });
  });
});
