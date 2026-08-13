import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApiStore } from '../src/stores/apiStore.js';

describe('PostgreSQL API store TLS', () => {
  it('refuses to construct without the verified CA and SPKI configuration', () => {
    const previousCaFile = process.env.COMMANDER_DATABASE_TLS_CA_FILE;
    const previousSpki = process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256;
    delete process.env.COMMANDER_DATABASE_TLS_CA_FILE;
    delete process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256;

    try {
      assert.throws(
        () =>
          createApiStore({
            backend: 'postgres',
            connectionString: 'postgres://api:secret@db.internal/commander?sslmode=verify-full',
          }),
        /COMMANDER_DATABASE_TLS_CA_FILE_REQUIRED/,
      );
    } finally {
      if (previousCaFile === undefined) delete process.env.COMMANDER_DATABASE_TLS_CA_FILE;
      else process.env.COMMANDER_DATABASE_TLS_CA_FILE = previousCaFile;
      if (previousSpki === undefined) {
        delete process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256;
      } else {
        process.env.COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256 = previousSpki;
      }
    }
  });
});
