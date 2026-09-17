/**
 * Child fixture for LM-24 config_change mapping.
 *
 * `approvalConfigEndpoints` resolves its audit-log path from `process.cwd()` at
 * module load. The parent test therefore spawns this file with cwd set to an
 * owned temp directory, so nothing is written into the repository.
 *
 * Prints a single JSON line describing what the approval-audit reader returned.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { createApprovalConfigRouter } from '../../src/approvalConfigEndpoints';

const TENANT = 'tenant-a';
const auditDir = path.join(process.cwd(), '.commander');
fs.mkdirSync(auditDir, { recursive: true });
const auditFile = path.join(auditDir, 'security-audit.jsonl');

// A `config_change` record exactly as `auditConfigChange()` writes it, plus a
// legacy approval record and a foreign-tenant record that must be excluded.
const lines = [
  {
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'config_change',
    action: 'approval.mode.set',
    actor: 'user-actor',
    tenantId: TENANT,
    ip: '127.0.0.1',
    detail: { mode: 'manual' },
  },
  {
    timestamp: '2026-01-01T00:00:01.000Z',
    event: 'approval.decision',
    decision: 'approved',
    userId: 'legacy-approver',
    tenantId: TENANT,
  },
  {
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'config_change',
    action: 'approval.mode.set',
    actor: 'other-tenant-actor',
    tenantId: 'tenant-b',
    ip: '127.0.0.1',
    detail: { mode: 'full-auto' },
  },
];
fs.writeFileSync(auditFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

function injectReader(req: Request, _res: Response, next: () => void): void {
  req.user = { id: 'auditor-1', username: 'auditor-1', role: 'auditor', tenantId: TENANT };
  req.tenantId = TENANT;
  next();
}

async function main(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(injectReader);
  app.use('/', createApprovalConfigRouter());

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address() as { port: number };
  try {
    // A caller-supplied tenantId in the query must not widen the scope.
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/api/approval/audit-log?limit=50&tenantId=tenant-b`,
    );
    const body = (await res.json()) as { entries: unknown[]; total: number };
    process.stdout.write(
      JSON.stringify({ status: res.status, entries: body.entries, total: body.total }) + '\n',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main();
