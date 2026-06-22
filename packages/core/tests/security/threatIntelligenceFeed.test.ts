/**
 * ThreatIntelligenceFeed Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ThreatIntelligenceFeed,
  resetThreatIntelligenceFeed,
} from '../../src/security/threatIntelligenceFeed';
import type { ThreatSignature, ThreatFeedSource } from '../../src/security/threatIntelligenceFeed';

describe('ThreatIntelligenceFeed', () => {
  let feed: ThreatIntelligenceFeed;

  beforeEach(() => {
    resetThreatIntelligenceFeed();
    feed = new ThreatIntelligenceFeed();
  });

  afterEach(() => {
    resetThreatIntelligenceFeed();
  });

  describe('initialization', () => {
    it('starts with built-in emerging signatures', () => {
      const active = feed.getActiveSignatures();
      expect(active.length).toBeGreaterThanOrEqual(8);
    });

    it('all built-in signatures are active (not deprecated)', () => {
      const active = feed.getActiveSignatures();
      for (const sig of active) {
        expect(sig.deprecated).toBe(false);
      }
    });

    it('built-in signatures have required fields', () => {
      for (const sig of feed.getActiveSignatures()) {
        expect(sig.id).toBeTruthy();
        expect(sig.name).toBeTruthy();
        expect(sig.description).toBeTruthy();
        expect(sig.patterns.length).toBeGreaterThan(0);
        expect(sig.severity).toBeTruthy();
        expect(sig.tlp).toBeTruthy();
        expect(sig.category).toBeTruthy();
        expect(sig.confidence).toBeGreaterThan(0);
      }
    });
  });

  describe('addSignatures', () => {
    it('adds new signatures', () => {
      const before = feed.getActiveSignatures().length;
      feed.addSignatures([
        {
          id: 'TEST-001',
          name: 'Test signature',
          description: 'A test threat',
          severity: 'high',
          patterns: [/test_pattern/],
          tlp: 'GREEN',
          category: 'malware',
          source: 'test',
          confidence: 90,
        },
      ]);
      expect(feed.getActiveSignatures().length).toBe(before + 1);
    });

    it('deduplicates by ID', () => {
      const sig: Omit<ThreatSignature, 'addedAt' | 'deprecated'> = {
        id: 'TEST-001',
        name: 'Test signature',
        description: 'A test threat',
        severity: 'high',
        patterns: [/test_pattern/],
        tlp: 'GREEN',
        category: 'malware',
        source: 'test',
        confidence: 90,
      };
      feed.addSignatures([sig]);
      const after1 = feed.getActiveSignatures().length;
      feed.addSignatures([sig]);
      expect(feed.getActiveSignatures().length).toBe(after1);
    });
  });

  describe('deprecate / reactivate', () => {
    it('deprecates a signature', () => {
      const active = feed.getActiveSignatures();
      expect(active.length).toBeGreaterThan(0);
      const sigId = active[0].id;
      feed.deprecateSignature(sigId);
      expect(feed.hasSignature(sigId)).toBe(true);
      const after = feed.getActiveSignatures();
      expect(after.find((s) => s.id === sigId)).toBeUndefined();
    });

    it('reactivates a deprecated signature', () => {
      const active = feed.getActiveSignatures();
      const sigId = active[0].id;
      feed.deprecateSignature(sigId);
      feed.reactivateSignature(sigId);
      const after = feed.getActiveSignatures();
      expect(after.find((s) => s.id === sigId)).toBeDefined();
    });
  });

  describe('TLP filtering', () => {
    it('getSignaturesByTlp filters correctly', () => {
      // Built-in sigs are GREEN or AMBER
      const all = feed.getActiveSignatures();
      const green = feed.getSignaturesByTlp('GREEN');
      const amber = feed.getSignaturesByTlp('AMBER');
      // GREEN includes WHITE+GREEN sigs
      expect(green.length).toBeGreaterThan(0);
      // AMBER includes WHITE+GREEN+AMBER = all built-in sigs
      expect(amber.length).toBeGreaterThanOrEqual(green.length);
      expect(amber.length).toBeLessThanOrEqual(all.length);
    });
  });

  describe('source management', () => {
    it('registers and retrieves sources', () => {
      const src: ThreatFeedSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'manual',
        tlp: 'GREEN',
        refreshIntervalMs: 0,
        enabled: true,
      };
      feed.registerSource(src);
      const sources = feed.getSources();
      expect(sources.length).toBe(1);
      expect(sources[0].id).toBe('test-source');
    });

    it('throws on duplicate source', () => {
      const src: ThreatFeedSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'manual',
        tlp: 'GREEN',
        refreshIntervalMs: 0,
        enabled: true,
      };
      feed.registerSource(src);
      expect(() => feed.registerSource(src)).toThrow();
    });

    it('removes a source', () => {
      const src: ThreatFeedSource = {
        id: 'test-source',
        name: 'Test Source',
        type: 'manual',
        tlp: 'GREEN',
        refreshIntervalMs: 0,
        enabled: true,
      };
      feed.registerSource(src);
      feed.removeSource('test-source');
      expect(feed.getSources().length).toBe(0);
    });
  });

  describe('health', () => {
    it('returns health report with active/deprecated counts', () => {
      const health = feed.getHealth();
      expect(health.activeSignatures).toBeGreaterThan(0);
      expect(health.deprecatedSignatures).toBe(0);
      expect(health.bySeverity.critical).toBeGreaterThan(0);
      expect(health.byTlp.GREEN).toBeGreaterThan(0);
    });

    it('reflects deprecated signatures in health', () => {
      const sig = feed.getActiveSignatures()[0];
      feed.deprecateSignature(sig.id);
      const health = feed.getHealth();
      expect(health.deprecatedSignatures).toBe(1);
    });
  });

  describe('exportScannerSignatures', () => {
    it('exports signatures in SupplyChainScanner compatible format', () => {
      const exported = feed.exportScannerSignatures();
      expect(exported.length).toBeGreaterThan(0);
      for (const sig of exported) {
        expect(sig.id).toBeTruthy();
        expect(sig.patterns.length).toBeGreaterThan(0);
        expect(sig.severity).toMatch(/high|critical/);
      }
    });

    it('respects TLP filter', () => {
      const allExported = feed.exportScannerSignatures('AMBER');
      const greenOnly = feed.exportScannerSignatures('GREEN');
      expect(allExported.length).toBeGreaterThanOrEqual(greenOnly.length);
    });
  });

  describe('exportScanPatterns', () => {
    it('returns flat array of patterns with metadata', () => {
      const patterns = feed.exportScanPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p.id).toBeTruthy();
        expect(p.pattern).toBeInstanceOf(RegExp);
        expect(p.severity).toBeTruthy();
        expect(p.name).toBeTruthy();
      }
    });
  });

  describe('getSignaturesByCategory', () => {
    it('filters by category', () => {
      const injections = feed.getSignaturesByCategory('injection');
      expect(injections.length).toBeGreaterThan(0);
      for (const sig of injections) {
        expect(sig.category).toBe('injection');
      }
    });
  });

  describe('reset', () => {
    it('resets to initial state with built-in signatures', () => {
      feed.addSignatures([
        {
          id: 'CUSTOM-001',
          name: 'Custom',
          description: 'Custom threat',
          severity: 'critical',
          patterns: [/custom/],
          tlp: 'GREEN',
          category: 'malware',
          source: 'custom',
          confidence: 95,
        },
      ]);
      expect(feed.getActiveSignatures().length).toBeGreaterThan(8);

      feed.reset();
      // After reset, only built-in sigs
      expect(feed.hasSignature('CUSTOM-001')).toBe(false);
      expect(feed.getActiveSignatures().length).toBeGreaterThanOrEqual(8);
    });

    it('clears sources on reset', () => {
      feed.registerSource({
        id: 'test',
        name: 'Test',
        type: 'manual',
        tlp: 'GREEN',
        refreshIntervalMs: 0,
        enabled: true,
      });
      feed.reset();
      expect(feed.getSources().length).toBe(0);
    });
  });
});
