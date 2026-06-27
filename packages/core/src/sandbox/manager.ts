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

    // Security (G6): Pre-execution sandbox escape detection.
    // Analyze command for known escape patterns before executing in the sandbox.
    // If a critical indicator is detected, refuse execution entirely.
    try {
      const { preCheckSandboxEscape, postCheckSandboxEscape } = require('../security/sandboxEscapeDetector');
      const preCheck = preCheckSandboxEscape(command, p);
      if (preCheck.blocked) {
        return {
          stdout: '',
          stderr: `Command blocked by sandbox escape detector: ${preCheck.indicators.map((i: { pattern: string }) => i.pattern).join(', ')}`,
          exitCode: 126,
          durationMs: 0,
          sandboxMechanism: 'none',
          violated: preCheck.indicators.map((i: { pattern: string }) => i.pattern),
        };
      }

      const sb = this.getSandbox(mechanism);
      const result = await sb.execute(command, p, workdir);

      // Security (G6): Post-execution sandbox escape detection.
      // Analyze output for escape evidence and trigger RASP response if detected.
      postCheckSandboxEscape(command, result, workdir ?? process.cwd());

      return result;
    } catch {
      // If the escape detector fails to load, fall through to normal execution.
      const sb = this.getSandbox(mechanism);
      return sb.execute(command, p, workdir);
    }
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
