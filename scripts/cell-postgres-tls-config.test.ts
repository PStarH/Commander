import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const cellCompose = readFileSync(new URL('../docker-compose.cell.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

const tlsConsumers = ['api', 'worker', 'adapter-ops'];

function serviceBlock(name: string): string {
  const start = cellCompose.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `${name} must be defined in the cell compose override`);
  const next = cellCompose.slice(start + 1).search(/^  [A-Za-z0-9-]+:/m);
  return cellCompose.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('cell PostgreSQL TLS configuration', () => {
  it('requires a real CI TLS fixture and exports its expected server SPKI', () => {
    assert.match(ciWorkflow, /Generate cell PostgreSQL TLS fixture/);
    assert.match(ciWorkflow, /openssl req -x509/);
    assert.match(ciWorkflow, /DNS:postgres/);
    assert.match(ciWorkflow, /COMMANDER_CELL_POSTGRES_TLS_DIR=/);
    assert.match(ciWorkflow, /COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256=/);
  });

  it('runs PostgreSQL with a protected server key copied from the fixture', () => {
    assert.match(cellCompose, /postgres-tls-init:/);
    assert.match(cellCompose, /postgres-tls-init:[\s\S]*?user: '0:0'/);
    assert.match(cellCompose, /cell-postgres-tls:/);
    assert.match(cellCompose, /condition: service_completed_successfully/);
    assert.match(cellCompose, /chown 70:70 [^\n]*\/etc\/postgres-tls\/server\.key/);
    assert.match(cellCompose, /chmod 0600 \/etc\/postgres-tls\/server\.key/);
    assert.match(cellCompose, /ssl=on/);
    assert.match(cellCompose, /ssl_cert_file=\/etc\/postgres-tls\/server\.crt/);
    assert.match(cellCompose, /ssl_key_file=\/etc\/postgres-tls\/server\.key/);
    assert.match(cellCompose, /ssl_ca_file=\/etc\/postgres-tls\/ca\.crt/);
  });

  for (const consumer of tlsConsumers) {
    it(`${consumer} uses verify-full with the fixture CA and pinned server SPKI`, () => {
      const service = serviceBlock(consumer);
      assert.match(service, /postgres:\/\/[^\s]+\?sslmode=verify-full/);
      assert.match(
        service,
        /COMMANDER_DATABASE_TLS_CA_FILE=\/run\/commander\/postgres-tls\/ca\.crt/,
      );
      assert.match(
        service,
        /COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256=\$\{COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256:\?set COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256\}/,
      );
      assert.match(service, /\/run\/commander\/postgres-tls\/ca\.crt:ro/);
    });
  }
});
