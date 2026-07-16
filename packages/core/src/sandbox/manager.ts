import type {
  PlatformSandbox,
  SandboxProfile,
  SandboxMechanism,
  SandboxExecutionResult,
  SandboxWorkloadContext,
} from './types';
import { discoverSandboxes, NoopSB } from './platforms';
import { PROFILES } from './profiles';
import { getGlobalLogger } from '../logging';
import * as sandboxEscapeDetector from '../security/sandboxEscapeDetector';
import {
  assertProductionSandboxReady,
  resolveSandboxPolicy,
  SandboxPolicyError,
} from './productionPolicy';
import { createSandboxWorkloadContext, validateSandboxWorkloadContext } from './workload';
import type { SandboxPolicy } from './productionPolicy';

export class SandboxInitializationError extends Error {
  constructor(
    message: string,
    readonly requested?: SandboxMechanism,
  ) {
    super(message);
    this.name = 'SandboxInitializationError';
  }
}

function allowNoSandboxFallback(): boolean {
  const v = process.env.COMMANDER_ALLOW_NO_SANDBOX?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * The pre-execution escape detector is a security control. If it cannot load or
 * throws, we FAIL CLOSED (refuse execution) rather than running an unchecked
 * command. This explicit opt-out restores the legacy fail-open behaviour for
 * local development only.
 */
function allowUncheckedExecution(): boolean {
  const v = process.env.COMMANDER_ALLOW_UNCHECKED_EXEC?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export interface SandboxManagerDeps {
  /** Override sandbox discovery for testing. */
  sandboxes?: PlatformSandbox[];
  /** Override the no-sandbox fallback policy. */
  allowNoSandbox?: boolean;
  /** Override process environment for production boot tests. */
  environment?: NodeJS.ProcessEnv;
}

export class SandboxManager {
  private sandboxes: PlatformSandbox[] = [];
  private allowNoSandbox: boolean;
  private readonly policy: SandboxPolicy;

  constructor(deps?: SandboxManagerDeps) {
    const policy = resolveSandboxPolicy(deps?.environment ?? process.env);
    this.policy = policy;
    if (policy.environment === 'production' && deps?.allowNoSandbox === true) {
      throw new SandboxInitializationError(
        'Explicit allowNoSandbox is forbidden in production; refusing to start.',
      );
    }
    this.allowNoSandbox = deps?.allowNoSandbox ?? allowNoSandboxFallback();
    try {
      this.sandboxes = deps?.sandboxes ?? discoverSandboxes();
    } catch (error) {
      if (error instanceof SandboxPolicyError || error instanceof SandboxInitializationError) {
        throw error;
      }
      throw new SandboxInitializationError(
        `Sandbox discovery failed for ${policy.environment}: ${(error as Error).message}`,
        policy.environment === 'production' && policy.isolation !== 'process'
          ? policy.isolation
          : undefined,
      );
    }
    if (policy.environment === 'production') {
      assertProductionSandboxReady({
        policy,
        availableMechanisms: this.sandboxes
          .filter((sandbox) => sandbox.available)
          .map((sandbox) => sandbox.name),
      });
      this.sandboxes = this.sandboxes.filter((sandbox) => sandbox.name === policy.isolation);
    }
    if (this.sandboxes.length === 0 && !this.allowNoSandbox) {
      throw new SandboxInitializationError(
        'No OS-level sandbox available. ' +
          'Install seatbelt (macOS), bubblewrap (Linux), Docker, or gVisor, ' +
          'or set COMMANDER_ALLOW_NO_SANDBOX=true to explicitly accept unsandboxed execution.',
      );
    }
    if (this.sandboxes.length === 0) {
      getGlobalLogger().warn(
        'SandboxManager',
        'COMMANDER_ALLOW_NO_SANDBOX is set — commands will run UNSANDBOXED',
      );
    }
  }

  getAvailableMechanisms(): SandboxMechanism[] {
    return this.sandboxes.map((s) => s.name);
  }

  hasSandbox(): boolean {
    return this.sandboxes.length > 0;
  }

  /**
   * Prove that the selected production sandbox can start a constrained workload.
   * A discovered binary or runtime is not sufficient: the boot probe must
   * complete successfully through the same execution path used by workloads.
   */
  async verifyReady(): Promise<void> {
    if (!this.policy.failClosed) return;

    const mechanism = this.policy.isolation === 'gvisor' ? 'gvisor' : 'docker';
    const context = createSandboxWorkloadContext({
      tenantId: 'system',
      runId: 'sandbox-boot',
      stepId: 'probe',
    });

    try {
      const result = await this.execute('true', 'hardened', process.cwd(), mechanism, context);
      if (result.exitCode !== 0) {
        throw new SandboxInitializationError(
          `Sandbox ${mechanism} probe failed with exit code ${result.exitCode}: ${result.stderr || 'no stderr'}`,
          mechanism,
        );
      }
      if (result.sandboxMechanism !== mechanism) {
        throw new SandboxInitializationError(
          `Sandbox probe used ${result.sandboxMechanism}, expected ${mechanism}; refusing to start.`,
          mechanism,
        );
      }
    } catch (error) {
      if (error instanceof SandboxInitializationError) throw error;
      throw new SandboxInitializationError(
        `Sandbox ${mechanism} probe could not start: ${(error as Error).message}`,
        mechanism,
      );
    }
  }

  getSandbox(mechanism?: SandboxMechanism): PlatformSandbox {
    if (mechanism) {
      const found = this.sandboxes.find((s) => s.name === mechanism);
      if (found) return found;
      throw new SandboxInitializationError(
        `Requested sandbox "${mechanism}" is not available on this system. ` +
          `Available: ${this.sandboxes.map((s) => s.name).join(', ') || 'none'}.`,
        mechanism,
      );
    }
    if (this.sandboxes.length === 0) {
      if (this.allowNoSandbox) {
        getGlobalLogger().warn(
          'SandboxManager',
          'COMMANDER_ALLOW_NO_SANDBOX is set — returning NoopSB fallback',
        );
        return new NoopSB();
      }
      throw new SandboxInitializationError(
        'No OS-level sandbox available. ' +
          'Install seatbelt (macOS), bubblewrap (Linux), Docker, or gVisor, ' +
          'or set COMMANDER_ALLOW_NO_SANDBOX=true to explicitly accept unsandboxed execution.',
      );
    }
    return this.sandboxes[0];
  }

  getProfile(name?: string): SandboxProfile {
    if (name && name in PROFILES) return PROFILES[name];
    // SECURITY FIX: env var can only select non-full-access profiles (prevents downgrade attack)
    // To use full-access, must be explicitly requested via the `name` parameter
    const envMode = process.env.COMMANDER_SANDBOX_MODE;
    if (envMode && envMode in PROFILES && envMode !== 'full-access') {
      return PROFILES[envMode];
    }
    return PROFILES['workspace-write'];
  }

  async execute(
    command: string,
    profile?: SandboxProfile | string,
    workdir?: string,
    mechanism?: SandboxMechanism,
    context?: SandboxWorkloadContext,
  ): Promise<SandboxExecutionResult> {
    const p =
      typeof profile === 'string' ? this.getProfile(profile) : (profile ?? this.getProfile());

    if (this.policy.environment === 'production') {
      if (p.mode === 'full-access') {
        throw new SandboxPolicyError(
          'full-access sandbox profiles are forbidden in production; refusing to execute.',
        );
      }
      if (!context) {
        throw new SandboxInitializationError(
          'Production sandbox execution requires a tenant/run/step workload context.',
        );
      }
      validateSandboxWorkloadContext(context);
    }

    // Security (G6, SBX-7): Pre-execution sandbox escape detection.
    // The detector is an enforcement control, so a load or evaluation failure
    // must FAIL CLOSED — we refuse the command instead of running it unchecked.
    // COMMANDER_ALLOW_UNCHECKED_EXEC restores the legacy fail-open path for dev.
    let preCheck: ReturnType<typeof sandboxEscapeDetector.preCheckSandboxEscape>;
    try {
      preCheck = sandboxEscapeDetector.preCheckSandboxEscape(command, p);
    } catch (err) {
      if (!allowUncheckedExecution()) {
        return this.blockedByDetector(`sandbox escape pre-check threw: ${(err as Error).message}`);
      }
      getGlobalLogger().warn(
        'SandboxManager',
        `escape pre-check threw and COMMANDER_ALLOW_UNCHECKED_EXEC is set — running UNCHECKED: ${(err as Error).message}`,
      );
      preCheck = undefined as never;
    }
    if (preCheck?.blocked) {
      return {
        stdout: '',
        stderr: `Command blocked by sandbox escape detector: ${preCheck.indicators
          .map((i) => i.pattern)
          .join(', ')}`,
        exitCode: 126,
        durationMs: 0,
        sandboxMechanism: 'none',
        violated: preCheck.indicators.map((i) => i.pattern),
      };
    }

    // Execute OUTSIDE the detector try/catch: a genuine execution error must
    // propagate, never be swallowed into a silent unchecked re-execution.
    const sb = this.getSandbox(mechanism);
    const result = await sb.execute(command, p, workdir, context);

    // Security (G6): Post-execution escape detection is advisory (RASP); a
    // failure here must not mask or re-run the command.
    try {
      sandboxEscapeDetector.postCheckSandboxEscape(command, result, workdir ?? process.cwd());
    } catch (err) {
      getGlobalLogger().warn(
        'SandboxManager',
        `post-execution escape check failed: ${(err as Error).message}`,
      );
    }

    return result;
  }

  /** Fail-closed result returned when the escape detector cannot be evaluated. */
  private blockedByDetector(reason: string): SandboxExecutionResult {
    getGlobalLogger().error('SandboxManager', `Refusing execution (fail-closed): ${reason}`);
    return {
      stdout: '',
      stderr: `Command refused: ${reason}. Set COMMANDER_ALLOW_UNCHECKED_EXEC=1 to override (dev only).`,
      exitCode: 126,
      durationMs: 0,
      sandboxMechanism: 'none',
      violated: ['escape-detector-unavailable'],
    };
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const sandboxManagerSingleton = createTenantAwareSingleton(() => new SandboxManager());

export function getSandboxManager(): SandboxManager {
  return sandboxManagerSingleton.get();
}

export function resetSandboxManager(): void {
  sandboxManagerSingleton.reset();
}
