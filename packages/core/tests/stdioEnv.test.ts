import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { StdioClientTransport } from '../src/mcp/client';

test('MCP stdio inherits only the allowlisted environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-env-'));
  const script = path.join(dir, 'print-env.js');
  const out = path.join(dir, 'out.txt');
  fs.writeFileSync(
    script,
    `const fs = require('fs');
const keys = ['DATABASE_URL', 'MYSQL_PWD', 'KUBECONFIG', 'PATH', 'MARKER'];
fs.writeFileSync(process.argv[2], keys.filter((k) => process.env[k] !== undefined).join(','));
`,
  );
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    MYSQL_PWD: process.env.MYSQL_PWD,
    KUBECONFIG: process.env.KUBECONFIG,
  };
  process.env.DATABASE_URL = 'postgres://user:pass@db/app';
  process.env.MYSQL_PWD = 'secret';
  process.env.KUBECONFIG = '/tmp/kube';
  const transport = new StdioClientTransport({
    transport: 'stdio',
    command: 'node',
    args: [script, out],
    env: { MARKER: 'from-config' },
  });
  try {
    await transport.start();
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(out) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const body = fs.readFileSync(out, 'utf8');
    assert.equal(body.includes('DATABASE_URL'), false);
    assert.equal(body.includes('MYSQL_PWD'), false);
    assert.equal(body.includes('KUBECONFIG'), false);
    assert.equal(body.includes('PATH'), true);
    assert.equal(body.includes('MARKER'), true);
  } finally {
    await transport.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
