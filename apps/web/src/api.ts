import { reportSilentFailure } from './lib/silentFailure';
import type {
  WarRoomSnapshot,
  ProjectMemoryItem,
  MemoryOverview,
  CreateMissionPayload,
  CreateLogPayload,
  MemoryKindFilter,
  ConfidenceReport,
  CostSummary,
  CostRecord,
  BudgetStatus,
  CostRecordsResponse,
  ActiveRunsResponse,
  PauseResumeResponse,
  ReplayRunsResponse,
  ReplayEventsResponse,
  HallucinationReportResponse,
  LineageSummaryResponse,
} from './types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
export const PROJECT_ID = 'project-war-room';

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    // Security: Sanitize error messages from the backend to avoid leaking
    // internal implementation details. Only return known-safe error patterns.
    const rawError = data.error || fallback;
    // Allow short, alphanumeric error messages (typical API error responses)
    // but truncate and sanitize anything that looks like an internal detail.
    if (rawError.length > 200 || rawError.includes('\n') || rawError.includes('at /')) {
      return fallback;
    }
    return rawError;
  } catch (err) {
    reportSilentFailure(err, 'api:27');
    return fallback;
  }
}

/**
 * Unified request wrapper that encapsulates the common fetch + error-handling +
 * JSON-parsing pattern used across the API module.
 *
 * TODO: Migrate the remaining fetch functions to use this helper for consistency.
 */
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    throw new Error(await readError(response, `Request to ${path} failed`));
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : (undefined as unknown)) as T;
}

export async function fetchWarRoomSnapshot(): Promise<WarRoomSnapshot> {
  return apiFetch<WarRoomSnapshot>(`/projects/${PROJECT_ID}/war-room`);
}

export async function fetchMemoryItems(filters?: {
  query?: string;
  kind?: MemoryKindFilter;
  tags?: string;
}): Promise<ProjectMemoryItem[]> {
  const hasFilters = Boolean(
    filters?.query?.trim() || filters?.tags?.trim() || (filters?.kind && filters.kind !== 'ALL'),
  );
  const url = new URL(
    hasFilters
      ? `${API_BASE}/projects/${PROJECT_ID}/memory/search`
      : `${API_BASE}/projects/${PROJECT_ID}/memory`,
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
  return apiFetch<MemoryOverview>(`/projects/${PROJECT_ID}/memory/overview`);
}

export async function createMission(payload: CreateMissionPayload): Promise<void> {
  await apiFetch<void>(`/projects/${PROJECT_ID}/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
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

export async function fetchMissionConfidence(missionId: string): Promise<ConfidenceReport> {
  const response = await fetch(
    `${API_BASE}/projects/${PROJECT_ID}/missions/${missionId}/confidence`,
  );
  if (!response.ok) throw new Error(await readError(response, 'Failed to load mission confidence'));
  return response.json() as Promise<ConfidenceReport>;
}

export async function fetchAgentConfidence(
  agentId: string,
  missionId?: string,
): Promise<ConfidenceReport> {
  const url = new URL(`${API_BASE}/projects/${PROJECT_ID}/agents/${agentId}/confidence`);
  if (missionId) url.searchParams.set('missionId', missionId);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(await readError(response, 'Failed to load agent confidence'));
  return response.json() as Promise<ConfidenceReport>;
}

export async function fetchCostSummary(): Promise<CostSummary> {
  return apiFetch<CostSummary>(`/api/cost/summary`);
}

export async function fetchCostRecords(limit = 100, runId?: string): Promise<CostRecordsResponse> {
  const url = new URL(`${API_BASE}/api/cost/records`);
  url.searchParams.set('limit', String(limit));
  if (runId) url.searchParams.set('runId', runId);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(await readError(response, 'Failed to load cost records'));
  return response.json() as Promise<CostRecordsResponse>;
}

export async function fetchBudgetStatus(): Promise<BudgetStatus> {
  const response = await fetch(`${API_BASE}/api/cost/budget`);
  if (!response.ok) throw new Error(await readError(response, 'Failed to load budget status'));
  return response.json() as Promise<BudgetStatus>;
}

export async function fetchActiveRuns(): Promise<ActiveRunsResponse> {
  const response = await fetch(`${API_BASE}/runtime/active`);
  if (!response.ok) throw new Error(await readError(response, 'Failed to load active runs'));
  return response.json() as Promise<ActiveRunsResponse>;
}

export async function pauseRun(runId: string): Promise<PauseResumeResponse> {
  const response = await fetch(`${API_BASE}/runtime/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to pause run'));
  return response.json() as Promise<PauseResumeResponse>;
}

export async function resumeRun(
  runId: string,
  userInstructions?: string,
): Promise<PauseResumeResponse> {
  const response = await fetch(`${API_BASE}/runtime/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, userInstructions }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to resume run'));
  return response.json() as Promise<PauseResumeResponse>;
}

export async function fetchReplayRuns(): Promise<ReplayRunsResponse> {
  const response = await fetch(`${API_BASE}/api/replay/runs`);
  if (!response.ok) throw new Error(await readError(response, 'Failed to load replay runs'));
  return response.json() as Promise<ReplayRunsResponse>;
}

export async function fetchReplayEvents(
  runId: string,
  type?: string,
): Promise<ReplayEventsResponse> {
  const url = new URL(`${API_BASE}/api/replay/runs/${runId}/events`);
  if (type) url.searchParams.set('type', type);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(await readError(response, 'Failed to load replay events'));
  return response.json() as Promise<ReplayEventsResponse>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
  /** True while a streaming response is still being received. */
  isStreaming?: boolean;
}

export interface ChatResponse {
  reply: string;
  agentId: string;
  runId?: string;
  timestamp: string;
}

export async function sendChatMessage(
  message: string,
  agentId?: string,
  missionId?: string,
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, agentId, missionId, projectId: PROJECT_ID }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to send chat message'));
  return response.json() as Promise<ChatResponse>;
}

// ============================================================================
// Chat streaming — SSE-based progressive response rendering
// ============================================================================

/** A single streamed step emitted by POST /api/chat?stream=true. */
export interface ChatStreamStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'response' | string;
  content: string;
  toolName?: string;
  success?: boolean;
  timestamp: string;
}

/** Final payload emitted with the `done` event. */
export interface ChatStreamDone {
  reply: string;
  agentId: string;
  runId?: string;
  timestamp: string;
}

export interface ChatStreamCallbacks {
  onStart?: (data: { agentId: string; timestamp: string }) => void;
  onStep: (step: ChatStreamStep) => void;
  onDone: (final: ChatStreamDone) => void;
  onError: (errorMessage: string) => void;
}

/**
 * Sends a chat message and reads the Server-Sent Events stream progressively.
 *
 * Uses the fetch API + ReadableStream (POST cannot use EventSource) to parse
 * SSE frames: `start` → 0..n `step` → `done`, terminated by `data: [DONE]`.
 * The callbacks are invoked as each frame arrives so the UI can render the
 * assistant message incrementally.
 */
export async function sendChatMessageStream(
  message: string,
  agentId: string | undefined,
  missionId: string | undefined,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/api/chat?stream=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, agentId, missionId, projectId: PROJECT_ID }),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to send chat message'));
  }
  if (!response.body) {
    throw new Error('Streaming not supported: empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Parse and dispatch a single complete SSE frame (already extracted). */
  const dispatchFrame = (frame: string): boolean => {
    if (!frame.trim()) return false;
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        // SSE spec: multiple data lines are joined with "\n". The backend
        // emits single-line JSON, so we support both forms.
        data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
    }
    if (data === '[DONE]') return true;
    if (!data) return false;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      switch (event) {
        case 'start':
          callbacks.onStart?.(parsed as unknown as { agentId: string; timestamp: string });
          break;
        case 'step':
          callbacks.onStep(parsed as unknown as ChatStreamStep);
          break;
        case 'done':
          callbacks.onDone(parsed as unknown as ChatStreamDone);
          break;
        case 'error':
          callbacks.onError(
            (parsed.error as string) || 'Stream error from server',
          );
          break;
        default:
          // Unknown event types are ignored — forward compatibility.
          break;
      }
    } catch {
      /* Ignore malformed JSON frames — the stream remains usable. */
    }
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line (\n\n). Keep any trailing
      // partial frame in the buffer for the next iteration.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (dispatchFrame(frame)) {
          // [DONE] received — terminate early.
          reader.releaseLock();
          return;
        }
      }
    }
    // Flush any remaining buffered frame once the stream closes.
    if (buffer.trim()) {
      dispatchFrame(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// Step-level correction — rollback to a specific step (GAP-03)
// ============================================================================

export interface StepRollbackResponse {
  status: string;
  message: string;
  fromStep: number;
  toStep: number;
  injectedInstructions: boolean;
}

export async function rollbackToStep(
  runId: string,
  stepNumber: number,
  userInstructions?: string,
): Promise<StepRollbackResponse> {
  const response = await fetch(`${API_BASE}/runtime/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, stepNumber, userInstructions }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Failed to rollback to step'));
  return response.json() as Promise<StepRollbackResponse>;
}

// ============================================================================
// Hallucination Detection — risk reports from trace files (GAP-04)
// ============================================================================

export async function fetchHallucinationReport(
  runId: string,
): Promise<HallucinationReportResponse> {
  const response = await fetch(
    `${API_BASE}/api/hallucination/runs/${encodeURIComponent(runId)}`,
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load hallucination report'));
  }
  return response.json() as Promise<HallucinationReportResponse>;
}

// ============================================================================
// Lineage Tracking — agent provenance tree (GAP-05)
// ============================================================================

export async function fetchLineage(
  runId: string,
): Promise<LineageSummaryResponse> {
  const response = await fetch(
    `${API_BASE}/api/lineage/runs/${encodeURIComponent(runId)}`,
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load lineage graph'));
  }
  return response.json() as Promise<LineageSummaryResponse>;
}

// ============================================================================
// Dead Letter Queue — failed tool executions (GAP-06)
// ============================================================================

export interface DlqCategoryStat {
  category: string;
  count: number;
  unrecovered: number;
}

export interface DlqStats {
  totalEntries: number;
  totalUnrecovered: number;
  totalRecovered: number;
  categories: DlqCategoryStat[];
}

export interface DlqEntry {
  id: string;
  category: string;
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  errorClass: string;
  errorMessage: string;
  retryable: boolean;
  attemptNumber: number;
  operationName: string;
  inputSnapshot?: string;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  compensated: boolean;
  recovered: boolean;
  tags: string[];
  /** Failure-mode classification surfaced by the DLQ entries endpoint. */
  failureMode?: string;
}

export async function fetchDlqStats(): Promise<DlqStats> {
  const response = await fetch(`${API_BASE}/api/dlq/stats`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load DLQ stats'));
  }
  return response.json() as Promise<DlqStats>;
}

export async function fetchDlqEntries(
  category?: string,
  limit?: number,
): Promise<DlqEntry[]> {
  const url = new URL(`${API_BASE}/api/dlq/entries`);
  if (category) url.searchParams.set('category', category);
  if (limit) url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load DLQ entries'));
  }
  return response.json() as Promise<DlqEntry[]>;
}

export async function replayDlqEntry(
  entryId: string,
): Promise<{ status: string; entryId: string; recovered: boolean }> {
  const response = await fetch(
    `${API_BASE}/api/dlq/replay/${encodeURIComponent(entryId)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to replay DLQ entry'));
  }
  return response.json() as Promise<{ status: string; entryId: string; recovered: boolean }>;
}

// ============================================================================
// Approval Configuration — unified governance (GAP-07)
// ============================================================================

export type ApprovalSandboxMode = 'suggest' | 'auto-edit' | 'full-auto' | 'read-only' | 'plan';
export type ApprovalLevel = 'auto' | 'semi_auto' | 'manual';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolPolicy {
  pattern: string;
  level: ApprovalLevel;
  riskLevel: RiskLevel;
  description: string;
  autoApproveIf?: Record<string, unknown>;
}

export interface UnifiedApprovalConfig {
  sandboxMode: ApprovalSandboxMode;
  sandboxModeDescription: string;
  toolPolicies: ToolPolicy[];
  failClosed: boolean;
  lastUpdated: string;
}

export interface ApprovalAuditEntry {
  timestamp: string;
  event: string;
  toolName?: string;
  decision?: string;
  reason?: string;
  riskLevel?: string;
}

export async function fetchApprovalConfig(): Promise<UnifiedApprovalConfig> {
  const response = await fetch(`${API_BASE}/api/approval/config`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load approval config'));
  }
  return response.json() as Promise<UnifiedApprovalConfig>;
}

export async function updateSandboxMode(
  mode: ApprovalSandboxMode,
): Promise<{ status: string; mode: ApprovalSandboxMode; description: string }> {
  const response = await fetch(`${API_BASE}/api/approval/sandbox-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to update sandbox mode'));
  }
  return response.json() as Promise<{
    status: string;
    mode: ApprovalSandboxMode;
    description: string;
  }>;
}

export type ToolPolicyUpdate = Partial<
  Pick<ToolPolicy, 'level' | 'riskLevel' | 'description' | 'autoApproveIf'>
>;

export async function updateToolPolicy(
  pattern: string,
  updates: ToolPolicyUpdate,
): Promise<{ status: string; policy: ToolPolicy }> {
  const response = await fetch(
    `${API_BASE}/api/approval/policy/${encodeURIComponent(pattern)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    },
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to update tool policy'));
  }
  return response.json() as Promise<{ status: string; policy: ToolPolicy }>;
}

export async function addToolPolicy(
  policy: ToolPolicy,
): Promise<{ status: string; policy: ToolPolicy }> {
  const response = await fetch(`${API_BASE}/api/approval/policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to add tool policy'));
  }
  return response.json() as Promise<{ status: string; policy: ToolPolicy }>;
}

export async function removeToolPolicy(
  pattern: string,
): Promise<{ status: string; pattern: string }> {
  const response = await fetch(
    `${API_BASE}/api/approval/policy/${encodeURIComponent(pattern)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to remove tool policy'));
  }
  return response.json() as Promise<{ status: string; pattern: string }>;
}

export async function fetchApprovalAuditLog(
  limit?: number,
): Promise<{ entries: ApprovalAuditEntry[]; total: number }> {
  const url = new URL(`${API_BASE}/api/approval/audit-log`);
  if (limit) url.searchParams.set('limit', String(limit));
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load approval audit log'));
  }
  return response.json() as Promise<{ entries: ApprovalAuditEntry[]; total: number }>;
}
