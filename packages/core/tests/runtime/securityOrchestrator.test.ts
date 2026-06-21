/**
 * Tests for SecurityOrchestrator — unified runtime security coordination facade.
 *
 * Covers:
 * - onBeforeToolCall: AdaptiveHITL integration, max(ToolApproval, AdaptiveHITL)
 * - onAgentEvent: GuardianAgent.monitor() + CrossAgentCorrelator.ingest()
 * - sanitizeMemoryShare: DifferentialPrivacyLayer wrapper
 * - Configuration: enable/disable individual modules
 * - Singleton lifecycle
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecurityOrchestrator,
  getSecurityOrchestrator,
  resetSecurityOrchestrator,
} from '../../src/runtime/securityOrchestrator';

describe('SecurityOrchestrator', () => {
  let orch: SecurityOrchestrator;

  beforeEach(() => {
    orch = new SecurityOrchestrator({ enabled: true });
  });

  // ── onBeforeToolCall ────────────────────────────────────────────────

  describe('onBeforeToolCall', () => {
    it('should allow tool when all modules are nominal', async () => {
      const result = await orch.onBeforeToolCall(
        'web_search',
        {},
        'agent-1',
        'run-1',
        undefined,
        { approved: true, requestId: 'r1', approvedAt: new Date().toISOString() },
      );
      expect(result.allowed).toBe(true);
      expect(result.sources).toContain('ToolApproval');
    });

    it('should deny when ToolApproval already denied', async () => {
      const result = await orch.onBeforeToolCall(
        'shell_execute',
        {},
        'agent-1',
        'run-1',
        undefined,
        {
          approved: false,
          requestId: 'r1',
          approvedAt: new Date().toISOString(),
          reason: 'Manual approval required',
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.hitlStrategy).toBe('deny');
    });

    it('should call AdaptiveHITL with signal bundle', async () => {
      const result = await orch.onBeforeToolCall(
        'file_write',
        {},
        'agent-1',
        'run-1',
        {
          toolRisk: {
            argRiskLevel: 'high',
            trustTier: 'untrusted',
            isReadOnly: false,
            hasNetworkAccess: false,
            mutatesState: true,
            toolName: 'file_write',
          },
        },
        { approved: true, requestId: 'r1', approvedAt: new Date().toISOString() },
      );
      // AdaptiveHITL should have been consulted
      expect(result.sources).toContain('AdaptiveHITL');
      expect(typeof result.hitlStrategy).toBe('string');
      // Unverified tool with high arg risk should trigger at least 'confirm'
      expect(['confirm', 'pause_and_review', 'escalate', 'deny']).toContain(result.hitlStrategy);
    });

    it('should allow with auto strategy for low-risk tools', async () => {
      const result = await orch.onBeforeToolCall(
        'web_search',
        {},
        'agent-2',
        'run-2',
        {
          toolRisk: {
            argRiskLevel: 'low',
            trustTier: 'trusted',
            isReadOnly: true,
            hasNetworkAccess: true,
            mutatesState: false,
            toolName: 'web_search',
          },
        },
        { approved: true, requestId: 'r2', approvedAt: new Date().toISOString() },
      );
      expect(result.allowed).toBe(true);
    });

    it('should handle missing signal bundle gracefully', async () => {
      const result = await orch.onBeforeToolCall(
        'web_fetch',
        {},
        'agent-1',
        'run-1',
        undefined,
        { approved: true, requestId: 'r1', approvedAt: new Date().toISOString() },
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ── onAgentEvent ────────────────────────────────────────────────────

  describe('onAgentEvent', () => {
    it('should not throw when feeding events', () => {
      expect(() =>
        orch.onAgentEvent({
          id: 'evt-1',
          agentId: 'agent-1',
          type: 'tool_call',
          summary: 'Test tool call',
          metadata: {},
          timestamp: Date.now(),
          severity: 'low',
        }),
      ).not.toThrow();
    });

    it('should not throw for multiple event types', () => {
      const eventTypes = ['tool_call', 'tool_result', 'llm_call', 'agent_spawn'] as const;
      for (const type of eventTypes) {
        expect(() =>
          orch.onAgentEvent({
            id: `evt-${type}`,
            agentId: 'agent-1',
            type,
            summary: `Test ${type}`,
            metadata: {},
            timestamp: Date.now(),
            severity: 'low',
          }),
        ).not.toThrow();
      }
    });

    it('should handle batch ingestion', () => {
      const events = [
        { id: 'e1', agentId: 'a1', type: 'tool_call' as const, summary: 't1', metadata: {}, timestamp: Date.now(), severity: 'low' as const },
        { id: 'e2', agentId: 'a2', type: 'tool_result' as const, summary: 't2', metadata: {}, timestamp: Date.now(), severity: 'low' as const },
      ];
      expect(() => orch.ingestBatch(events)).not.toThrow();
    });
  });

  // ── sanitizeMemoryShare ────────────────────────────────────────────

  describe('sanitizeMemoryShare', () => {
    it('should return entries unchanged when DP is disabled', () => {
      const dpOff = new SecurityOrchestrator({ enableDifferentialPrivacy: false });
      const entries = [
        { importance: 0.8, accessCount: 42, decayScore: 0.3 },
        { importance: 0.5, accessCount: 17, decayScore: 0.8 },
        { importance: 0.9, accessCount: 100, decayScore: 0.1 },
        { importance: 0.2, accessCount: 5, decayScore: 0.9 },
        { importance: 0.6, accessCount: 30, decayScore: 0.5 },
      ];
      const result = dpOff.sanitizeMemoryShare(entries, 'agent-1');
      expect(result.answerable).toBe(true);
      if (result.answerable) {
        expect(result.result.length).toBe(5);
        // Content unchanged
        expect(result.result[0].importance).toBe(0.8);
      }
    });

    it('should apply DP sanitization when enabled', () => {
      const entries = [
        { importance: 0.5 },
        { importance: 0.5 },
        { importance: 0.5 },
        { importance: 0.5 },
        { importance: 0.5 },
      ];
      // With DP enabled (default), noise should be added
      // The result might differ from input due to Laplace noise
      const result = orch.sanitizeMemoryShare(entries, 'agent-dp-1');
      expect(result.answerable).toBe(true);
    });

    it('should handle empty entries', () => {
      const result = orch.sanitizeMemoryShare([], 'agent-1');
      expect(result.answerable).toBe(true);
    });
  });

  // ── Configuration ──────────────────────────────────────────────────

  describe('Configuration', () => {
    it('should enable all modules by default', () => {
      const config = orch.getConfig();
      expect(config.enableAdaptiveHITL).toBe(true);
      expect(config.enableGuardianAgent).toBe(true);
      expect(config.enableCrossAgentCorrelator).toBe(true);
      expect(config.enableDifferentialPrivacy).toBe(true);
    });

    it('should allow disabling individual modules', () => {
      const partial = new SecurityOrchestrator({
        enableAdaptiveHITL: false,
        enableGuardianAgent: false,
      });
      const config = partial.getConfig();
      expect(config.enableAdaptiveHITL).toBe(false);
      expect(config.enableGuardianAgent).toBe(false);
      expect(config.enableCrossAgentCorrelator).toBe(true); // default
    });

    it('should update config at runtime', () => {
      orch.updateConfig({ enableAdaptiveHITL: false });
      expect(orch.getConfig().enableAdaptiveHITL).toBe(false);
    });
  });

  // ── Singleton ──────────────────────────────────────────────────────

  describe('Singleton', () => {
    it('should create and retrieve singleton instance', () => {
      resetSecurityOrchestrator();
      const s1 = getSecurityOrchestrator();
      const s2 = getSecurityOrchestrator();
      expect(s1).toBe(s2);
    });

    it('should reset singleton state', () => {
      resetSecurityOrchestrator();
      const s = getSecurityOrchestrator();
      s.updateConfig({ enabled: false });
      resetSecurityOrchestrator();
      const sFresh = getSecurityOrchestrator();
      expect(sFresh.getConfig().enabled).toBe(true);
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────

  describe('reset', () => {
    it('should clear pending events', () => {
      orch.onAgentEvent({
        id: 'e1', agentId: 'a1', type: 'tool_call',
        summary: 't1', metadata: {}, timestamp: Date.now(), severity: 'low',
      });
      orch.reset();
      // Should not throw on subsequent operations
      expect(() =>
        orch.onAgentEvent({
          id: 'e2', agentId: 'a2', type: 'tool_call',
          summary: 't2', metadata: {}, timestamp: Date.now(), severity: 'low',
        }),
      ).not.toThrow();
    });
  });
});
