/**
 * Team Registry — Persistent agent team management.
 *
 * Manages named groups of agents with role-based membership (lead, worker,
 * observer, reviewer). Teams are persisted to disk as a JSON manifest using
 * atomic write-tmp-rename to prevent corruption.
 *
 * Used by AgentHandoff and orchestrator for team-based task routing and
 * multi-agent coordination.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

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

export class TeamRegistry {
  private teams = new Map<string, TeamSpec>();
  private manifestPath: string;

  constructor(manifestPath?: string) {
    this.manifestPath =
      manifestPath ?? path.join(process.cwd(), '.commander_teams', 'manifest.json');
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    this.load();
  }

  /** Create a new team */
  createTeam(spec: Omit<TeamSpec, 'createdAt'>): TeamSpec {
    if (this.teams.has(spec.teamId)) {
      throw new Error(`Team "${spec.teamId}" already exists`);
    }
    const team: TeamSpec = { ...spec, createdAt: new Date().toISOString() };
    this.teams.set(team.teamId, team);
    this.save();
    return team;
  }

  /** Get a team by ID */
  getTeam(teamId: string): TeamSpec | undefined {
    return this.teams.get(teamId);
  }

  /** Delete a team */
  deleteTeam(teamId: string): boolean {
    const removed = this.teams.delete(teamId);
    if (removed) this.save();
    return removed;
  }

  /** List all teams */
  listTeams(): TeamSpec[] {
    return Array.from(this.teams.values());
  }

  /** Find teams an agent belongs to */
  findTeamsForAgent(agentId: string): TeamSpec[] {
    return Array.from(this.teams.values()).filter((t) =>
      t.members.some((m) => m.agentId === agentId),
    );
  }

  /** Add a member to a team */
  addMember(teamId: string, member: TeamMember): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    if (team.members.some((m) => m.agentId === member.agentId)) return false;
    team.members.push({ ...member, joinedAt: new Date().toISOString() });
    this.save();
    return true;
  }

  /** Remove a member from a team */
  removeMember(teamId: string, agentId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    const before = team.members.length;
    team.members = team.members.filter((m) => m.agentId !== agentId);
    if (team.members.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /** Get members of a team */
  getMembers(teamId: string, role?: TeamRole): TeamMember[] {
    const team = this.teams.get(teamId);
    if (!team) return [];
    if (role) return team.members.filter((m) => m.role === role);
    return [...team.members];
  }

  /** Set a member's role */
  setRole(teamId: string, agentId: string, role: TeamRole): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    const member = team.members.find((m) => m.agentId === agentId);
    if (!member) return false;
    member.role = role;
    this.save();
    return true;
  }

  /** Get the lead of a team (first member with 'lead' role) */
  getLead(teamId: string): TeamMember | undefined {
    return this.getMembers(teamId, 'lead')[0];
  }

  /** Prune teams with no members */
  pruneEmpty(): number {
    let pruned = 0;
    for (const [id, team] of this.teams) {
      if (team.members.length === 0) {
        this.teams.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }

  private load(): void {
    if (!fs.existsSync(this.manifestPath)) return;
    try {
      const raw = fs.readFileSync(this.manifestPath, 'utf-8');
      const data = JSON.parse(raw) as TeamSpec[];
      for (const team of data) {
        this.teams.set(team.teamId, team);
      }
    } catch (e) {
      getGlobalLogger().warn('TeamRegistry', 'Failed to load team manifest', {
        error: (e as Error)?.message,
        manifestPath: this.manifestPath,
      });
    }
  }

  private save(): void {
    const tmpPath = this.manifestPath + '.tmp';
    try {
      const content = JSON.stringify(Array.from(this.teams.values()), null, 2);
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, this.manifestPath);
    } catch (e) {
      getGlobalLogger().warn('TeamRegistry', 'Failed to save team manifest', {
        error: (e as Error)?.message,
        manifestPath: this.manifestPath,
      });
    }
  }

  dispose(): void {
    this.teams.clear();
  }
}
