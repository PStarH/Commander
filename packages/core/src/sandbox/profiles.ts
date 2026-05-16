import type { SandboxProfile } from './types';

export const READ_ONLY: SandboxProfile = {
  mode: 'read-only',
  network: 'blocked',
  filesystem: {
    readablePaths: [process.cwd()],
    writablePaths: [],
    protectedPaths: ['.git', '.commander', '.commander_state', '.commander_memory', '.commander_results'],
    useStagingDir: false,
  },
  envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'],
  envVarAllowList: ['PATH', 'HOME', 'USER', 'SHELL', 'TERM'],
  timeout: 30000,
};

export const WORKSPACE_WRITE: SandboxProfile = {
  mode: 'workspace-write',
  network: 'blocked',
  filesystem: {
    readablePaths: [process.cwd(), '/tmp'],
    writablePaths: [process.cwd(), '/tmp'],
    protectedPaths: ['.git', '.commander', '.commander_state'],
    useStagingDir: false,
  },
  envVarDenyList: ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'],
  envVarAllowList: ['PATH', 'HOME', 'USER', 'SHELL', 'TERM'],
  timeout: 60000,
};

export const FULL_ACCESS: SandboxProfile = {
  mode: 'full-access',
  network: 'full',
  filesystem: {
    readablePaths: ['/'],
    writablePaths: ['/'],
    protectedPaths: [],
    useStagingDir: false,
  },
  timeout: 300000,
};

export const PROFILES: Record<string, SandboxProfile> = {
  'read-only': READ_ONLY,
  'workspace-write': WORKSPACE_WRITE,
  'full-access': FULL_ACCESS,
};
