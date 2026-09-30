import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { collectExternalAcceptanceBuildMetadata } from './openai-agents-mcp-build-metadata.js';

const root = resolve(import.meta.dirname, '..');

describe('OpenAI Agents MCP acceptance build metadata', () => {
  it('records source commit and fresh hashes for the launched adapter-ops dist', async () => {
    const metadata = await collectExternalAcceptanceBuildMetadata(root);
    assert.match(metadata.sourceCommit, /^[0-9a-f]{40}$/);
    const adapterOps = metadata.files.filter((file) =>
      file.dist.startsWith('packages/adapter-ops/'),
    );
    assert.ok(adapterOps.length > 0);
    for (const file of adapterOps) {
      assert.match(file.sourceSha256, /^[0-9a-f]{64}$/);
      assert.match(file.distSha256, /^[0-9a-f]{64}$/);
      assert.ok(file.distMtimeMs >= file.sourceMtimeMs, file.dist);
    }
  });
});
