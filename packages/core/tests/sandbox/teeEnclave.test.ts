/**
 * TEESandbox tests — Trusted Execution Environment sandbox verification.
 *
 * Tests cover:
 *   - Backend detection (AWS Nitro, GCP CVM, none)
 *   - Env filtering (secrets stripped)
 *   - execute() behavior on non-TEE machines (graceful fallback)
 *   - PlatformSandbox interface compliance
 *   - GCP CVM attestation measurement collection
 *   - Dockerfile/vsock proxy generation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TEESandbox } from '../../src/sandbox/teeEnclave';
import type { PlatformSandbox } from '../../src/sandbox/types';
import * as os from 'os';
import * as fs from 'fs';

describe('TEESandbox', () => {
  let sandbox: TEESandbox;

  beforeAll(() => {
    sandbox = new TEESandbox();
  });

  // ── PlatformSandbox interface ────────────────────────────────────

  it('implements PlatformSandbox interface', () => {
    const sb: PlatformSandbox = sandbox;
    expect(sb.name).toBe('tee');
    expect(typeof sb.available).toBe('boolean');
    expect(typeof sb.execute).toBe('function');
  });

  it('has a valid backend type', () => {
    const valid: string[] = ['aws_nitro', 'gcp_cvm', 'none'];
    expect(valid).toContain(sandbox.backend);
  });

  it('has a non-empty technology string', () => {
    expect(typeof sandbox.technology).toBe('string');
    expect(sandbox.technology.length).toBeGreaterThan(0);
  });

  // ── Backend detection ─────────────────────────────────────────────

  it('detects backend consistently with availability', () => {
    if (sandbox.backend === 'none') {
      expect(sandbox.available).toBe(false);
    } else {
      expect(sandbox.available).toBe(true);
    }
  });

  it('getBackend() matches the backend property', () => {
    expect(sandbox.getBackend()).toBe(sandbox.backend);
  });

  it('getTechnology() matches the technology property', () => {
    expect(sandbox.getTechnology()).toBe(sandbox.technology);
  });

  // ── Execution ─────────────────────────────────────────────────────

  it('execute() returns result with sandboxMechanism tee', async () => {
    const result = await sandbox.execute('echo hello', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(result.sandboxMechanism).toBe('tee');
    expect(typeof result.durationMs).toBe('number');
    expect(typeof result.exitCode).toBe('number');
  });

  it('execute() on non-TEE machine returns clear error message', async () => {
    if (sandbox.backend !== 'none') return; // skip on real TEE

    const result = await sandbox.execute('echo test', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('No TEE environment available');
    expect(result.stdout).toBe('');
  });

  it('execute() with GCP CVM backend produces valid output for simple command', async () => {
    if (sandbox.backend !== 'gcp_cvm') return; // skip on non-GCP

    const result = await sandbox.execute('echo "TEE_TEST_OK"', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TEE_TEST_OK');
  });

  // ── Env filtering ─────────────────────────────────────────────────

  it('execute() filters secrets from environment', async () => {
    // Set a temporary secret
    process.env.TEST_TEE_SECRET = 'super-secret-value-12345';
    process.env.TEST_TEE_API_KEY = 'sk-abcdefghijklmnop';

    try {
      const result = await sandbox.execute(
        os.platform() === 'win32'
          ? 'echo %TEST_TEE_SECRET%_%TEST_TEE_API_KEY%_%PATH%'
          : 'echo $TEST_TEE_SECRET $TEST_TEE_API_KEY $PATH',
        {
          mode: 'read-only',
          network: 'blocked',
          filesystem: {
            readablePaths: ['/tmp'],
            writablePaths: [],
            protectedPaths: [],
            useStagingDir: false,
          },
          envVarDenyList: ['TEST_TEE_SECRET', 'TEST_TEE_API_KEY'],
        },
      );

      const stdout = result.stdout;
      // Secrets should NOT appear in output
      expect(stdout).not.toContain('super-secret-value-12345');
      expect(stdout).not.toContain('sk-abcdefghijklmnop');
    } finally {
      delete process.env.TEST_TEE_SECRET;
      delete process.env.TEST_TEE_API_KEY;
    }
  });

  // ── GCP attestation measurements ──────────────────────────────────

  it('collectGCPMeasurements returns array when CVM is active', () => {
    if (sandbox.backend !== 'gcp_cvm') return;

    // Access via reflection to test private method
    const measurements = (sandbox as any).collectGCPMeasurements();
    expect(Array.isArray(measurements)).toBe(true);
    expect(measurements.length).toBeGreaterThan(0);
  });

  it('verifyGCPAttestation returns boolean when CVM is active', () => {
    if (sandbox.backend !== 'gcp_cvm') return;

    const verified = (sandbox as any).verifyGCPAttestation();
    expect(typeof verified).toBe('boolean');
    expect(verified).toBe(true); // Should be true on actual CVM
  });

  // ── Enclave image builders (static content) ──────────────────────

  it('buildNitroDockerfile produces valid Dockerfile', () => {
    const dockerfile = (sandbox as any).buildNitroDockerfile({
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(dockerfile).toContain('FROM alpine:3.19');
    expect(dockerfile).toContain('socat');
    expect(dockerfile).toContain('COPY proxy.sh');
    expect(dockerfile).toContain('CMD ["/proxy.sh"]');
  });

  it('buildNitroDockerfile read-only mode adds hardening', () => {
    const dockerfile = (sandbox as any).buildNitroDockerfile({
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(dockerfile).toContain('chmod -R a-w');
  });

  it('buildNitroDockerfile workspace-write mode omits read-only hardening', () => {
    const dockerfile = (sandbox as any).buildNitroDockerfile({
      mode: 'workspace-write',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: ['/tmp'],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(dockerfile).not.toContain('chmod -R a-w');
  });

  it('buildNitroVsockProxy generates a valid bash script', () => {
    const script = (sandbox as any).buildNitroVsockProxy();

    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('PORT=5005');
    expect(script).toContain('socat');
    expect(script).toContain('VSOCK-LISTEN');
    expect(script).toContain('VSOCK-CONNECT:3:5006');
    expect(script).toMatch(/while true; do/);
  });

  // ── Concurrent execution safety ───────────────────────────────────

  it('concurrent execute() calls do not interfere', async () => {
    if (sandbox.backend === 'aws_nitro') return; // Nitro is single-enclave, skip

    const results = await Promise.all([
      sandbox.execute('echo ONE', {
        mode: 'read-only',
        network: 'blocked',
        filesystem: {
          readablePaths: ['/tmp'],
          writablePaths: [],
          protectedPaths: [],
          useStagingDir: false,
        },
      }),
      sandbox.execute('echo TWO', {
        mode: 'read-only',
        network: 'blocked',
        filesystem: {
          readablePaths: ['/tmp'],
          writablePaths: [],
          protectedPaths: [],
          useStagingDir: false,
        },
      }),
      sandbox.execute('echo THREE', {
        mode: 'read-only',
        network: 'blocked',
        filesystem: {
          readablePaths: ['/tmp'],
          writablePaths: [],
          protectedPaths: [],
          useStagingDir: false,
        },
      }),
    ]);

    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r.sandboxMechanism).toBe('tee');
    });
  });
});
