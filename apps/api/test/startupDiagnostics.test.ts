import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('API startup diagnostics', () => {
  it('emits the canonical startup failure code before production environment exit', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const validation = source.slice(
      source.indexOf('function validateEnvironment(): void {'),
      source.indexOf('// ── Shared state'),
    );

    assert.match(
      validation,
      /COMMANDER_API_STARTUP_FAILED: missing required environment variables.*process\.exit\(1\)/s,
    );
  });
});
