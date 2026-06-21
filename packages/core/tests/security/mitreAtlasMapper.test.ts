/**
 * MitreAtlasMapper tests — ATLAS tactic/technique mapping and report generation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { MitreAtlasMapper, getMitreAtlasMapper } from '../../src/security/mitreAtlasMapper';
import type { SecurityEvent } from '../../src/security/securityAuditLogger';

describe('MitreAtlasMapper', () => {
  let mapper: MitreAtlasMapper;

  beforeAll(() => {
    mapper = new MitreAtlasMapper();
  });

  // ── Tactic/Technique Lookup ────────────────────────────────────────

  it('getTactics() returns 14 tactics', () => {
    const tactics = mapper.getTactics();
    expect(tactics.length).toBe(14);
    expect(tactics[0].id.startsWith('AML.TA')).toBe(true);
  });

  it('getTechniques() returns techniques', () => {
    const techniques = mapper.getTechniques();
    expect(techniques.length).toBeGreaterThan(35);
    expect(techniques[0].id.startsWith('AML.T')).toBe(true);
  });

  it('getTechniquesByTactic() filters correctly', () => {
    const exec = mapper.getTechniquesByTactic('AML.TA0005');
    expect(exec.length).toBeGreaterThan(0);
    exec.forEach((t) => expect(t.tacticId).toBe('AML.TA0005'));
  });

  it('getTechniqueById() finds by ID', () => {
    const t = mapper.getTechniqueById('AML.T0012');
    expect(t).toBeDefined();
    expect(t!.name).toBe('Direct Prompt Injection');
  });

  it('getTacticForTechnique() returns parent tactic', () => {
    const tactic = mapper.getTacticForTechnique('AML.T0016');
    expect(tactic).toBeDefined();
    expect(tactic!.id).toBe('AML.TA0005');
  });

  // ── Event Mapping ──────────────────────────────────────────────────

  it('mapSecurityEvent() maps prompt injection to AML.T0012', () => {
    const event: SecurityEvent = {
      id: 'evt-1',
      timestamp: new Date().toISOString(),
      type: 'content_threat',
      severity: 'high',
      source: 'ContentScanner',
      message: 'Prompt injection detected',
    };
    const mappings = mapper.mapSecurityEvent(event);
    const ids = mappings.map((m) => m.techniqueId);
    expect(ids).toContain('AML.T0012');
  });

  it('mapSecurityEvent() maps sandbox escape to AML.T0017', () => {
    const event: SecurityEvent = {
      id: 'evt-2',
      timestamp: new Date().toISOString(),
      type: 'sandbox_violation',
      severity: 'critical',
      source: 'DockerSB',
      message: 'Container escape attempt',
    };
    const mappings = mapper.mapSecurityEvent(event);
    expect(mappings.map((m) => m.techniqueId)).toContain('AML.T0017');
  });

  it('mapSecurityEvent() maps memory poisoning to AML.T0018', () => {
    const event: SecurityEvent = {
      id: 'evt-3',
      timestamp: new Date().toISOString(),
      type: 'memory_poisoning_detected',
      severity: 'high',
      source: 'MemoryPoisoningDetector',
      message: 'False memory injection detected',
    };
    const mappings = mapper.mapSecurityEvent(event);
    expect(mappings.map((m) => m.techniqueId)).toContain('AML.T0018');
  });

  it('mapSecurityEvent() maps path traversal to AML.T0016.002', () => {
    const event: SecurityEvent = {
      id: 'evt-4',
      timestamp: new Date().toISOString(),
      type: 'path_traversal_attempt',
      severity: 'critical',
      source: 'FileSystemTool',
      message: 'Path traversal detected',
    };
    const mappings = mapper.mapSecurityEvent(event);
    expect(mappings.map((m) => m.techniqueId)).toContain('AML.T0016.002');
  });

  it('mapSecurityEvent() returns empty for unmapped types', () => {
    const event: SecurityEvent = {
      id: 'evt-5',
      timestamp: new Date().toISOString(),
      type: 'security_scan',
      severity: 'low',
      source: 'Scanner',
      message: 'Scan completed',
    };
    const mappings = mapper.mapSecurityEvent(event);
    expect(mappings).toHaveLength(0);
  });

  it('mapAttackCategory() maps all categories', () => {
    const categories = ['prompt_injection', 'jailbreak', 'data_exfiltration', 'agent_jacking',
      'tool_abuse', 'memory_poisoning', 'denial_of_wallet', 'supply_chain'] as const;
    for (const cat of categories) {
      const mappings = mapper.mapAttackCategory(cat);
      expect(mappings.length).toBeGreaterThan(0);
    }
  });

  it('mapGuardianIntervention() maps data_exfiltration', () => {
    const mappings = mapper.mapGuardianIntervention('data_exfiltration');
    expect(mappings.map((m) => m.techniqueId)).toContain('AML.T0035');
  });

  it('mapCorrelationRule() maps coordinated_exfiltration', () => {
    const mappings = mapper.mapCorrelationRule('coordinated_exfiltration');
    const ids = mappings.map((m) => m.techniqueId);
    expect(ids).toContain('AML.T0035');
    expect(ids).toContain('AML.T0032');
  });

  // ── Heatmap ───────────────────────────────────────────────────────

  it('generateHeatmap() produces cells for all techniques', () => {
    const events: SecurityEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'content_threat', severity: 'high', source: 'CS', message: 'M1' },
      { id: 'e2', timestamp: new Date().toISOString(), type: 'sandbox_violation', severity: 'critical', source: 'SB', message: 'M2' },
      { id: 'e3', timestamp: new Date().toISOString(), type: 'memory_poisoning_detected', severity: 'high', source: 'MP', message: 'M3' },
    ];
    const heatmap = mapper.generateHeatmap(events);
    expect(heatmap.length).toBeGreaterThan(35);
    const withEvents = heatmap.filter((c) => c.eventCount > 0);
    expect(withEvents.length).toBeGreaterThan(0);
  });

  it('generateHeatmap() assigns correct severity colors', () => {
    const events: SecurityEvent[] = [
      { id: 'ec', timestamp: new Date().toISOString(), type: 'sandbox_violation', severity: 'critical', source: 'SB', message: 'M' },
    ];
    const heatmap = mapper.generateHeatmap(events);
    const sandboxCell = heatmap.find((c) => c.techniqueId === 'AML.T0017');
    expect(sandboxCell).toBeDefined();
    expect(sandboxCell!.maxSeverity).toBe('critical');
    expect(sandboxCell!.color).toBe('#d32f2f');
  });

  it('exportAtlasNavigatorJson() produces valid JSON', () => {
    const events: SecurityEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'content_threat', severity: 'high', source: 'CS', message: 'M' },
    ];
    const heatmap = mapper.generateHeatmap(events);
    const json = mapper.exportAtlasNavigatorJson(heatmap);
    const parsed = JSON.parse(json);
    expect(parsed.domain).toBe('mitre-atlas');
    expect(parsed.techniques).toBeDefined();
    expect(Array.isArray(parsed.techniques)).toBe(true);
  });

  // ── Report ────────────────────────────────────────────────────────

  it('generateReport() produces complete report', () => {
    const events: SecurityEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'content_threat', severity: 'high', source: 'CS', message: 'M1' },
      { id: 'e2', timestamp: new Date().toISOString(), type: 'command_injection_attempt', severity: 'critical', source: 'SB', message: 'M2' },
      { id: 'e3', timestamp: new Date().toISOString(), type: 'approval_granted', severity: 'low', source: 'App', message: 'M3' },
      { id: 'e4', timestamp: new Date().toISOString(), type: 'security_scan', severity: 'low', source: 'SC', message: 'M4' },
    ];
    const report = mapper.generateReport(events);

    expect(report.reportId.startsWith('ATLAS-')).toBe(true);
    expect(report.summary.totalEvents).toBe(4);
    expect(report.summary.mappedEvents).toBe(2); // content_threat + command_injection_attempt
    expect(report.summary.unmappedEvents).toBe(2); // approval_granted + security_scan
    expect(report.tacticBreakdown.length).toBe(14);
    expect(report.heatmap.length).toBeGreaterThan(35);
    expect(report.unmappedTypes).toContain('approval_granted');
    expect(report.unmappedTypes).toContain('security_scan');
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('generateReport() handles empty events', () => {
    const report = mapper.generateReport([]);
    expect(report.summary.totalEvents).toBe(0);
    expect(report.summary.mappedEvents).toBe(0);
  });

  // ── Mapping confidence ────────────────────────────────────────────

  it('mappings have confidence scores', () => {
    const event: SecurityEvent = {
      id: 'evt-1',
      timestamp: new Date().toISOString(),
      type: 'content_threat',
      severity: 'high',
      source: 'CS',
      message: 'Test',
    };
    const mappings = mapper.mapSecurityEvent(event);
    for (const m of mappings) {
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('mappings include tactic and technique names', () => {
    const event: SecurityEvent = {
      id: 'evt-1',
      timestamp: new Date().toISOString(),
      type: 'sandbox_violation',
      severity: 'critical',
      source: 'SB',
      message: 'Test',
    };
    const mappings = mapper.mapSecurityEvent(event);
    expect(mappings.length).toBeGreaterThan(0);
    for (const m of mappings) {
      expect(m.techniqueName.length).toBeGreaterThan(0);
      expect(m.tacticName.length).toBeGreaterThan(0);
    }
  });

  // ── Singleton ─────────────────────────────────────────────────────

  it('getMitreAtlasMapper() returns singleton', () => {
    const m1 = getMitreAtlasMapper();
    const m2 = getMitreAtlasMapper();
    expect(m1).toBe(m2);
  });
});
