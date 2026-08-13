import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectPostgresTlsInitFailureLogs,
  POSTGRES_TLS_INIT_LOG_TAIL_LINES,
} from './l4-b-cell-up-assert.js';

describe('l4-b-cell-up-assert failure diagnostics', () => {
  it('collects only a sanitized tail from postgres-tls-init', () => {
    const commands: string[] = [];
    const logLines = [
      'early line',
      'POSTGRES_PASSWORD=do-not-persist',
      ...Array.from({ length: POSTGRES_TLS_INIT_LOG_TAIL_LINES }, (_, index) =>
        index === 4
          ? 'COMMANDER_API_KEY=must-not-appear'
          : index === 5
            ? '-----BEGIN PRIVATE KEY-----\nsecret-key-material\n-----END PRIVATE KEY-----'
            : `tail ${index}`,
      ),
    ];

    const logs = collectPostgresTlsInitFailureLogs({}, (command) => {
      commands.push(command);
      return logLines.join('\n');
    });

    assert.deepEqual(commands, [
      'docker compose -f docker-compose.yml -f docker-compose.cell.yml --profile cell logs --no-color --tail 80 postgres-tls-init',
    ]);
    assert.match(logs, /tail 79/);
    assert.doesNotMatch(logs, /early line|do-not-persist|must-not-appear|secret-key-material/);
    assert.match(logs, /COMMANDER_API_KEY=\[REDACTED\]/);
    assert.match(logs, /\[REDACTED PEM\]/);
  });
});
