import type { PlatformSandbox, SandboxProfile, SandboxMechanism, SandboxExecutionResult } from './types';
import { discoverSandboxes, NoopSB } from './platforms';
import { PROFILES } from './profiles';
import { getGlobalLogger } from '../logging';

export class SandboxManager {
  private sandboxes: PlatformSandbox[] = [];
  private noop = new NoopSB();

  constructor() {
    this.sandboxes = discoverSandboxes();
    if (this.sandboxes.length === 0) {
      getGlobalLogger().debug('SandboxManager', 'No OS-level sandbox available, using noop fallback');
    }
  }

  getAvailableMechanisms(): SandboxMechanism[] {
    return this.sandboxes.map(s => s.name);
  }

  hasSandbox(): boolean {
    return this.sandboxes.length > 0;
  }

  getSandbox(mechanism?: SandboxMechanism): PlatformSandbox {
    if (mechanism) {
      const found = this.sandboxes.find(s => s.name === mechanism);
      if (found) return found;
      // SECURITY FIX: warn on silent fallback instead of quietly using NoopSB
      getGlobalLogger().warn('SandboxManager', `Requested sandbox "${mechanism}" not available, falling back to ${this.sandboxes[0]?.name ?? 'none (UNSANDBOXED)'}`);
    }
    const fallback = this.sandboxes[0] ?? this.noop;
    if (fallback.name === 'none') {
      getGlobalLogger().warn('SandboxManager', '⚠️  No OS-level sandbox available — commands will run UNSANDBOXED');
    }
    return fallback;
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
    const p = typeof profile === 'string' ? this.getProfile(profile) : (profile ?? this.getProfile());
    const sb = this.getSandbox(mechanism);
    return sb.execute(command, p, workdir);
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
