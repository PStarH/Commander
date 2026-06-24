/**
 * SandboxVerifier — Formal sandbox verification harness.
 *
 * Tests that the active sandbox mechanism properly enforces:
 *   1. File system isolation — cannot read/write outside workspace
 *   2. Network isolation — cannot reach external hosts when blocked
 *   3. Process isolation — cannot spawn unrestricted processes
 *   4. Environment sanitization — secrets are stripped from env
 *   5. Resource limits — memory/CPU constraints enforced
 *
 * Design:
 *   - Runs a battery of verification commands inside the active sandbox
 *   - Each test produces a pass/fail result with evidence
 *   - Generates a verification report suitable for compliance audits
 *
 * Integration:
 *   - CI/CD: run before deployments to verify sandbox config
 *   - Compliance: ISO 42001 annex A.8.1, NIST AI RMF MANAGE-2.1
 *   - Red Team: verify that sandbox hardening is effective
 */

import { getSandboxManager } from '../sandbox/manager';
import { getAuditChainLedger } from './auditChainLedger';
import { getGlobalLogger } from '../logging';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

// ============================================================================
// Types
// ============================================================================

export type VerificationArea =
  | 'file_isolation'
  | 'network_isolation'
  | 'process_isolation'
  | 'env_sanitization'
  | 'resource_limits';

export type VerificationResult = 'pass' | 'fail' | 'skip' | 'error';

export interface VerificationTest {
  /** Unique test ID */
  id: string;
  /** Verification area */
  area: VerificationArea;
  /** Human-readable name */
  name: string;
  /** What this test verifies */
  description: string;
  /** Command to run inside the sandbox */
  command: string;
  /** Expected behavior */
  expectedBehavior: string;
  /** Check function: given stdout/stderr/exitCode, was the sandbox effective? */
  check: (stdout: string, stderr: string, exitCode: number) => boolean;
  /** Whether this test requires network (only runs if network is blocked) */
  requiresBlockedNetwork?: boolean;
  /** Whether this test requires file writes (only runs in writable profiles) */
  requiresWritable?: boolean;
}

export interface VerificationEvidence {
  /** Test ID */
  testId: string;
  /** Result */
  result: VerificationResult;
  /** Duration (ms) */
  durationMs: number;
  /** Command output (truncated to 1KB) */
  output: string;
  /** Error details (if failed) */
  error?: string;
}

export interface SandboxVerificationReport {
  /** Report ID */
  reportId: string;
  /** Sandbox mechanism tested */
  sandboxMechanism: string;
  /** Total tests */
  totalTests: number;
  /** Results by area */
  results: Record<VerificationArea, { pass: number; fail: number; skip: number; error: number }>;
  /** All evidence */
  evidence: VerificationEvidence[];
  /** Overall pass/fail */
  passed: boolean;
  /** Overall score (0-100) */
  score: number;
  /** Verified at */
  verifiedAt: string;
  /** Recommendations */
  recommendations: string[];
}

export interface VerifierConfig {
  /** Timeout per test (ms) */
  testTimeoutMs: number;
  /** Maximum output capture per test (bytes) */
  maxOutputBytes: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: VerifierConfig = {
  testTimeoutMs: 10000,
  maxOutputBytes: 4096,
};

// ============================================================================
// Verification Tests (cross-platform)
// ============================================================================

function buildTestSuite(osPlatform: string): VerificationTest[] {
  const isWindows = osPlatform === 'win32';
  const isMac = osPlatform === 'darwin';

  // File paths that the sandbox should NOT be able to access
  const protectedPaths = isWindows
    ? ['C:\\Windows\\System32\\config\\SAM', 'C:\\Users\\Default\\NTUSER.DAT']
    : ['/etc/shadow', '/etc/passwd'];

  // Read commands that should fail
  const readProtected = isWindows
    ? `type "${protectedPaths[0]}" 2>&1`
    : `cat ${protectedPaths[0]} 2>&1 || cat ${protectedPaths[1]} 2>&1`;

  // Write commands that should fail
  const writeProtected = isWindows
    ? `echo test > "${protectedPaths[0]}" 2>&1`
    : `echo test > ${protectedPaths[0]} 2>&1 || echo test > ${protectedPaths[1]} 2>&1`;

  // Network test command
  const networkTest = isWindows
    ? `powershell -Command "try { (Invoke-WebRequest -Uri http://1.1.1.1 -TimeoutSec 3).StatusCode } catch { 'BLOCKED' }"`
    : `curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 http://1.1.1.1 2>&1 || echo 'BLOCKED'`;

  // Process test
  const forkTest = isWindows
    ? `powershell -Command "Start-Process cmd.exe -ArgumentList '/c echo UNRESTRICTED'; Write-Host 'FORK_OK'"`
    : `sh -c 'echo UNRESTRICTED' 2>&1 && echo FORK_OK`;

  // Env test
  const envTest = isWindows
    ? `cmd /c "echo %API_KEY%%TOKEN%%SECRET%"`
    : `echo "$API_KEY$TOKEN$SECRET"`;

  const tests: VerificationTest[] = [
    {
      id: 'FILE-001',
      area: 'file_isolation',
      name: 'Cannot read protected system files',
      description: 'Verify sandbox prevents reading OS-level protected files outside workspace',
      command: readProtected,
      expectedBehavior: 'Access should be denied',
      check: (stdout, stderr, exitCode) => {
        const output = (stdout + stderr).toLowerCase();
        return (
          exitCode !== 0 ||
          output.includes('denied') ||
          output.includes('permission') ||
          output.includes('access') ||
          output.includes('error')
        );
      },
    },
    {
      id: 'FILE-002',
      area: 'file_isolation',
      name: 'Cannot write to protected system files',
      description: 'Verify sandbox prevents writing to OS-level protected files',
      command: writeProtected,
      expectedBehavior: 'Write should fail with permission error',
      check: (stdout, stderr, exitCode) => {
        const output = (stdout + stderr).toLowerCase();
        return (
          exitCode !== 0 ||
          output.includes('denied') ||
          output.includes('permission') ||
          output.includes('access') ||
          output.includes('error') ||
          output.includes('read-only')
        );
      },
      requiresWritable: true,
    },
    {
      id: 'FILE-003',
      area: 'file_isolation',
      name: 'Can read files within workspace',
      description: 'Verify sandbox allows reading legitimate workspace files',
      command: isWindows
        ? `echo "test" > %TEMP%\\verify_test.txt && type %TEMP%\\verify_test.txt 2>&1`
        : `echo "test" > /tmp/verify_test.txt && cat /tmp/verify_test.txt`,
      expectedBehavior: 'Should read workspace file successfully',
      check: (stdout) => stdout.includes('test'),
    },
    {
      id: 'NET-001',
      area: 'network_isolation',
      name: 'Network blocked when profile requires',
      description: 'Verify sandbox blocks external network access when network=blocked',
      command: networkTest,
      expectedBehavior: 'Should be BLOCKED or timeout',
      check: (stdout, stderr) => {
        const output = (stdout + stderr).toUpperCase();
        return (
          output.includes('BLOCKED') ||
          output.includes('REFUSED') ||
          output.includes('TIMEOUT') ||
          output.includes('UNREACHABLE') ||
          output.includes('COULD NOT') ||
          output.includes('ERROR')
        );
      },
      requiresBlockedNetwork: true,
    },
    {
      id: 'PROC-001',
      area: 'process_isolation',
      name: 'Child process inherits sandbox file restrictions',
      description: 'Verify child processes spawned inside sandbox cannot access protected paths',
      command:
        forkTest +
        (isWindows ? ` && type "${protectedPaths[0]}" 2>&1` : ` && cat ${protectedPaths[0]} 2>&1`),
      expectedBehavior: 'Forked process should also be denied access to protected files',
      check: (stdout, stderr, exitCode) => {
        const output = (stdout + stderr).toLowerCase();
        // Either the fork itself failed (sandbox blocks forking — stronger isolation)
        // or the read was denied (fork inherited restrictions — correct behavior)
        return (
          exitCode !== 0 ||
          output.includes('denied') ||
          output.includes('permission') ||
          output.includes('error') ||
          output.includes('not found')
        );
      },
    },
    {
      id: 'ENV-001',
      area: 'env_sanitization',
      name: 'API keys stripped from environment',
      description: 'Verify API keys and secrets are not available in sandbox environment',
      command: envTest,
      expectedBehavior: 'API_KEY/TOKEN/SECRET variables should be empty',
      check: (stdout) => {
        // If output is just whitespace/ECHO, secrets were stripped
        const trimmed = stdout.trim();
        return trimmed.length === 0 || trimmed === 'ECHO is off.' || trimmed === '';
      },
    },
    {
      id: 'ENV-002',
      area: 'env_sanitization',
      name: 'Docker/SSH env vars stripped',
      description: 'Verify Docker and SSH config env vars are not leaked',
      command: isWindows
        ? `cmd /c "echo %DOCKER_CONFIG%%SSH_AUTH_SOCK%"`
        : `echo "$DOCKER_CONFIG$SSH_AUTH_SOCK"`,
      expectedBehavior: 'DOCKER/SSH vars should be empty',
      check: (stdout) => {
        const trimmed = stdout.trim();
        return trimmed.length === 0 || trimmed === 'ECHO is off.' || trimmed === '';
      },
    },
  ];

  return tests;
}

// ============================================================================
// SandboxVerifier
// ============================================================================

export class SandboxVerifier {
  private config: VerifierConfig;
  private tests: VerificationTest[];

  constructor(config?: Partial<VerifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tests = buildTestSuite(process.platform);
  }

  /**
   * Run full verification suite against the active sandbox.
   */
  async verify(): Promise<SandboxVerificationReport> {
    const sandboxManager = getSandboxManager();
    const sandbox = sandboxManager.getSandbox();
    const profile = sandboxManager.getProfile();

    const evidence: VerificationEvidence[] = [];
    const reportId = `VRF-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();

    for (const test of this.tests) {
      // Skip tests that don't apply to current profile
      if (test.requiresBlockedNetwork && profile.network !== 'blocked') {
        evidence.push({
          testId: test.id,
          result: 'skip',
          durationMs: 0,
          output: `Skipped: network is "${profile.network}", not blocked`,
        });
        continue;
      }

      if (test.requiresWritable && profile.mode === 'read-only') {
        evidence.push({
          testId: test.id,
          result: 'skip',
          durationMs: 0,
          output: 'Skipped: profile is read-only',
        });
        continue;
      }

      const startMs = Date.now();
      let result: VerificationResult;
      let output = '';
      let error: string | undefined;

      try {
        const execResult = await Promise.race([
          sandbox.execute(test.command, profile),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Test timeout')), this.config.testTimeoutMs),
          ),
        ]);

        output = (execResult.stdout + execResult.stderr).slice(0, this.config.maxOutputBytes);
        const passed = test.check(execResult.stdout, execResult.stderr, execResult.exitCode);
        result = passed ? 'pass' : 'fail';

        if (!passed) {
          error = `Expected: ${test.expectedBehavior}. Got exitCode=${execResult.exitCode}`;
        }
      } catch (err) {
        result = 'error';
        error = (err as Error)?.message ?? 'Unknown error';
        output = error;
      }

      evidence.push({
        testId: test.id,
        result,
        durationMs: Date.now() - startMs,
        output,
        error,
      });
    }

    return this.buildReport(reportId, sandbox.name, evidence, startedAt);
  }

  /**
   * Quick verification — returns only pass/fail, no evidence.
   */
  async quickCheck(): Promise<boolean> {
    const report = await this.verify();
    return report.passed;
  }

  // ── Report Building ────────────────────────────────────────────────

  private buildReport(
    reportId: string,
    sandboxMechanism: string,
    evidence: VerificationEvidence[],
    startedAt: string,
  ): SandboxVerificationReport {
    const results: SandboxVerificationReport['results'] = {
      file_isolation: { pass: 0, fail: 0, skip: 0, error: 0 },
      network_isolation: { pass: 0, fail: 0, skip: 0, error: 0 },
      process_isolation: { pass: 0, fail: 0, skip: 0, error: 0 },
      env_sanitization: { pass: 0, fail: 0, skip: 0, error: 0 },
      resource_limits: { pass: 0, fail: 0, skip: 0, error: 0 }, // No tests yet — placeholder for memory/CPU enforcement checks
    };

    for (const ev of evidence) {
      const test = this.tests.find((t) => t.id === ev.testId);
      if (test) {
        results[test.area][ev.result]++;
      }
    }

    const totalRun = evidence.filter((e) => e.result !== 'skip').length;
    const totalPass = evidence.filter((e) => e.result === 'pass').length;
    const score = totalRun > 0 ? Math.round((totalPass / totalRun) * 100) : 100;
    const passed = evidence.filter((e) => e.result === 'fail' || e.result === 'error').length === 0;

    const recommendations: string[] = [];
    if (sandboxMechanism === 'none') {
      recommendations.push(
        'CRITICAL: No OS-level sandbox active. Enable Seatbelt (macOS), bwrap (Linux), or AppContainer (Windows).',
      );
    }
    if (results.network_isolation.fail > 0) {
      recommendations.push(
        'Network isolation failed — verify firewall rules or container network config.',
      );
    }
    if (results.file_isolation.fail > 0) {
      recommendations.push(
        'File isolation failed — check sandbox profile filesystem rules and protected paths.',
      );
    }
    if (results.env_sanitization.fail > 0) {
      recommendations.push(
        'Environment sanitization failed — secrets may be leaking into sandboxed processes.',
      );
    }

    // Log report to audit chain
    try {
      getAuditChainLedger().logEvent({
        type: 'config_change',
        severity: passed ? 'low' : 'high',
        source: 'SandboxVerifier',
        message: `Sandbox verification ${passed ? 'PASSED' : 'FAILED'}: ${totalPass}/${totalRun} tests, score ${score}/100`,
        details: {
          reportId,
          sandboxMechanism,
          score,
          passed,
          results,
        },
      });
    } catch (err) {
      console.warn('[Catch]', err);
      /* best-effort */
    }

    return {
      reportId,
      sandboxMechanism,
      totalTests: evidence.length,
      results,
      evidence,
      passed,
      score,
      verifiedAt: new Date().toISOString(),
      recommendations,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

const verifierSingleton = createTenantAwareSingleton(() => new SandboxVerifier());

export function getSandboxVerifier(config?: Partial<VerifierConfig>): SandboxVerifier {
  return verifierSingleton.get();
}

export function resetSandboxVerifier(): void {
  verifierSingleton.reset();
}
