import type {
  PlatformSandbox,
  SandboxProfile,
  SandboxMechanism,
  SandboxExecutionResult,
  SandboxIsolation,
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

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * WS7 §2 — Parse `COMMANDER_SANDBOX_ISOLATION` and apply production defaults.
 *
 * - production + unset → `docker`
 * - production + `process` → throws (cannot lower the baseline to non-container)
 * - production + `gvisor` → `gvisor` (explicit, never degrades)
 * - non-production + unset → undefined (legacy discover-first behaviour)
 *
 * The production check reads `env.NODE_ENV` (not the module-level `isProduction()`)
 * so the function is fully testable via its `env` parameter — callers do not
 * need to mutate `process.env` to exercise production behaviour.
 */
export function parseSandboxIsolation(
  env: NodeJS.ProcessEnv = process.env,
): SandboxIsolation | undefined {
  const isProd = env.NODE_ENV === 'production';
  const raw = env.COMMANDER_SANDBOX_ISOLATION?.toLowerCase().trim();
  if (raw === 'docker' || raw === 'gvisor' || raw === 'process') {
    if (raw === 'process' && isProd) {
      throw new SandboxInitializationError(
        'WS7 §2: COMMANDER_SANDBOX_ISOLATION=process is rejected in production. ' +
          'Use "docker" (default) or "gvisor".',
      );
    }
    return raw;
  }
  // production default
  if (isProd) {
    return 'docker';
  }
  return undefined;
}

/**
 * Mechanism families that satisfy each WS7 isolation level.
 * `process` = OS subprocess sandboxes (seatbelt/bwrap/appcontainer).
 * `docker` = OCI container (docker).
 * `gvisor` = OCI container with runsc (gvisor).
 */
const ISOLATION_MECHANISMS: Record<SandboxIsolation, SandboxMechanism[]> = {
  process: ['seatbelt', 'bwrap', 'appcontainer'],
  docker: ['docker'],
  gvisor: ['gvisor'],
};

export interface SandboxManagerDeps {
  /** Override sandbox discovery for testing. */
  sandboxes?: PlatformSandbox[];
  /** Override the no-sandbox fallback policy. */
  allowNoSandbox?: boolean;
  /** Override the WS7 isolation level (testing). */
  isolation?: SandboxIsolation | undefined;
}

export class SandboxManager {
  private sandboxes: PlatformSandbox[] = [];
  private allowNoSandbox: boolean;
  private isolation: SandboxIsolation | undefined;

  constructor(deps?: SandboxManagerDeps) {
    this.allowNoSandbox = deps?.allowNoSandbox ?? allowNoSandboxFallback();
    this.sandboxes = deps?.sandboxes ?? discoverSandboxes();
    this.isolation = deps?.isolation ?? parseSandboxIsolation();

    // WS7 §3: In production, COMMANDER_ALLOW_NO_SANDBOX is a prohibited bypass.
    // The flag is ignored entirely — NoopSB must never be reachable in production.
    if (isProduction() && this.allowNoSandbox) {
      this.allowNoSandbox = false;
      getGlobalLogger().warn(
        'SandboxManager',
        'WS7 §3: COMMANDER_ALLOW_NO_SANDBOX is ignored in production — fail-closed enforced',
      );
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

  /** WS7 §2: The configured isolation level (docker/gvisor/process). */
  getIsolation(): SandboxIsolation | undefined {
    return this.isolation;
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

    // WS7 §2: If an isolation level is set, select only from its mechanism family.
    // gvisor must NOT silently fall back to docker — explicit selection is a hard gate.
    if (this.isolation) {
      const allowed = ISOLATION_MECHANISMS[this.isolation];
      const match = this.sandboxes.find((s) => allowed.includes(s.name));
      if (match) return match;
      // No matching sandbox for the requested isolation level.
      if (this.isolation === 'gvisor') {
        throw new SandboxInitializationError(
          'WS7 §2: gvisor isolation was explicitly requested but runsc is not available. ' +
            'gVisor does not degrade to Docker — install runsc or select docker isolation.',
          'gvisor',
        );
      }
      throw new SandboxInitializationError(
        `WS7 §2: isolation="${this.isolation}" requested but no matching sandbox available ` +
          `(${allowed.join(', ')}). Available: ${this.sandboxes.map((s) => s.name).join(', ') || 'none'}.`,
      );
    }

    if (this.sandboxes.length === 0) {
      // WS7 §3: Noop fallback is dead in production — allowNoSandbox was
      // forced to false in the constructor for production.
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
