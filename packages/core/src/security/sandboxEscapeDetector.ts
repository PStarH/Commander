/**
 * Sandbox Escape Detection Engine
 *
 * Security (G6): Monitors sandbox executions for escape attempts and integrity
 * violations. While kernel-level monitoring (eBPF/Falco) provides the strongest
 * guarantee, this application-level engine provides meaningful detection by:
 *
 * 1. Pre-execution: Verifying sandbox configuration integrity
 * 2. Post-execution: Analyzing output for escape indicators
 * 3. Continuous: Monitoring sandbox state between executions
 * 4. Behavioral: Detecting patterns indicative of escape attempts
 *
 * Detection indicators:
 * - Access to host paths (/proc/1/root, /etc/shadow, /var/run/docker.sock)
 * - Container breakout commands (mount, nsenter, unshare, setns)
 * - Privilege escalation attempts (sudo, su, chmod 777, capsh)
 * - Kernel exploit patterns (insmod, /dev/mem, /dev/kmem)
 * - Docker socket access (/var/run/docker.sock)
 * - cgroup escape attempts (/sys/fs/cgroup)
 *
 * When escape is detected:
 * - The execution result is marked as violated
 * - A critical security alert is emitted
 * - The RASP engine is invoked for automated response
 */

import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from './securityAuditLogger';
import { processSecurityAlert } from './securityResponseEngine';
import type { SecurityAlert } from './securityResponseEngine';
import type { SandboxExecutionResult, SandboxProfile } from '../sandbox/types';

// ── Escape Indicators ────────────────────────────────────────────────────────

/** Patterns in command output that indicate a sandbox escape attempt. */
const ESCAPE_OUTPUT_PATTERNS: { pattern: RegExp; indicator: string; severity: 'high' | 'critical' }[] = [
  // Host filesystem access — reading files outside the sandbox
  { pattern: /root:[x*]:0:0:/, indicator: 'host_etc_shadow_access', severity: 'critical' },
  { pattern: /\/proc\/1\/root/, indicator: 'host_proc_access', severity: 'critical' },
  { pattern: /\/var\/run\/docker\.sock/, indicator: 'docker_socket_access', severity: 'critical' },
  { pattern: /\/dev\/mem|\/dev\/kmem/, indicator: 'kernel_memory_access', severity: 'critical' },
  { pattern: /\/sys\/fs\/cgroup/, indicator: 'cgroup_manipulation', severity: 'high' },

  // Container breakout commands in output
  { pattern: /nsenter\s+--target\s+1\b/, indicator: 'nsenter_pid1', severity: 'critical' },
  { pattern: /nsenter\s+--mount/, indicator: 'nsenter_mount', severity: 'critical' },
  { pattern: /unshare\s+--pid|unshare\s+--mount/, indicator: 'unshare_namespace', severity: 'high' },
  { pattern: /setns\s+\d+/, indicator: 'setns_call', severity: 'critical' },
  { pattern: /mount\s+--type\s+(proc|sysfs|tmpfs)/, indicator: 'mount_filesystem', severity: 'high' },

  // Privilege escalation
  { pattern: /sudo\s+(su|root|bash|sh)/, indicator: 'sudo_escalation', severity: 'high' },
  { pattern: /chmod\s+4[0-9]{3}\s+\/(bin|sbin|usr)/, indicator: 'setuid_binary', severity: 'high' },
  { pattern: /capsh\s+--cap=CAP_SYS_ADMIN/, indicator: 'capability_escalation', severity: 'critical' },

  // Kernel module loading
  { pattern: /insmod\s+|modprobe\s+/, indicator: 'kernel_module_load', severity: 'critical' },
  { pattern: /\/lib\/modules\/.*\.ko/, indicator: 'kernel_module_path', severity: 'high' },

  // Docker/container runtime escape
  { pattern: /docker\s+(run|exec|create)\s+.*--privileged/, indicator: 'privileged_container', severity: 'critical' },
  { pattern: /docker\s+.*-v\s+\/:/, indicator: 'host_mount_container', severity: 'critical' },

  // SSH key exfiltration
  { pattern: /\/\.ssh\/id_(rsa|ed25519|ecdsa)/, indicator: 'ssh_key_access', severity: 'high' },
];

/** Patterns in the command itself that indicate an escape attempt. */
const ESCAPE_COMMAND_PATTERNS: { pattern: RegExp; indicator: string; severity: 'high' | 'critical' }[] = [
  { pattern: /nsenter\s+--target\s+1\b/, indicator: 'nsenter_pid1', severity: 'critical' },
  { pattern: /nsenter\s+--mount=/, indicator: 'nsenter_mount_ns', severity: 'critical' },
  { pattern: /unshare\s+--pid|unshare\s+--mount=/, indicator: 'unshare_namespace', severity: 'high' },
  { pattern: /setns\b/, indicator: 'setns_call', severity: 'critical' },
  { pattern: /mount\s+--type\s+(proc|sysfs|tmpfs)/, indicator: 'mount_filesystem', severity: 'high' },
  { pattern: /insmod\s+|modprobe\s+/, indicator: 'kernel_module_load', severity: 'critical' },
  { pattern: /capsh\s+--cap=CAP_SYS_ADMIN/, indicator: 'capability_escalation', severity: 'critical' },
  { pattern: /dd\s+if=\/dev\/(mem|kmem|sd)/, indicator: 'raw_device_access', severity: 'critical' },
  { pattern: /docker\s+.*--privileged/, indicator: 'privileged_container', severity: 'critical' },
  { pattern: /docker\s+.*-v\s+\/:/, indicator: 'host_mount_container', severity: 'critical' },
  { pattern: /\bchmod\s+4[0-9]{3}\s+\/(bin|sbin|usr\/bin)/, indicator: 'setuid_binary', severity: 'high' },
  { pattern: /\/proc\/1\/root/, indicator: 'host_proc_access', severity: 'critical' },
  { pattern: /\/var\/run\/docker\.sock/, indicator: 'docker_socket_access', severity: 'critical' },
];

// ── Sandbox State Tracking ─────────────────────────────────────────────────

/** Track sandbox integrity state per workdir. */
interface SandboxState {
  /** Whether the sandbox profile has been verified. */
  verified: boolean;
  /** Number of executions in this sandbox. */
  executionCount: number;
  /** Number of violations detected. */
  violationCount: number;
  /** First execution timestamp. */
  firstExecution: number;
  /** Last execution timestamp. */
  lastExecution: number;
  /** Known sandbox mechanism. */
  mechanism?: string;
}

const sandboxStates: Map<string, SandboxState> = new Map();

// ── Detection API ──────────────────────────────────────────────────────────

export interface EscapeDetectionResult {
  /** Whether an escape attempt was detected. */
  detected: boolean;
  /** List of detected indicators. */
  indicators: { pattern: string; severity: 'high' | 'critical'; matched: string }[];
  /** Whether the execution should be blocked. */
  blocked: boolean;
  /** Recommendation for the caller. */
  recommendation?: string;
}

/**
 * Pre-execution check: Analyze a command for escape patterns before execution.
 *
 * @param command - The command to be executed in the sandbox.
 * @param profile - The sandbox profile that will be used.
 * @returns Detection result — if `blocked` is true, the command should NOT be executed.
 */
export function preCheckSandboxEscape(
  command: string,
  profile: SandboxProfile,
): EscapeDetectionResult {
  const indicators: EscapeDetectionResult['indicators'] = [];

  for (const { pattern, indicator, severity } of ESCAPE_COMMAND_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      indicators.push({
        pattern: indicator,
        severity,
        matched: match[0],
      });
    }
  }

  // Check if the profile has full-access mode (which is inherently less safe)
  if (profile.mode === 'full-access' && process.env.NODE_ENV === 'production') {
    indicators.push({
      pattern: 'full_access_mode',
      severity: 'high',
      matched: 'SandboxProfile.mode = "full-access" in production',
    });
  }

  const hasCritical = indicators.some((i) => i.severity === 'critical');
  const hasHigh = indicators.some((i) => i.severity === 'high');

  return {
    detected: indicators.length > 0,
    indicators,
    blocked: hasCritical, // Block on critical indicators; log on high
    recommendation: hasCritical
      ? 'Command blocked: critical sandbox escape indicator detected. Refuse execution.'
      : hasHigh
        ? 'Warning: high-severity escape indicator detected. Review command before proceeding.'
        : undefined,
  };
}

/**
 * Post-execution check: Analyze sandbox execution output for escape evidence.
 *
 * @param command - The command that was executed.
 * @param result - The execution result (stdout, stderr, exitCode).
 * @param workdir - The working directory used.
 * @param agentId - The agent that initiated the execution.
 * @returns Detection result — if `detected` is true, a security alert is emitted.
 */
export function postCheckSandboxEscape(
  command: string,
  result: SandboxExecutionResult,
  workdir: string,
  agentId?: string,
): EscapeDetectionResult {
  const indicators: EscapeDetectionResult['indicators'] = [];
  const fullOutput = `${result.stdout}\n${result.stderr}`;

  for (const { pattern, indicator, severity } of ESCAPE_OUTPUT_PATTERNS) {
    const match = fullOutput.match(pattern);
    if (match) {
      indicators.push({
        pattern: indicator,
        severity,
        matched: match[0],
      });
    }
  }

  // Check for sandbox mechanism downgrade (result says 'none')
  if (result.sandboxMechanism === 'none') {
    indicators.push({
      pattern: 'no_sandbox_mechanism',
      severity: 'critical',
      matched: 'SandboxExecutionResult.sandboxMechanism = "none"',
    });
  }

  // Check for violated field in result
  if (result.violated && result.violated.length > 0) {
    for (const violation of result.violated) {
      indicators.push({
        pattern: `sandbox_violation: ${violation}`,
        severity: 'high',
        matched: violation,
      });
    }
  }

  // Update sandbox state
  updateSandboxState(workdir, result.sandboxMechanism, indicators.length > 0);

  // If detected, emit security alert
  if (indicators.length > 0) {
    const hasCritical = indicators.some((i) => i.severity === 'critical');
    const alert: SecurityAlert = {
      type: 'sandbox_escape_attempt',
      severity: hasCritical ? 'critical' : 'high',
      agentId: agentId ?? 'unknown',
      message: `Sandbox escape attempt detected: ${indicators.map((i) => i.pattern).join(', ')}`,
      details: {
        command: command.slice(0, 200),
        workdir,
        indicators,
        sandboxMechanism: result.sandboxMechanism,
        exitCode: result.exitCode,
      },
      timestamp: new Date(),
    };

    // Log the alert
    logEscapeAlert(alert, command, result);

    // Trigger RASP response (auto-suspend/terminate for critical)
    processSecurityAlert(alert);

    return {
      detected: true,
      indicators,
      blocked: hasCritical,
      recommendation: hasCritical
        ? 'CRITICAL: Sandbox escape detected. Agent session should be terminated and investigated.'
        : 'HIGH: Sandbox escape indicator detected. Review execution output and consider suspending agent.',
    };
  }

  return { detected: false, indicators: [], blocked: false };
}

/**
 * Verify sandbox integrity — check that the sandbox is still enforcing boundaries.
 * This is a lightweight check that can be run periodically.
 *
 * @param workdir - The sandbox working directory.
 * @returns Whether the sandbox appears intact.
 */
export function verifySandboxIntegrity(workdir: string): boolean {
  const state = sandboxStates.get(workdir);
  if (!state) {
    return true; // No state = no evidence of tampering
  }

  // If there have been violations, integrity is questionable
  if (state.violationCount > 0) {
    getGlobalLogger().warn(
      'SandboxEscapeDetector',
      'Sandbox integrity questionable — violations detected',
      { workdir, violationCount: state.violationCount },
    );
    return false;
  }

  return true;
}

/**
 * Get sandbox state for a workdir.
 */
export function getSandboxState(workdir: string): SandboxState | undefined {
  return sandboxStates.get(workdir);
}

/**
 * Reset sandbox state (e.g., after creating a new sandbox instance).
 */
export function resetSandboxState(workdir: string): void {
  sandboxStates.delete(workdir);
}

// ── Internal ────────────────────────────────────────────────────────────────

function updateSandboxState(
  workdir: string,
  mechanism: string,
  hadViolation: boolean,
): void {
  const state = sandboxStates.get(workdir) ?? {
    verified: false,
    executionCount: 0,
    violationCount: 0,
    firstExecution: Date.now(),
    lastExecution: Date.now(),
  };

  state.executionCount++;
  state.lastExecution = Date.now();
  state.mechanism = mechanism;
  if (hadViolation) {
    state.violationCount++;
  }

  sandboxStates.set(workdir, state);
}

function logEscapeAlert(
  alert: SecurityAlert,
  command: string,
  result: SandboxExecutionResult,
): void {
  getGlobalLogger().error(
    'SandboxEscapeDetector',
    `Sandbox escape attempt: ${alert.message}`,
    undefined,
    {
      severity: alert.severity,
      command: command.slice(0, 200),
      exitCode: result.exitCode,
      sandboxMechanism: result.sandboxMechanism,
    },
  );

  try {
    getSecurityAuditLogger().logEvent({
      type: 'sandbox_violation',
      severity: alert.severity,
      source: 'SandboxEscapeDetector',
      message: alert.message,
      details: {
        command: command.slice(0, 200),
        indicators: alert.details?.indicators,
        sandboxMechanism: result.sandboxMechanism,
        exitCode: result.exitCode,
      },
    });
  } catch {
    // best-effort
  }
}
