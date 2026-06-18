"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamRegistry = void 0;
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
class TeamRegistry {
    constructor(manifestPath) {
        this.teams = new Map();
        this.manifestPath =
            manifestPath !== null && manifestPath !== void 0 ? manifestPath : path.join(process.cwd(), '.commander_teams', 'manifest.json');
        fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
        this.load();
    }
    /** Create a new team */
    createTeam(spec) {
        if (this.teams.has(spec.teamId)) {
            throw new Error(`Team "${spec.teamId}" already exists`);
        }
        const team = { ...spec, createdAt: new Date().toISOString() };
        this.teams.set(team.teamId, team);
        this.save();
        return team;
    }
    /** Get a team by ID */
    getTeam(teamId) {
        return this.teams.get(teamId);
    }
    /** Delete a team */
    deleteTeam(teamId) {
        const removed = this.teams.delete(teamId);
        if (removed)
            this.save();
        return removed;
    }
    /** List all teams */
    listTeams() {
        return Array.from(this.teams.values());
    }
    /** Find teams an agent belongs to */
    findTeamsForAgent(agentId) {
        return Array.from(this.teams.values()).filter((t) => t.members.some((m) => m.agentId === agentId));
    }
    /** Add a member to a team */
    addMember(teamId, member) {
        const team = this.teams.get(teamId);
        if (!team)
            return false;
        if (team.members.some((m) => m.agentId === member.agentId))
            return false;
        team.members.push({ ...member, joinedAt: new Date().toISOString() });
        this.save();
        return true;
    }
    /** Remove a member from a team */
    removeMember(teamId, agentId) {
        const team = this.teams.get(teamId);
        if (!team)
            return false;
        const before = team.members.length;
        team.members = team.members.filter((m) => m.agentId !== agentId);
        if (team.members.length !== before) {
            this.save();
            return true;
        }
        return false;
    }
    /** Get members of a team */
    getMembers(teamId, role) {
        const team = this.teams.get(teamId);
        if (!team)
            return [];
        if (role)
            return team.members.filter((m) => m.role === role);
        return [...team.members];
    }
    /** Set a member's role */
    setRole(teamId, agentId, role) {
        const team = this.teams.get(teamId);
        if (!team)
            return false;
        const member = team.members.find((m) => m.agentId === agentId);
        if (!member)
            return false;
        member.role = role;
        this.save();
        return true;
    }
    /** Get the lead of a team (first member with 'lead' role) */
    getLead(teamId) {
        return this.getMembers(teamId, 'lead')[0];
    }
    /** Prune teams with no members */
    pruneEmpty() {
        let pruned = 0;
        for (const [id, team] of this.teams) {
            if (team.members.length === 0) {
                this.teams.delete(id);
                pruned++;
            }
        }
        if (pruned > 0)
            this.save();
        return pruned;
    }
    load() {
        if (!fs.existsSync(this.manifestPath))
            return;
        try {
            const raw = fs.readFileSync(this.manifestPath, 'utf-8');
            const data = JSON.parse(raw);
            for (const team of data) {
                this.teams.set(team.teamId, team);
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('TeamRegistry', 'Failed to load team manifest', {
                error: e === null || e === void 0 ? void 0 : e.message,
                manifestPath: this.manifestPath,
            });
        }
    }
    save() {
        const tmpPath = this.manifestPath + '.tmp';
        try {
            const content = JSON.stringify(Array.from(this.teams.values()), null, 2);
            fs.writeFileSync(tmpPath, content, 'utf-8');
            fs.renameSync(tmpPath, this.manifestPath);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('TeamRegistry', 'Failed to save team manifest', {
                error: e === null || e === void 0 ? void 0 : e.message,
                manifestPath: this.manifestPath,
            });
        }
    }
    dispose() {
        this.teams.clear();
    }
}
exports.TeamRegistry = TeamRegistry;
