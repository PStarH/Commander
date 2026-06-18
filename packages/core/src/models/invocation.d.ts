import type { CommanderAgentCard, SlimMissionCard, CommanderRunIntent, AgentInvocationProfile } from './types';
/**
 * Generates the default invocation profile for an agent in a specific context.
 */
export declare function getDefaultInvocationProfile(input: {
    agent: CommanderAgentCard;
    mission?: SlimMissionCard;
    intent: CommanderRunIntent;
}): AgentInvocationProfile;
//# sourceMappingURL=invocation.d.ts.map