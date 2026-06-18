import type { Project, Agent, Mission, ExecutionLog, WarRoomData, ProjectWarRoomSnapshot, SlimSnapshot, CreateSlimSnapshotOptions, ProjectBattleReport } from './types';
/**
 * Creates a token-efficient slim snapshot from a full project snapshot.
 */
export declare function createSlimSnapshot(snapshot: ProjectWarRoomSnapshot, options: CreateSlimSnapshotOptions): SlimSnapshot;
export declare function createSeedWarRoomData(now?: Date): WarRoomData;
export declare function generateProjectBattleReport(project: Project, agents: Agent[], missions: Mission[], logs: ExecutionLog[], now?: Date): ProjectBattleReport;
export declare function getProjectWarRoomSnapshot(data: WarRoomData, projectId: string, now?: Date): ProjectWarRoomSnapshot | null;
//# sourceMappingURL=projections.d.ts.map