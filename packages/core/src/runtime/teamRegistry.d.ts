/** Agent roles within a team. Lead coordinates, worker executes, observer monitors, reviewer evaluates. */
export type TeamRole = 'lead' | 'worker' | 'observer' | 'reviewer';
export interface TeamMember {
    agentId: string;
    role: TeamRole;
    joinedAt: string;
    metadata?: Record<string, string>;
}
export interface TeamSpec {
    teamId: string;
    name: string;
    description: string;
    members: TeamMember[];
    missionId?: string;
    createdBy: string;
    createdAt: string;
    tags: string[];
}
export declare class TeamRegistry {
    private teams;
    private manifestPath;
    constructor(manifestPath?: string);
    /** Create a new team */
    createTeam(spec: Omit<TeamSpec, 'createdAt'>): TeamSpec;
    /** Get a team by ID */
    getTeam(teamId: string): TeamSpec | undefined;
    /** Delete a team */
    deleteTeam(teamId: string): boolean;
    /** List all teams */
    listTeams(): TeamSpec[];
    /** Find teams an agent belongs to */
    findTeamsForAgent(agentId: string): TeamSpec[];
    /** Add a member to a team */
    addMember(teamId: string, member: TeamMember): boolean;
    /** Remove a member from a team */
    removeMember(teamId: string, agentId: string): boolean;
    /** Get members of a team */
    getMembers(teamId: string, role?: TeamRole): TeamMember[];
    /** Set a member's role */
    setRole(teamId: string, agentId: string, role: TeamRole): boolean;
    /** Get the lead of a team (first member with 'lead' role) */
    getLead(teamId: string): TeamMember | undefined;
    /** Prune teams with no members */
    pruneEmpty(): number;
    private load;
    private save;
    dispose(): void;
}
//# sourceMappingURL=teamRegistry.d.ts.map