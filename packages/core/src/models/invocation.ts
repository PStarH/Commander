import type {
  CommanderAgentCard,
  SlimMissionCard,
  CommanderRunIntent,
  CommanderInvocationDisposition,
  AgentInvocationProfile,
} from './types';

/** Input for determining mission governance disposition. */
interface MissionGovernanceDispositionInput {
  /** The agent being evaluated. */
  agent: CommanderAgentCard;
  /** The mission being targeted. */
  mission?: SlimMissionCard;
  /** The intended action. */
  intent: CommanderRunIntent;
}

/** Disposition resulting from governance evaluation. */
interface MissionGovernanceDisposition {
  /** Final disposition for the invocation. */
  disposition: CommanderInvocationDisposition;
  /** Supporting rationale for the decision. */
  rationale: string[];
  /** Optional approval configuration. */
  approval?: AgentInvocationProfile['approval'];
}

/**
 * Determines the governance disposition for a mission based on risk and mode.
 */
function getMissionGovernanceDisposition(
  input: MissionGovernanceDispositionInput,
): MissionGovernanceDisposition {
  const rationale: string[] = [];
  const mission = input.mission;

  if (!mission) {
    rationale.push('No mission bound => PROPOSE/PLAN only by default.');
    return { disposition: 'PROPOSE_ONLY', rationale };
  }

  if (mission.governanceMode === 'MANUAL') {
    rationale.push(
      'governanceMode=MANUAL => proposals allowed; execution requires COMMANDER approval.',
    );
    return {
      disposition: 'REQUIRE_APPROVAL',
      rationale,
      approval: { required: true, requiredRoles: ['COMMANDER'], minApprovals: 1 },
    };
  }

  const highRisk = mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
  if (highRisk && input.agent.governanceRole === 'EXECUTOR' && input.intent === 'EXECUTE') {
    rationale.push(
      'HIGH/CRITICAL risk + EXECUTE intent => require approval or downgrade to proposal externally.',
    );
    return {
      disposition: 'REQUIRE_APPROVAL',
      rationale,
      approval: { required: true, requiredRoles: ['COMMANDER', 'SENATE'], minApprovals: 1 },
    };
  }

  if (mission.governanceMode === 'GUARDED' && input.intent === 'EXECUTE') {
    rationale.push(
      'governanceMode=GUARDED + EXECUTE intent => allow execution but expect senate monitoring.',
    );
    return { disposition: 'ALLOW_EXECUTION', rationale };
  }

  return {
    disposition: input.intent === 'EXECUTE' ? 'ALLOW_EXECUTION' : 'PROPOSE_ONLY',
    rationale,
  };
}

/**
 * Generates the default invocation profile for an agent in a specific context.
 */
export function getDefaultInvocationProfile(input: {
  agent: CommanderAgentCard;
  mission?: SlimMissionCard;
  intent: CommanderRunIntent;
}): AgentInvocationProfile {
  const governance = getMissionGovernanceDisposition(input);
  const rationale = [...governance.rationale];

  if (governance.disposition === 'ALLOW_EXECUTION' && input.intent === 'EXECUTE') {
    return {
      agentId: input.agent.id,
      intent: input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: [
        'READ_CONTEXT',
        'WRITE_LOG',
        'UPDATE_MISSION_STATUS',
        'UPDATE_MISSION_FIELDS',
        'WRITE_MEMORY',
        'UPDATE_AGENT_STATE',
      ],
      forbiddenOperations: ['REQUEST_APPROVAL'],
      approval: governance.approval ?? { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  if (governance.disposition === 'REQUIRE_APPROVAL') {
    rationale.push(
      'Restricting to proposal-safe operations until approval is granted by external system.',
    );
    return {
      agentId: input.agent.id,
      intent: input.intent === 'EXECUTE' ? 'PROPOSE' : input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
      forbiddenOperations: ['UPDATE_MISSION_STATUS', 'UPDATE_MISSION_FIELDS', 'UPDATE_AGENT_STATE'],
      approval: governance.approval ?? {
        required: true,
        requiredRoles: ['COMMANDER'],
        minApprovals: 1,
      },
      rationale,
    };
  }

  if (governance.disposition === 'PROPOSE_ONLY') {
    return {
      agentId: input.agent.id,
      intent: input.intent === 'EXECUTE' ? 'PROPOSE' : input.intent,
      missionId: input.mission?.id,
      disposition: governance.disposition,
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY'],
      forbiddenOperations: [
        'UPDATE_MISSION_STATUS',
        'UPDATE_MISSION_FIELDS',
        'UPDATE_AGENT_STATE',
        'REQUEST_APPROVAL',
      ],
      approval: governance.approval ?? { required: false, requiredRoles: [], minApprovals: 0 },
      rationale,
    };
  }

  return {
    agentId: input.agent.id,
    intent: input.intent,
    missionId: input.mission?.id,
    disposition: 'DENY',
    allowedOperations: ['READ_CONTEXT'],
    forbiddenOperations: [
      'WRITE_LOG',
      'UPDATE_MISSION_STATUS',
      'UPDATE_MISSION_FIELDS',
      'WRITE_MEMORY',
      'UPDATE_AGENT_STATE',
      'REQUEST_APPROVAL',
    ],
    approval: {
      required: true,
      requiredRoles: ['COMMANDER'],
      minApprovals: 1,
    },
    rationale: [...rationale, 'Default deny.'],
  };
}
