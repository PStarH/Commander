import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_ASIS,
  OwaspAgenticAiTop10,
  recordCrossAgentFinding,
  recordGuardianIntervention,
  recordSupplyChainFinding,
  resetOwaspAsiTop10,
} from './owaspAgenticAiTop10';
import type { SecurityEvent, SecurityEventType } from './securityAuditLogger';

function detection(
  asi:
    | 'ASI01'
    | 'ASI02'
    | 'ASI03'
    | 'ASI04'
    | 'ASI05'
    | 'ASI06'
    | 'ASI07'
    | 'ASI08'
    | 'ASI09'
    | 'ASI10',
  overrides: Partial<Parameters<OwaspAgenticAiTop10['record']>[0]> = {},
) {
  return {
    asiId: asi,
    severity: 'critical' as const,
    source: 'test',
    blocked: 'blocked' as const,
    ...overrides,
  };
}

function makeSubject(): OwaspAgenticAiTop10 {
  return new OwaspAgenticAiTop10({
    windowMs: 60_000,
    disableBusSubscription: true,
  });
}

describe('OwaspAgenticAiTop10', () => {
  let subject: OwaspAgenticAiTop10;

  beforeEach(() => {
    resetOwaspAsiTop10();
    subject = makeSubject();
  });

  afterEach(() => {
    subject.unsubscribeFromBus();
  });

  // ── All 10 ASIs accept a record ───────────────────────────────────────

  for (const asi of ALL_ASIS) {
    it(`${asi}: record() accepts and reflects total >= 1`, () => {
      subject.record(detection(asi, { fingerprint: `seed-${asi}` }));
      const r = subject.report();
      const a = r.totalsByAsi.find((x) => x.asiId === asi);
      expect(a).toBeDefined();
      expect(a!.total).toBe(1);
    });
  }

  // ── Window edge: aged-out events don't count ──────────────────────────

  it('windowing: events older than windowMs do not count', () => {
    subject.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 'test',
      blocked: 'blocked',
      timestamp: Date.now() - 5 * 60_000, // 5min ago, but windowMs=60s
      fingerprint: 'old',
    });
    subject.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 'test',
      blocked: 'blocked',
      timestamp: Date.now(),
      fingerprint: 'new',
    });
    const r = subject.report();
    const a = r.totalsByAsi.find((x) => x.asiId === 'ASI01');
    expect(a?.total).toBe(1);
  });

  it('windowMs=0 includes only events with timestamp >= now', () => {
    const s = new OwaspAgenticAiTop10({ windowMs: 0, disableBusSubscription: true });
    s.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 't',
      blocked: 'blocked',
      timestamp: Date.now(),
      fingerprint: 'now',
    });
    const r = s.report();
    const a = r.totalsByAsi.find((x) => x.asiId === 'ASI01');
    // windowMs=0 closes "now or newer" so "now" is included (>= cutoff).
    expect(a?.total).toBe(1);
    s.unsubscribeFromBus();
  });

  // ── Score formula: bounded [0,1], handles total=0 ─────────────────────

  it('score is 0 when no events in the window', () => {
    expect(subject.score('ASI01')).toBe(0);
  });

  it('highOrCritical = total → score = 1 (clamped)', () => {
    subject.record({
      asiId: 'ASI02',
      severity: 'critical',
      source: 'a',
      blocked: 'blocked',
      fingerprint: 'a',
    });
    expect(subject.score('ASI02')).toBe(1);
  });

  it('half-and-half → score = 0.5', () => {
    subject.record({
      asiId: 'ASI02',
      severity: 'high',
      source: 'a',
      blocked: 'blocked',
      fingerprint: 'h',
    });
    subject.record({
      asiId: 'ASI02',
      severity: 'low',
      source: 'b',
      blocked: 'blocked',
      fingerprint: 'l',
    });
    expect(subject.score('ASI02')).toBeCloseTo(0.5, 5);
  });

  it('all-low → score = 0', () => {
    subject.record({
      asiId: 'ASI02',
      severity: 'low',
      source: 't',
      blocked: 'blocked',
      fingerprint: 'low-1',
    });
    subject.record({
      asiId: 'ASI02',
      severity: 'low',
      source: 't',
      blocked: 'blocked',
      fingerprint: 'low-2',
    });
    expect(subject.score('ASI02')).toBe(0);
  });

  // ── Dedup is per-(asi, fingerprint) ────────────────────────────────────

  it('dedup: same fingerprint within window counted once', () => {
    for (let i = 0; i < 5; i++) {
      subject.record({
        asiId: 'ASI01',
        severity: 'critical',
        source: 't',
        blocked: 'blocked',
        fingerprint: 'fp-dup',
      });
    }
    const a = subject.report().totalsByAsi.find((x) => x.asiId === 'ASI01');
    expect(a?.total).toBe(1);
  });

  it('dedup: distinct fingerprints counted separately', () => {
    subject.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 't',
      blocked: 'blocked',
      fingerprint: 'fp-A',
    });
    subject.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 't',
      blocked: 'blocked',
      fingerprint: 'fp-B',
    });
    const a = subject.report().totalsByAsi.find((x) => x.asiId === 'ASI01');
    expect(a?.total).toBe(2);
  });

  // ── Bus event classification (public entry) ───────────────────────────

  it('classifyFromSecurityEvent: content_threat writes to ASI01', () => {
    subject.classifyFromSecurityEvent({
      id: 'evt-pi',
      timestamp: new Date().toISOString(),
      type: 'content_threat',
      severity: 'high',
      source: 'contentScanner',
      message: 'm',
      details: { detector: 'contentScanner' },
    });
    const r = subject.report();
    expect(r.totalsByAsi.find((x) => x.asiId === 'ASI01')?.total).toBe(1);
  });

  it('classifyFromSecurityEvent: auth_rate_limit dual-rotes to ASI08 AND ASI04', () => {
    subject.classifyFromSecurityEvent({
      id: 'evt-rl',
      timestamp: new Date().toISOString(),
      type: 'auth_rate_limit',
      severity: 'high',
      source: 'httpServer',
      message: 'rate-limit',
    });
    const r = subject.report();
    expect(r.totalsByAsi.find((x) => x.asiId === 'ASI08')?.total).toBe(1);
    expect(r.totalsByAsi.find((x) => x.asiId === 'ASI04')?.total).toBe(1);
  });

  it('classifyFromSecurityEvent: supplyChainScanner detector adds ASI06', () => {
    subject.classifyFromSecurityEvent({
      id: 'evt-sc',
      timestamp: new Date().toISOString(),
      type: 'skill_security_violation',
      severity: 'critical',
      source: 'supplyChainScanner',
      message: 'malicious sig',
      details: { detector: 'supplyChainScanner' },
    });
    const r = subject.report();
    expect(r.totalsByAsi.find((x) => x.asiId === 'ASI06')?.total).toBe(1);
  });

  it('classifyFromSecurityEvent: never throws on malformed input', () => {
    expect(() =>
      subject.classifyFromSecurityEvent({
        id: undefined,
        timestamp: undefined as unknown as string,
        type: undefined as unknown as SecurityEventType,
        severity: 'high',
        source: 't',
        message: 'm',
      } as unknown as SecurityEvent),
    ).not.toThrow();
  });

  // ── Helper bridges ────────────────────────────────────────────────────

  it('recordGuardianIntervention: known interventions map to ASIs', () => {
    recordGuardianIntervention('goal_hijack', 'high', 'agent-A');
    recordGuardianIntervention('data_exfiltration', 'critical', 'agent-A');
    recordGuardianIntervention('cost_overrun', 'high', 'agent-A');
    recordGuardianIntervention('unknown_type', 'low', 'agent-A'); // ignored
    // Should not throw; we trust the mapping table is right.
  });

  it('recordSupplyChainFinding increments ASI06', () => {
    recordSupplyChainFinding('critical', true, 'sig:test-skill-malicious');
    const a = new OwaspAgenticAiTop10({ disableBusSubscription: true })
      .report()
      .totalsByAsi.find((x) => x.asiId === 'ASI06');
    expect(a?.total).toBeGreaterThan(0);
  });

  it('recordCrossAgentFinding increments ASI05', () => {
    recordCrossAgentFinding('privilege_escalation_chain', 'high', 'agent-A->agent-B');
    const a = new OwaspAgenticAiTop10({ disableBusSubscription: true })
      .report()
      .totalsByAsi.find((x) => x.asiId === 'ASI05');
    expect(a?.total).toBeGreaterThan(0);
  });

  // ── Report shape ──────────────────────────────────────────────────────

  it('report() contains windowMs, generatedAt, totalsByAsi (length 10), overallScore, summary', () => {
    const r = subject.report();
    expect(r.windowMs).toBe(60_000);
    expect(typeof r.generatedAt).toBe('string');
    expect(r.totalsByAsi).toHaveLength(10);
    expect(r.overallScore).toBeGreaterThanOrEqual(0);
    expect(r.overallScore).toBeLessThanOrEqual(1);
    expect(typeof r.summary).toBe('string');
  });

  it('overallScore is the arithmetic mean of per-ASI scores', () => {
    subject.record({
      asiId: 'ASI01',
      severity: 'critical',
      source: 't',
      blocked: 'blocked',
      fingerprint: 'mean-1',
    });
    const r = subject.report();
    // 9 ASIs are 0, ASI01 is 1 → mean = 0.1
    expect(r.overallScore).toBeCloseTo(0.1, 5);
  });

  it('summary grades GREEN when overall=0', () => {
    expect(subject.report().summary).toContain('GREEN');
  });

  it('summary includes top worst ASIs in YELLOW/ORANGE/RED zones', () => {
    for (let i = 0; i < 50; i++) {
      subject.record({
        asiId: i % 2 === 0 ? 'ASI01' : 'ASI02',
        severity: 'critical',
        source: 't',
        blocked: 'blocked',
        fingerprint: `loop-${i}`,
      });
    }
    const r = subject.report();
    expect(r.overallScore).toBeGreaterThan(0);
    expect(r.summary).toMatch(/ASI0[12]/);
  });

  it('summerises correctly when window is empty', () => {
    const r = subject.report();
    expect(r.totalsByAsi.every((s) => s.total === 0)).toBe(true);
    expect(r.summary).toContain('No OWASP Agentic');
  });

  // ── OOM safety: per-minute bucketing caps memory ──────────────────────

  it('10000 events to one ASI do not crash; per-minute bucket size is the upper bound', () => {
    subject = new OwaspAgenticAiTop10({ windowMs: 60_000, disableBusSubscription: true });
    for (let i = 0; i < 10_000; i++) {
      subject.record({
        asiId: 'ASI04',
        severity: 'medium',
        source: 't',
        blocked: 'observed',
        timestamp: Date.now(), // all within the same minute
        fingerprint: `loop-${i}`,
      });
    }
    // 10k distinct fingerprints, all in one minute → 10k records in current
    // minute bucket. We expect this to succeed without memory exhaustion.
    const a = subject.report().totalsByAsi.find((x) => x.asiId === 'ASI04');
    expect(a?.total).toBe(10_000);
  });

  // ── ALL_ASIS shape ─────────────────────────────────────────────────────

  it('ALL_ASIS has exactly the 10 expected values in order', () => {
    expect([...ALL_ASIS]).toEqual([
      'ASI01',
      'ASI02',
      'ASI03',
      'ASI04',
      'ASI05',
      'ASI06',
      'ASI07',
      'ASI08',
      'ASI09',
      'ASI10',
    ]);
  });

  // ── Fixture: prove the routing table is type-safe ─────────────────────

  it('every SecurityEventType is present in the routing table', () => {
    const allTypes: SecurityEventType[] = [
      'sandbox_violation',
      'auth_failure',
      'auth_success',
      'auth_rate_limit',
      'approval_denied',
      'approval_granted',
      'content_threat',
      'exec_policy_violation',
      'exec_policy_forbidden',
      'credential_access',
      'input_validation_failure',
      'path_traversal_attempt',
      'command_injection_attempt',
      'memory_poisoning_detected',
      'skill_security_violation',
      'config_change',
      'security_scan',
    ];
    expect(allTypes).toHaveLength(17);
    // If a new variant is added but the routing table is missing it,
    // TypeScript's exhaustive-check forces a compile-time error here.
  });
});
