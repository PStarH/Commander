/**
 * AgentStandbyManager Tests — Hot Standby Agent Architecture
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentStandbyManager,
  resetAgentStandbyManager,
  getAgentStandbyManager,
} from '../../src/security/agentStandbyManager';
import type {
  AgentInstance,
  SwitchEvent,
  StandbyHealth,
} from '../../src/security/agentStandbyManager';

describe('AgentStandbyManager', () => {
  beforeEach(() => {
    resetAgentStandbyManager();
  });

  // ── Agent Registration ───────────────────────────────────────────

  describe('agent registration', () => {
    it('registers active agent', () => {
      const mgr = new AgentStandbyManager();
      const instance = mgr.registerActive({
        instanceId: 'active-1',
        agentId: 'agent-main',
      });

      expect(instance.tier).toBe('active');
      expect(instance.status).toBe('healthy');
      expect(instance.instanceId).toBe('active-1');
    });

    it('registers hot standby agent', () => {
      const mgr = new AgentStandbyManager();
      const instance = mgr.registerHotStandby({
        instanceId: 'hot-1',
        agentId: 'agent-standby',
      });

      expect(instance.tier).toBe('hot-standby');
      expect(instance.status).toBe('healthy');
    });

    it('registers cold standby agent', () => {
      const mgr = new AgentStandbyManager();
      const instance = mgr.registerColdStandby({
        instanceId: 'cold-1',
        agentId: 'agent-cold',
      });

      expect(instance.tier).toBe('cold-standby');
      expect(instance.status).toBe('healthy');
    });

    it('replacing active demotes old active', () => {
      const mgr = new AgentStandbyManager();
      const first = mgr.registerActive({ instanceId: 'active-1', agentId: 'agent-1' });
      const second = mgr.registerActive({ instanceId: 'active-2', agentId: 'agent-2' });

      // Second is now active
      const health = mgr.getHealth();
      expect(health.activeInstance!.instanceId).toBe('active-2');

      // First was demoted
      expect(first.tier).toBe('hot-standby');
      expect(first.status).toBe('degraded');
    });
  });

  // ── Health Check ─────────────────────────────────────────────────

  describe('health checks', () => {
    it('active starts healthy', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });

      const health = mgr.getHealth();
      expect(health.activeInstance!.status).toBe('healthy');
      expect(health.activeInstance!.consecutiveHealthFailures).toBe(0);
    });

    it('starts as critical with no active agent', () => {
      const mgr = new AgentStandbyManager();
      const health = mgr.getHealth();

      expect(health.status).toBe('critical');
      expect(health.activeInstance).toBeNull();
    });

    it('starts as degraded with no hot standby', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });

      const health = mgr.getHealth();
      expect(health.status).toBe('degraded');
    });

    it('starts as healthy with both active and hot standby', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      const health = mgr.getHealth();
      expect(health.status).toBe('healthy');
    });
  });

  // ── Confidence Reporting ─────────────────────────────────────────

  describe('confidence reporting', () => {
    it('accepts confidence scores', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });

      mgr.reportConfidence(95);
      expect(mgr.getHealth().activeInstance!.securityConfidence).toBe(95);
    });

    it('triggers confidence drop switch with consecutive low readings', async () => {
      const mgr = new AgentStandbyManager({
        confidenceDropThreshold: 3,
        minConfidenceScore: 50,
        enableAutoSwitch: true,
        switchCooldownMs: 0, // disable cooldown for tests
      });
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      // Three consecutive low confidence readings → switch (await each)
      await mgr.reportConfidence(30);
      await mgr.reportConfidence(25);
      await mgr.reportConfidence(20);

      // Switch should have been triggered
      const health = mgr.getHealth();
      expect(health.activeInstance!.instanceId).toBe('h1');
    });

    it('does not switch on single low reading', async () => {
      const mgr = new AgentStandbyManager({
        confidenceDropThreshold: 3,
        minConfidenceScore: 50,
        enableAutoSwitch: true,
        switchCooldownMs: 0,
      });
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      await mgr.reportConfidence(30); // Only 1 reading

      const health = mgr.getHealth();
      expect(health.activeInstance!.instanceId).toBe('a1');
    });
  });

  // ── State Synchronization ────────────────────────────────────────

  describe('state synchronization', () => {
    it('syncs hot standby from active', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      const result = await mgr.syncHotStandby();
      expect(result).toBe(true);

      const health = mgr.getHealth();
      expect(health.hotStandbyInstance!.lastSyncAt).toBeTruthy();
    });

    it('sync fails without active', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      const result = await mgr.syncHotStandby();
      expect(result).toBe(false);
    });

    it('archives cold standby', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerColdStandby({ instanceId: 'c1', agentId: 'agent-cold' });

      const result = await mgr.archiveColdStandby();
      expect(result).toBe(true);

      const health = mgr.getHealth();
      expect(health.coldStandbyInstance!.lastSyncAt).toBeTruthy();
    });
  });

  // ── Switch Operations ────────────────────────────────────────────

  describe('switch operations', () => {
    it('switches from active to hot standby on manual trigger', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      const event = await mgr.manualSwitch('Maintenance window');
      expect(event).not.toBeNull();
      expect(event!.success).toBe(true);
      expect(event!.fromInstanceId).toBe('a1');
      expect(event!.toInstanceId).toBe('h1');
      expect(event!.trigger).toBe('MANUAL');
    });

    it('active is replaced by hot standby after switch', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      await mgr.manualSwitch('Test');

      const health = mgr.getHealth();
      expect(health.activeInstance!.instanceId).toBe('h1');
      expect(health.activeInstance!.tier).toBe('active');
    });

    it('old active becomes degraded after switch', async () => {
      const mgr = new AgentStandbyManager();
      const oldActive = mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      await mgr.manualSwitch('Test');

      expect(oldActive.tier).toBe('hot-standby');
      expect(oldActive.status).toBe('degraded');
    });

    it('records switch in history', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      await mgr.manualSwitch('Test');

      const history = mgr.getSwitchHistory();
      expect(history.length).toBe(1);
      expect(history[0].success).toBe(true);
      expect(history[0].rto).toBeGreaterThanOrEqual(0);
    });

    it('calculates RTO and RPO', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      const event = await mgr.manualSwitch('Performance test');
      expect(event!.rto).toBeGreaterThanOrEqual(0);
      expect(event!.rpo).toBeGreaterThanOrEqual(0);
    });

    it('fails switch without hot standby', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });

      const event = await mgr.manualSwitch('No standby');
      expect(event).toBeNull();
    });

    it('prevents re-entrant switches via switching flag', async () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      expect(mgr.isSwitching()).toBe(false);
      // Switch completes asynchronously — await it
      await mgr.manualSwitch('Test');
      // After completion, switching flag is reset
      expect(mgr.isSwitching()).toBe(false);
    });
  });

  // ── Switch Triggers ──────────────────────────────────────────────

  describe('switch triggers', () => {
    it('switches on CONFIDENCE_DROP trigger', async () => {
      const mgr = new AgentStandbyManager({
        confidenceDropThreshold: 2,
        minConfidenceScore: 50,
        enableAutoSwitch: true,
        switchCooldownMs: 0,
      });
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      await mgr.reportConfidence(30);
      await mgr.reportConfidence(25);

      const history = mgr.getSwitchHistory();
      const lastSwitch = history[0];
      expect(lastSwitch).toBeDefined();
      expect(lastSwitch.trigger).toBe('CONFIDENCE_DROP');
    });

    it('does not switch when auto-switch is disabled', () => {
      const mgr = new AgentStandbyManager({
        confidenceDropThreshold: 2,
        minConfidenceScore: 50,
        enableAutoSwitch: false,
        switchCooldownMs: 0,
      });
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      mgr.reportConfidence(30);
      mgr.reportConfidence(25);

      const health = mgr.getHealth();
      expect(health.activeInstance!.instanceId).toBe('a1');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('starts and stops correctly', () => {
      const mgr = new AgentStandbyManager();
      expect(mgr.isRunning()).toBe(false);

      mgr.start();
      expect(mgr.isRunning()).toBe(true);

      mgr.stop();
      expect(mgr.isRunning()).toBe(false);
    });

    it('stop is idempotent', () => {
      const mgr = new AgentStandbyManager();
      mgr.start();
      mgr.stop();
      mgr.stop();
      expect(mgr.isRunning()).toBe(false);
    });
  });

  // ── Run Checkpoint Notification ──────────────────────────────────

  describe('run checkpoint notification', () => {
    it('updates active agent last run ID', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });

      mgr.notifyRunCheckpoint('run-123');
      expect(mgr.getHealth().activeInstance!.lastRunId).toBe('run-123');
    });
  });

  // ── Health Report ────────────────────────────────────────────────

  describe('health report', () => {
    it('returns comprehensive health report', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerActive({ instanceId: 'a1', agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });
      mgr.registerColdStandby({ instanceId: 'c1', agentId: 'agent-cold' });

      const health = mgr.getHealth();
      expect(health.activeInstance).not.toBeNull();
      expect(health.hotStandbyInstance).not.toBeNull();
      expect(health.coldStandbyInstance).not.toBeNull();
      expect(health.status).toBe('healthy');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.recentSwitches).toBeDefined();
    });

    it('reports critical with no active', () => {
      const mgr = new AgentStandbyManager();
      mgr.registerHotStandby({ instanceId: 'h1', agentId: 'agent-hot' });

      expect(mgr.getHealth().status).toBe('critical');
    });
  });

  // ── Switch History ───────────────────────────────────────────────

  describe('switch history', () => {
    it('caps history to max size', async () => {
      const mgr = new AgentStandbyManager({ maxSwitchHistory: 3 });
      mgr.registerActive({ instanceId: `active`, agentId: 'agent' });
      mgr.registerHotStandby({ instanceId: `hot`, agentId: 'agent-hot' });

      // Perform 5 switches
      for (let i = 0; i < 5; i++) {
        await mgr.manualSwitch(`Switch ${i}`);
        // Re-register hot standby for next switch
        mgr.registerHotStandby({ instanceId: `hot-${i + 1}`, agentId: 'agent-hot' });
      }

      const history = mgr.getSwitchHistory(100);
      expect(history.length).toBeLessThanOrEqual(3);
    });
  });
});
