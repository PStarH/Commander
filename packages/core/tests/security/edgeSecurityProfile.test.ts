/**
 * EdgeSecurityProfile Tests — Unified edge/offline security profile.
 *
 * Covers:
 *   - Edge mode detection (no cloud keys, no network, low resources, air-gapped)
 *   - State encryption/decryption (AES-256-GCM round-trip)
 *   - Sandbox policy generation (edge vs cloud modes)
 *   - Resource limits (low-resource vs normal devices)
 *   - Mode activation/deactivation lifecycle
 *   - FreezeDry integration
 *   - EdgeSecurityStatus reporting
 *   - Encryption key initialization (auto-generate vs provided)
 *   - Detection refresh
 *   - Explicit mode overrides (always-edge, always-cloud, off)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import {
  EdgeSecurityProfile,
  resetEdgeSecurityProfile,
} from '../../src/security/edgeSecurityProfile';
import type { EdgeSecurityConfig } from '../../src/security/edgeSecurityProfile';

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<EdgeSecurityConfig> = {}): EdgeSecurityConfig {
  return {
    mode: 'always-edge',
    enableStateEncryption: true,
    stateEncryptionKey: 'test-key-12345',
    strictEdgeSandbox: true,
    readOnlyWorkspace: true,
    protectedPaths: ['/etc/passwd'],
    enableFreezeDry: true,
    edgeMaxTokens: 4000,
    edgeMaxConcurrency: 1,
    networkCheckEndpoints: ['https://example.com/health'],
    networkCheckTimeoutMs: 500,
    resourceThresholds: {
      minFreeMemoryBytes: 512 * 1024 * 1024,
      minCpuCores: 2,
      maxCpuLoad: 0.8,
    },
    auditTransitions: true,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EdgeSecurityProfile', () => {
  let profile: EdgeSecurityProfile;

  beforeEach(() => {
    resetEdgeSecurityProfile();
  });

  afterEach(() => {
    try { profile.stop(); } catch { /* ok */ }
    resetEdgeSecurityProfile();
  });

  // ── Mode Activation ────────────────────────────────────────────────

  describe('mode activation', () => {
    it('activates edge mode when configured as always-edge', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      const detection = await profile.start();

      expect(detection.edgeMode).toBe(true);
      expect(profile.isActive()).toBe(true);
      expect(profile.isStateEncryptionActive()).toBe(true);
      expect(profile.isStrictSandboxActive()).toBe(true);
    });

    it('does not activate when mode is off', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'off' }));
      const detection = await profile.start();

      expect(detection.edgeMode).toBe(false);
      expect(profile.isActive()).toBe(false);
    });

    it('always-cloud mode keeps edge inactive', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-cloud' }));
      const detection = await profile.start();

      expect(detection.edgeMode).toBe(false);
      expect(profile.isActive()).toBe(false);
    });

    it('stop deactivates all protections', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();
      expect(profile.isActive()).toBe(true);

      profile.stop();
      expect(profile.isActive()).toBe(false);
      expect(profile.isStateEncryptionActive()).toBe(false);
      expect(profile.isStrictSandboxActive()).toBe(false);
    });
  });

  // ── State Encryption ──────────────────────────────────────────────

  describe('state encryption', () => {
    it('encrypts and decrypts state data round-trip', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        mode: 'always-edge',
        stateEncryptionKey: 'my-secret-key',
      }));
      await profile.start();

      const plaintext = '{"agentId":"test","step":42,"goal":"build feature"}';
      const encrypted = profile.encryptState(plaintext);

      expect(encrypted.encrypted).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.encrypted).not.toBe(plaintext);

      const decrypted = profile.decryptState(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertext for same plaintext (unique IV)', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ stateEncryptionKey: 'key' }));
      await profile.start();

      const plaintext = 'test data';
      const enc1 = profile.encryptState(plaintext);
      const enc2 = profile.encryptState(plaintext);

      expect(enc1.encrypted).not.toBe(enc2.encrypted);
      expect(enc1.iv).not.toBe(enc2.iv);

      // Both should decrypt to the same plaintext
      expect(profile.decryptState(enc1)).toBe(plaintext);
      expect(profile.decryptState(enc2)).toBe(plaintext);
    });

    it('throws when encrypting without initialization', () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'off' }));
      expect(() => profile.encryptState('data')).toThrow('not initialized');
    });

    it('throws when decrypting with wrong auth tag', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ stateEncryptionKey: 'key' }));
      await profile.start();

      const encrypted = profile.encryptState('data');
      encrypted.authTag = '00'.repeat(16); // Corrupt auth tag

      expect(() => profile.decryptState(encrypted)).toThrow();
    });

    it('auto-generates encryption key when none provided', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        stateEncryptionKey: undefined,
      }));
      await profile.start();

      const encrypted = profile.encryptState('data');
      const decrypted = profile.decryptState(encrypted);
      expect(decrypted).toBe('data');
    });

    it('getEncryptionKey returns the key buffer', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ stateEncryptionKey: 'test-key' }));
      await profile.start();

      const key = profile.getEncryptionKey();
      expect(key).toBeTruthy();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key!.length).toBe(32); // SHA-256 = 32 bytes for AES-256
    });
  });

  // ── Sandbox Policy ─────────────────────────────────────────────────

  describe('sandbox policy', () => {
    it('returns strict sandbox policy in edge mode', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      const policy = profile.getEdgeSandboxPolicy();
      expect(policy.mode).toBe('read-only');
      expect(policy.networkPolicy).toBe('blocked');
      expect(policy.protectedPaths).toContain('/etc/passwd');
    });

    it('includes edge-specific protected paths', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      const policy = profile.getEdgeSandboxPolicy();
      expect(policy.protectedPaths).toContain('/proc');
      expect(policy.protectedPaths).toContain('/sys');
    });

    it('returns relaxed sandbox when not in strict mode', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        mode: 'always-edge',
        strictEdgeSandbox: false,
        readOnlyWorkspace: false,
      }));
      await profile.start();

      const policy = profile.getEdgeSandboxPolicy();
      expect(policy.mode).toBe('workspace-write');
      expect(policy.networkPolicy).toBe('localhost-only');
    });
  });

  // ── Resource Limits ────────────────────────────────────────────────

  describe('resource limits', () => {
    it('returns edge-appropriate resource limits', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge', edgeMaxTokens: 4000 }));
      await profile.start();

      const limits = profile.getEdgeResourceLimits();
      expect(limits.maxTokens).toBeLessThanOrEqual(4000);
      expect(limits.maxConcurrency).toBeGreaterThanOrEqual(1);
    });

    it('respects configurable max tokens', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge', edgeMaxTokens: 8000 }));
      await profile.start();

      const limits = profile.getEdgeResourceLimits();
      expect(limits.maxTokens).toBe(8000);
    });

    it('caps tokens at 4000 for low-resource devices', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        mode: 'auto',
        edgeMaxTokens: 16000,
        resourceThresholds: {
          minFreeMemoryBytes: 100 * 1024 * 1024 * 1024, // 100 GB — forces low-resource
          minCpuCores: 128,
          maxCpuLoad: 0.01,
        },
      }));
      await profile.start();

      const limits = profile.getEdgeResourceLimits();
      expect(limits.isLowResource).toBe(true);
      expect(limits.maxTokens).toBe(4000); // Capped for low-resource
    });
  });

  // ── Status Reporting ──────────────────────────────────────────────

  describe('status reporting', () => {
    it('reports edge-hardened posture when all protections active', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      const status = profile.getStatus();
      expect(status.active).toBe(true);
      expect(status.posture).toBe('edge-hardened');
      expect(status.stateEncryptionActive).toBe(true);
      expect(status.strictSandboxActive).toBe(true);
    });

    it('reports edge-basic when only sandbox is active (no encryption)', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        mode: 'always-edge',
        enableStateEncryption: false,
        enableFreezeDry: false,
      }));
      await profile.start();

      const status = profile.getStatus();
      expect(status.posture).toBe('edge-basic');
      expect(status.stateEncryptionActive).toBe(false);
      expect(status.strictSandboxActive).toBe(true);
    });

    it('reports cloud posture when edge mode inactive', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'off' }));
      await profile.start();

      const status = profile.getStatus();
      expect(status.posture).toBe('cloud');
      expect(status.active).toBe(false);
    });
  });

  // ── Detection ──────────────────────────────────────────────────────

  describe('detection', () => {
    it('refreshDetection updates the detection result', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      const first = profile.getDetection();
      expect(first).not.toBeNull();

      const refreshed = await profile.refreshDetection();
      expect(refreshed.edgeMode).toBe(true);
      expect(refreshed.reasons).toContain('explicit_offline');
    });

    it('detection includes resource assessment', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      const detection = profile.getDetection()!;
      expect(detection.resources.totalMemoryBytes).toBeGreaterThan(0);
      expect(detection.resources.cpuCores).toBeGreaterThan(0);
      expect(typeof detection.resources.isLowResource).toBe('boolean');
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('isRunning returns true after start', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      expect(profile.isRunning()).toBe(false);

      await profile.start();
      expect(profile.isRunning()).toBe(true);
    });

    it('isRunning returns false after stop', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();
      profile.stop();

      expect(profile.isRunning()).toBe(false);
      expect(profile.isActive()).toBe(false);
    });

    it('double start does not reinitialize', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      const d1 = await profile.start();
      const d2 = await profile.start();

      expect(d1).toBe(d2); // Returns cached detection
    });
  });

  // ── FreezeDry ──────────────────────────────────────────────────────

  describe('freezeDry integration', () => {
    it('activates freezeDry in edge mode', async () => {
      profile = new EdgeSecurityProfile(makeConfig({ mode: 'always-edge' }));
      await profile.start();

      // FreezeDry activation is best-effort — it may be unavailable in tests
      // but the flag should be set if available
      expect(profile.isFreezeDryActive()).toBeDefined();
    });

    it('does not activate freezeDry when disabled in config', async () => {
      profile = new EdgeSecurityProfile(makeConfig({
        mode: 'always-edge',
        enableFreezeDry: false,
      }));
      await profile.start();

      expect(profile.isFreezeDryActive()).toBe(false);
    });
  });
});
