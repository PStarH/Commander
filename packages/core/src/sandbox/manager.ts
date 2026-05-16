import type { PlatformSandbox, SandboxProfile, SandboxMechanism, SandboxExecutionResult } from './types';
import { discoverSandboxes, NoopSB } from './platforms';
import { PROFILES } from './profiles';

export class SandboxManager {
  private sandboxes: PlatformSandbox[] = [];
  private noop = new NoopSB();

  constructor() {
    this.sandboxes = discoverSandboxes();
    if (this.sandboxes.length === 0) {
      console.debug('[sandbox] No OS-level sandbox available, using noop fallback');
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
    }
    return this.sandboxes[0] ?? this.noop;
  }

  getProfile(name?: string): SandboxProfile {
    if (name && name in PROFILES) return PROFILES[name];
    if (process.env.COMMANDER_SANDBOX_MODE && PROFILES[process.env.COMMANDER_SANDBOX_MODE]) {
      return PROFILES[process.env.COMMANDER_SANDBOX_MODE];
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

let globalManager: SandboxManager | null = null;

export function getSandboxManager(): SandboxManager {
  if (!globalManager) globalManager = new SandboxManager();
  return globalManager;
}
