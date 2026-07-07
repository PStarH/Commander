// packages/core/tests/plugins/gap/quarterlyAudit.test.ts
import { describe, it, expect } from 'vitest';
import {
  runQuarterlyAudit,
  renderAuditMarkdown,
} from '../../../src/plugins/builtin/gap/quarterlyAudit';

describe('quarterlyAudit', () => {
  it('runQuarterlyAudit returns a valid report', () => {
    const r = runQuarterlyAudit(new Date('2026-06-30T00:00:00Z'));
    expect(r.quarter).toBe('2026-Q2');
    expect(r.generatedAt).toBe('2026-06-30T00:00:00.000Z');
  });

  it('renderAuditMarkdown produces a valid markdown structure', () => {
    const r = runQuarterlyAudit(new Date('2026-06-30T00:00:00Z'));
    const md = renderAuditMarkdown(r);
    expect(md).toContain('# Architecture Audit — 2026-Q2');
    expect(md).toContain('## Summary');
    expect(md).toContain('| Open gaps |');
  });
});
