import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertInvariants,
  registerDefaultInvariants,
  resetInvariants,
} from '../../src/security/securityInvariantVerifier';

describe('securityInvariantVerifier', () => {
  beforeEach(() => {
    resetInvariants();
    registerDefaultInvariants();
  });

  it('blocks executeTool when capability token is required but missing', () => {
    const result = assertInvariants(
      {
        agentId: 'agent-1',
        runId: 'run-1',
        toolName: 'echo',
        capabilityTokenPresent: false,
        requireCapabilityToken: true,
        agentSuspended: false,
        agentQuarantined: false,
      },
      'executeTool',
    );

    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.invariant.id)).toContain('CAPABILITY_TOKEN_FOR_TOOL');
  });

  it('allows executeTool without token when no tools are in scope', () => {
    const result = assertInvariants(
      {
        agentId: 'agent-1',
        runId: 'run-1',
        capabilityTokenPresent: false,
        requireCapabilityToken: false,
        agentSuspended: false,
        agentQuarantined: false,
      },
      'executeTool',
    );

    expect(result.passed).toBe(true);
  });

  it('blocks suspended agents', () => {
    const result = assertInvariants(
      {
        agentId: 'agent-1',
        agentSuspended: true,
        agentQuarantined: false,
      },
      'executeTool',
    );

    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.invariant.id)).toContain('AGENT_NOT_SUSPENDED');
  });

  it('lazy-registers defaults when registry was reset', () => {
    resetInvariants();
    const result = assertInvariants(
      {
        agentId: 'agent-1',
        agentSuspended: true,
        agentQuarantined: false,
      },
      'executeTool',
    );

    expect(result.passed).toBe(false);
  });
});
