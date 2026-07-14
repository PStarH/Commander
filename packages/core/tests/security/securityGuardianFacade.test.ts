import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkToolGuardian } from '../../src/security/securityGuardianFacade';

vi.mock('../../src/security/enterpriseSecurityGateway', () => ({
  getEnterpriseSecurityGateway: () => ({
    preToolCheck: () => ({ allowed: true, durationMs: 1 }),
  }),
}));

vi.mock('../../src/security/guardianAgent', () => ({
  getGuardianAgent: () => ({
    monitor: () => 'blocked_by_policy',
  }),
}));

describe('securityGuardianFacade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks when GuardianAgent returns an intervention', () => {
    const result = checkToolGuardian({
      agentId: 'a1',
      runId: 'r1',
      toolName: 'shell_execute',
      arguments: { cmd: 'rm -rf /' },
    });
    expect(result.allowed).toBe(false);
    expect(result.kind).toBe('guardian_blocked');
  });
});
