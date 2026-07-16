import type {
  PlatformSandbox,
  SandboxProfile,
  SandboxMechanism,
  SandboxExecutionResult,
} from './types';
import { discoverSandboxes, NoopSB } from './platforms';
import { PROFILES } from './profiles';
import { getGlobalLogger } from '../logging';

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
}

export class SandboxManager {
  private sandboxes: PlatformSandbox[] = [];
  private allowNoSandbox: boolean;

  constructor(deps?: SandboxManagerDeps) {
    this.allowNoSandbox = deps?.allowNoSandbox ?? allowNoSandboxFallback();
    this.sandboxes = deps?.sandboxes ?? discoverSandboxes();
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
  ): Promise<SandboxExecutionResult> {
    const p =
      typeof profile === 'string' ? this.getProfile(profile) : (profile ?? this.getProfile());

    // Security (G6, SBX-7): Pre-execution sandbox escape detection.
    // The detector is an enforcement control, so a load or evaluation failure
    // must FAIL CLOSED — we refuse the command instead of running it unchecked.
    // COMMANDER_ALLOW_UNCHECKED_EXEC restores the legacy fail-open path for dev.
    let detector: typeof import('../security/sandboxEscapeDetector') | undefined;
    try {
      detector = require('../security/sandboxEscapeDetector');
    } catch (err) {
      if (!allowUncheckedExecution()) {
        return this.blockedByDetector(
          `sandbox escape detector failed to load: ${(err as Error).message}`,
        );
      }
      getGlobalLogger().warn(
        'SandboxManager',
        'escape detector unavailable and COMMANDER_ALLOW_UNCHECKED_EXEC is set — running command UNCHECKED',
      );
    }

    if (detector) {
      let preCheck: ReturnType<typeof detector.preCheckSandboxEscape>;
      try {
        preCheck = detector.preCheckSandboxEscape(command, p);
      } catch (err) {
        if (!allowUncheckedExecution()) {
          return this.blockedByDetector(
            `sandbox escape pre-check threw: ${(err as Error).message}`,
          );
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
    }

    // Execute OUTSIDE the detector try/catch: a genuine execution error must
    // propagate, never be swallowed into a silent unchecked re-execution.
    const sb = this.getSandbox(mechanism);
    const result = await sb.execute(command, p, workdir);

    // Security (G6): Post-execution escape detection is advisory (RASP); a
    // failure here must not mask or re-run the command.
    if (detector) {
      try {
        detector.postCheckSandboxEscape(command, result, workdir ?? process.cwd());
      } catch (err) {
        getGlobalLogger().warn(
          'SandboxManager',
          `post-execution escape check failed: ${(err as Error).message}`,
        );
      }
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
