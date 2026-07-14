import { describe, it, expect } from 'vitest';
import {
  validateBaseline,
  EvidenceLevel,
  BaselineDocument,
} from '../../src/benchmarks/baselineSchema';

const CURRENT = {
  gitSha: 'abc123',
  imageDigest: 'sha256:current',
};

function doc(overrides: Partial<BaselineDocument> = {}): BaselineDocument {
  return {
    evidenceLevel: 'simulated',
    baseline: { gitSha: CURRENT.gitSha, imageDigest: CURRENT.imageDigest },
    summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
    ...overrides,
  };
}

describe('validateBaseline strict', () => {
  it('passes for a healthy baseline', () => {
    const result = validateBaseline(doc(), CURRENT);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('passes when baseline binding fields are absent', () => {
    const result = validateBaseline(
      { evidenceLevel: 'live', summary: { passed: true } },
      { gitSha: 'any' },
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails when evidenceLevel is missing', () => {
    const result = validateBaseline(doc({ evidenceLevel: undefined }), CURRENT);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('missing or invalid evidenceLevel/env.evidence');
  });

  it('fails when evidenceLevel is invalid', () => {
    const result = validateBaseline(doc({ evidenceLevel: 'lab' as EvidenceLevel }), CURRENT);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('missing or invalid evidenceLevel/env.evidence');
  });

  it('fails when errors > 0', () => {
    const result = validateBaseline(
      doc({ summary: { passed: true, errors: 1, failed: 0, skipped: 0 } }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('errors > 0');
  });

  it('fails when failed > 0', () => {
    const result = validateBaseline(
      doc({ summary: { passed: true, errors: 0, failed: 3, skipped: 0 } }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('failed > 0');
  });

  it('fails when skipped > 0', () => {
    const result = validateBaseline(
      doc({ summary: { passed: true, errors: 0, failed: 0, skipped: 5 } }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('skipped > 0');
  });

  it('fails when passed=false', () => {
    const result = validateBaseline(
      doc({ summary: { passed: false, errors: 0, failed: 0, skipped: 0 } }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('summary.passed is not true');
  });

  it('fails when gitSha mismatches for live evidence', () => {
    const result = validateBaseline(
      doc({
        evidenceLevel: 'live',
        baseline: { gitSha: 'old', imageDigest: CURRENT.imageDigest },
      }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('gitSha mismatch');
  });

  it('ignores gitSha mismatches for simulated evidence', () => {
    const result = validateBaseline(
      doc({ baseline: { gitSha: 'old', imageDigest: CURRENT.imageDigest } }),
      CURRENT,
    );
    expect(result.ok).toBe(true);
  });

  it('fails when imageDigest mismatches for live evidence', () => {
    const result = validateBaseline(
      doc({
        evidenceLevel: 'live',
        baseline: { gitSha: CURRENT.gitSha, imageDigest: 'sha256:old' },
      }),
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('imageDigest mismatch');
  });

  it('does not fail imageDigest when current has no digest', () => {
    const result = validateBaseline(
      doc({
        evidenceLevel: 'live',
        baseline: { gitSha: CURRENT.gitSha, imageDigest: 'sha256:any' },
      }),
      { gitSha: CURRENT.gitSha },
    );
    expect(result.ok).toBe(true);
  });

  it('reports multiple reasons at once', () => {
    const result = validateBaseline(
      {
        evidenceLevel: 'live',
        baseline: { gitSha: 'mismatch' },
        summary: { passed: false, errors: 7, failed: 2, skipped: 1 },
      },
      CURRENT,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.sort()).toEqual(
      [
        'errors > 0',
        'failed > 0',
        'skipped > 0',
        'summary.passed is not true',
        'gitSha mismatch',
      ].sort(),
    );
  });
});
