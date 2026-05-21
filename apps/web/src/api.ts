import type {
  WarRoomSnapshot,
  ProjectMemoryItem,
  MemoryOverview,
  CreateMissionPayload,
  CreateLogPayload,
  MemoryKindFilter,
} from './types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
export const PROJECT_ID = 'project-war-room';

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchWarRoomSnapshot(): Promise<WarRoomSnapshot> {
  const response = await fetch(`${API_BASE}/projects/${PROJECT_ID}/war-room`);
  if (!response.ok) throw new Error('Failed to load war room snapshot');
  return response.json() as Promise<WarRoomSnapshot>;
}

export async function fetchMemoryItems(filters?: {
  query?: string;
  kind?: MemoryKindFilter;
  tags?: string;
}): Promise<ProjectMemoryItem[]> {
  const hasFilters = Boolean(
    filters?.query?.trim() || filters?.tags?.trim() || (filters?.kind && filters.kind !== 'ALL')
  );
  const url = new URL(
    hasFilters
      ? `${API_BASE}/projects/${PROJECT_ID}/memory/search`
      : `${API_BASE}/projects/${PROJECT_ID}/memory`
  );

  if (hasFilters) {
    if (filters?.query?.trim()) url.searchParams.set('q', filters.query.trim());
    if (filters?.tags?.trim()) url.searchParams.set('tags', filters.tags.trim());
    if (filters?.kind && filters.kind !== 'ALL') url.searchParams.set('kind', filters.kind);
  }
  url.searchParams.set('limit', '24');

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(await readError(response, 'Failed to load memory'));
  return response.json() as Promise<ProjectMemoryItem[]>;
}

export async function fetchMemoryOverview(): Promise<MemoryOverview> {
  const response = await fetch(`${API_BASE}/projects/${PROJECT_ID}/memory/overview`);
  if (!response.ok) throw new Error('Failed to load memory overview');
  return response.json() as Promise<MemoryOverview>;
}

export async function createMission(payload: CreateMissionPayload): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${PROJECT_ID}/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to create mission'));
}

export async function updateMissionStatus(missionId: string, status: string): Promise<void> {
  const response = await fetch(`${API_BASE}/missions/${missionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const message = await readError(response, 'Failed to update mission');
    if (response.status === 409 && message.includes('requires approval')) {
      throw new ApprovalRequiredError('该任务在 MANUAL 治理模式下，完成前需要在指挥台中走审批流。');
    }
    throw new Error(message);
  }
}

export async function approveMission(missionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/missions/${missionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to approve mission'));
}

export async function createLog(missionId: string, payload: CreateLogPayload): Promise<void> {
  const response = await fetch(`${API_BASE}/missions/${missionId}/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to write log'));
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}
