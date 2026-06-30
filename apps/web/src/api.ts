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
  ComplianceAuditReport,
} from './types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
export const PROJECT_ID = 'project-war-room';

// ============================================================================
// User Authentication — token storage + fetch interceptor
// ============================================================================
//
// Tokens are persisted in localStorage. A global fetch interceptor ensures
// every request carries the `Authorization: Bearer <token>` header when a
// token is present, and clears stale credentials on 401 responses.

const TOKEN_KEY = 'commander.auth.token';
const REFRESH_TOKEN_KEY = 'commander.auth.refreshToken';

/** Dispatched on `window` whenever the auth token changes (login/logout/401). */
export const AUTH_CHANGE_EVENT = 'commander:auth-change';

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthTokens(token: string, refreshToken: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    window.dispatchEvent(new CustomEvent(AUTH_CHANGE_EVENT));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.dispatchEvent(new CustomEvent(AUTH_CHANGE_EVENT));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

/**
 * Installs a global fetch wrapper that:
 *  1. Attaches `Authorization: Bearer <token>` when a token is available.
 *  2. Clears the token and notifies the app when a 401 is received.
 *
 * Called once at module load. Idempotent — safe to call multiple times.
 */
let _interceptorInstalled = false;
function installAuthInterceptor(): void {
  if (_interceptorInstalled) return;
  _interceptorInstalled = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getAuthToken();
    if (token) {
      const headers = new Headers(init?.headers ?? undefined);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      init = { ...init, headers };
    }
    const response = await originalFetch(input, init);
    // Auto-logout on 401 from an authenticated request (token was present).
    if (response.status === 401 && token) {
      clearAuthToken();
    }
    return response;
  };
}
installAuthInterceptor();

// ── Auth API types ──────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export async function fetchLogin(username: string, password: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export async function fetchRegister(
  username: string,
  email: string,
  password: string,
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
}

export async function fetchCurrentUser(): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/api/auth/me');
}

export async function refreshAuthToken(refreshToken: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}

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
          callbacks.onError((parsed.error as string) || 'Stream error from server');
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
  const response = await fetch(`${API_BASE}/api/hallucination/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load hallucination report'));
  }
  return response.json() as Promise<HallucinationReportResponse>;
}

// ============================================================================
// Lineage Tracking — agent provenance tree (GAP-05)
// ============================================================================

export async function fetchLineage(runId: string): Promise<LineageSummaryResponse> {
  const response = await fetch(`${API_BASE}/api/lineage/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load lineage graph'));
  }
  return response.json() as Promise<LineageSummaryResponse>;
}

// ============================================================================
// Security Posture — real compliance report from GET /api/security/posture
// ============================================================================

export async function fetchSecurityPosture(): Promise<ComplianceAuditReport> {
  const response = await fetch(`${API_BASE}/api/security/posture`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to load security posture'));
  }
  return response.json() as Promise<ComplianceAuditReport>;
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

export async function fetchDlqEntries(category?: string, limit?: number): Promise<DlqEntry[]> {
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
  const response = await fetch(`${API_BASE}/api/dlq/replay/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
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
  const response = await fetch(`${API_BASE}/api/approval/policy/${encodeURIComponent(pattern)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
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
  const response = await fetch(`${API_BASE}/api/approval/policy/${encodeURIComponent(pattern)}`, {
    method: 'DELETE',
  });
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

// ============================================================================
// IM Webhook Integration — DingTalk / Feishu / WeCom (Task 1)
// ============================================================================

export type WebhookPlatform = 'dingtalk' | 'feishu' | 'wecom';

export interface IMWebhookConfig {
  id: string;
  platform: WebhookPlatform;
  name: string;
  secret: string;
  agentId: string;
  enabled: boolean;
  createdAt: string;
}

export interface WebhookListResponse {
  webhooks: IMWebhookConfig[];
  total: number;
}

export interface CreateWebhookPayload {
  platform: WebhookPlatform;
  name: string;
  agentId: string;
  secret?: string;
  enabled?: boolean;
}

export async function fetchWebhooks(): Promise<WebhookListResponse> {
  return apiFetch<WebhookListResponse>(`/api/webhook/config`);
}

export async function createWebhook(
  payload: CreateWebhookPayload,
): Promise<{ webhook: IMWebhookConfig }> {
  return apiFetch<{ webhook: IMWebhookConfig }>(`/api/webhook/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function deleteWebhook(id: string): Promise<{ status: string; id: string }> {
  return apiFetch<{ status: string; id: string }>(`/api/webhook/config/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ============================================================================
// Cost Dashboard — enterprise cost analytics (Task 2)
// ============================================================================

export type CostTimeRange = 'today' | '7d' | '30d' | 'all';

export interface CostDashboardSummary {
  totalCostUsd: number;
  todayCostUsd: number;
  averageCostPerTask: number;
  cacheSavingsUsd: number;
  totalTasks: number;
  totalTokens: number;
  totalCalls: number;
  peakCostHour: string | null;
}

export interface ModelCostEntry {
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  costUsd: number;
  percentage: number;
}

export interface ToolCostEntry {
  tool: string;
  calls: number;
  tokens: number;
  costUsd: number;
  percentage: number;
}

export interface UserCostEntry {
  userId: string;
  calls: number;
  costUsd: number;
  percentage: number;
}

export interface TrendPoint {
  timestamp: string;
  cost: number;
  tokens: number;
}

export interface CostDashboardResponse {
  timeRange: CostTimeRange;
  summary: CostDashboardSummary;
  byModel: ModelCostEntry[];
  byTool: ToolCostEntry[];
  byUser: UserCostEntry[];
  trend: TrendPoint[];
}

export async function fetchCostDashboard(
  timeRange: CostTimeRange = '7d',
): Promise<CostDashboardResponse> {
  return apiFetch<CostDashboardResponse>(
    `/api/cost/dashboard?timeRange=${encodeURIComponent(timeRange)}`,
  );
}

// ============================================================================
// Unified Audit Log — cross-source query/export/stats (Task 3)
// ============================================================================
//
// Aggregates three previously-scattered audit producers (security events,
// approval decisions, action rationale) behind a single query interface so
// operators can trace accountability end-to-end.

export type AuditSource = 'security' | 'approval' | 'action';
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  source: AuditSource;
  eventType: string;
  severity: AuditSeverity;
  userId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AuditLogQuery {
  source?: string;
  severity?: string;
  eventType?: string;
  startTime?: string;
  endTime?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogsResponse {
  logs: AuditLogEntry[];
  total: number;
  sources: AuditSource[];
}

export interface AuditStats {
  totalEvents: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  byEventType: Record<string, number>;
  timeRange: { earliest: string | null; latest: string | null };
}

export interface AuditSourceInfo {
  source: AuditSource;
  description: string;
  eventCount: number;
  lastEvent: string | null;
}

function buildAuditQueryParams(query: AuditLogQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.source) params.set('source', query.source);
  if (query.severity) params.set('severity', query.severity);
  if (query.eventType) params.set('eventType', query.eventType);
  if (query.startTime) params.set('startTime', query.startTime);
  if (query.endTime) params.set('endTime', query.endTime);
  if (query.userId) params.set('userId', query.userId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  return params;
}

export async function fetchAuditLogs(query: AuditLogQuery = {}): Promise<AuditLogsResponse> {
  const params = buildAuditQueryParams(query);
  return apiFetch<AuditLogsResponse>(`/api/audit/logs?${params.toString()}`);
}

export async function fetchAuditStats(): Promise<AuditStats> {
  return apiFetch<AuditStats>(`/api/audit/stats`);
}

export async function fetchAuditSources(): Promise<AuditSourceInfo[]> {
  return apiFetch<AuditSourceInfo[]>(`/api/audit/sources`);
}

/**
 * Triggers a JSON file download of the filtered audit logs. Returns a Blob
 * so the caller can surface a browser download (or parse it in-memory).
 */
export async function exportAuditLogs(query: AuditLogQuery = {}): Promise<Blob> {
  const params = buildAuditQueryParams(query);
  const response = await fetch(`${API_BASE}/api/audit/logs/export?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to export audit logs'));
  }
  return response.blob();
}

// ============================================================================
// Unified Audit Log v2 — /api/audit-logs* (category-based, cross-source)
// ============================================================================
//
// Backs the redesigned Audit Log page. Aggregates security / approval /
// execution / user-action / configuration audit producers behind a single
// category-based query interface with stats, export, and a filter catalog.
// Distinct from the legacy /api/audit/* functions above (which use a
// `source` field); these use `category` + `severity: info|warn|error|critical`.

export type UnifiedAuditCategory =
  | 'security'
  | 'approval'
  | 'execution'
  | 'configuration'
  | 'user_action';

export type UnifiedAuditSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface UnifiedAuditEntry {
  id: string;
  timestamp: string;
  category: UnifiedAuditCategory;
  eventType: string;
  severity: UnifiedAuditSeverity;
  userId?: string;
  tenantId?: string;
  runId?: string;
  agentId?: string;
  toolName?: string;
  message: string;
  details?: Record<string, unknown>;
  source: string;
}

export interface UnifiedAuditQuery {
  category?: UnifiedAuditCategory[];
  eventType?: string[];
  severity?: UnifiedAuditSeverity[];
  userId?: string;
  runId?: string;
  agentId?: string;
  toolName?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

export interface UnifiedAuditLogsResponse {
  entries: UnifiedAuditEntry[];
  total: number;
  hasMore: boolean;
}

export interface UnifiedAuditTimelinePoint {
  bucket: string;
  count: number;
}

export interface UnifiedAuditStats {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  timeline: UnifiedAuditTimelinePoint[];
  topEventTypes: Array<{ eventType: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  timeRange: { earliest: string | null; latest: string | null };
}

export interface UnifiedAuditCatalog {
  categories: { value: UnifiedAuditCategory; label: string }[];
  severities: { value: UnifiedAuditSeverity; label: string }[];
  eventTypes: { category: UnifiedAuditCategory; eventType: string }[];
}

function buildUnifiedAuditParams(query: UnifiedAuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.category && query.category.length > 0) {
    params.set('category', query.category.join(','));
  }
  if (query.eventType && query.eventType.length > 0) {
    params.set('eventType', query.eventType.join(','));
  }
  if (query.severity && query.severity.length > 0) {
    params.set('severity', query.severity.join(','));
  }
  if (query.userId) params.set('userId', query.userId);
  if (query.runId) params.set('runId', query.runId);
  if (query.agentId) params.set('agentId', query.agentId);
  if (query.toolName) params.set('toolName', query.toolName);
  if (query.startTime) params.set('startTime', query.startTime);
  if (query.endTime) params.set('endTime', query.endTime);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  return params;
}

export async function fetchUnifiedAuditLogs(
  query: UnifiedAuditQuery = {},
): Promise<UnifiedAuditLogsResponse> {
  const params = buildUnifiedAuditParams(query);
  return apiFetch<UnifiedAuditLogsResponse>(`/api/audit-logs?${params.toString()}`);
}

export async function fetchUnifiedAuditStats(
  query: { startTime?: string; endTime?: string } = {},
): Promise<UnifiedAuditStats> {
  const params = new URLSearchParams();
  if (query.startTime) params.set('startTime', query.startTime);
  if (query.endTime) params.set('endTime', query.endTime);
  return apiFetch<UnifiedAuditStats>(`/api/audit-logs/stats?${params.toString()}`);
}

export async function fetchUnifiedAuditCategories(): Promise<UnifiedAuditCatalog> {
  return apiFetch<UnifiedAuditCatalog>('/api/audit-logs/categories');
}

/**
 * Downloads the filtered audit trail as JSON or CSV. Returns a Blob so the
 * caller can trigger a browser download or parse it in-memory.
 */
export async function exportUnifiedAuditLogs(
  query: UnifiedAuditQuery = {},
  format: 'json' | 'csv' = 'json',
): Promise<Blob> {
  const params = buildUnifiedAuditParams(query);
  params.set('format', format);
  const response = await fetch(`${API_BASE}/api/audit-logs/export?${params.toString()}`);
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to export audit logs'));
  }
  return response.blob();
}

// ============================================================================
// Knowledge Base / RAG — enterprise document retrieval (Task 3)
// ============================================================================
//
// Lets an Agent (or operator) upload internal company docs, chunk + embed them,
// and run semantic search so retrieved context can be injected into LLM prompts.
// Backed by `.commander/knowledge-base/` on the API server.

export type KnowledgeContentType =
  | 'text/plain'
  | 'application/json'
  | 'text/markdown'
  | 'text/html';

export type KnowledgeDocumentStatus = 'ready' | 'indexing' | 'failed';

export interface KnowledgeDocument {
  id: string;
  name: string;
  type: KnowledgeContentType;
  size: number;
  chunks: number;
  status: KnowledgeDocumentStatus;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  error?: string;
}

export interface KnowledgeDocumentListResponse {
  documents: KnowledgeDocument[];
  total: number;
  page: number;
  limit: number;
}

export interface KnowledgeSearchResult {
  chunkId: string;
  docId: string;
  docName: string;
  chunkIndex: number;
  offset: number;
  text: string;
  /** Cosine similarity score; higher is more relevant. */
  score: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  results: KnowledgeSearchResult[];
  count: number;
}

export interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  embeddingDimension: number;
  byType: Record<string, number>;
}

export interface KnowledgeRagContext {
  query: string;
  context: string;
  chunks: KnowledgeSearchResult[];
  topK: number;
}

export async function fetchKnowledgeDocuments(
  page = 1,
  limit = 20,
): Promise<KnowledgeDocumentListResponse> {
  return apiFetch<KnowledgeDocumentListResponse>(
    `/api/knowledge/documents?page=${page}&limit=${limit}`,
  );
}

export async function fetchKnowledgeDocument(id: string): Promise<{ document: KnowledgeDocument }> {
  return apiFetch<{ document: KnowledgeDocument }>(
    `/api/knowledge/documents/${encodeURIComponent(id)}`,
  );
}

export async function uploadKnowledgeDocument(
  content: string,
  name: string,
  type: string,
  tags?: string[],
): Promise<KnowledgeDocument> {
  const response = await fetch(`${API_BASE}/api/knowledge/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, name, type, tags }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to upload knowledge document'));
  }
  const data = (await response.json()) as { document: KnowledgeDocument };
  return data.document;
}

export async function deleteKnowledgeDocument(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/knowledge/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to delete knowledge document'));
  }
}

export async function searchKnowledge(
  query: string,
  topK = 5,
  docIds?: string[],
): Promise<KnowledgeSearchResult[]> {
  const response = await fetch(`${API_BASE}/api/knowledge/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, docIds }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to search knowledge base'));
  }
  const data = (await response.json()) as KnowledgeSearchResponse;
  return data.results;
}

export async function fetchKnowledgeStats(): Promise<KnowledgeStats> {
  return apiFetch<KnowledgeStats>(`/api/knowledge/stats`);
}

export async function queryKnowledgeRag(
  query: string,
  topK = 5,
  docIds?: string[],
): Promise<KnowledgeRagContext> {
  const response = await fetch(`${API_BASE}/api/knowledge/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, docIds }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to run RAG query'));
  }
  return (await response.json()) as KnowledgeRagContext;
}

// ============================================================================
// RAG Plugin control plane (/api/knowledge-base/*)
// ============================================================================
//
// These functions target the built-in `builtin-rag` CommanderPlugin surface:
// the data plane (upload/list/delete/search against the core KnowledgeBaseStore)
// and the control plane (plugin enable/disable + status). They are separate
// from the /api/knowledge/* functions above so the two surfaces can evolve
// independently. The plugin-status card in the KnowledgeBase page uses these.

export interface KbDocumentMeta {
  id: string;
  filename: string;
  chunks: number;
  uploadedAt: string;
  source?: string;
  size: number;
}

export interface KbSearchResult {
  content: string;
  source: string;
  /** Cosine similarity score; higher is more relevant. */
  score: number;
  docId: string;
  chunkId: string;
}

export interface KbStatus {
  plugin: string;
  registered: boolean;
  enabled: boolean;
  documentCount: number;
  vectorCount: number;
  embedding: string;
  embeddingDimension: number;
  documents: KbDocumentMeta[];
}

export interface KbUploadResponse {
  documentId: string;
  chunksIndexed: number;
}

export interface KbSearchResponse {
  query: string;
  results: KbSearchResult[];
  count: number;
}

/** Fetch RAG plugin status: enabled flag + document/vector counts. */
export async function fetchKbStatus(): Promise<KbStatus> {
  return apiFetch<KbStatus>('/api/knowledge-base/status');
}

/** Upload (ingest) a document into the RAG knowledge base. */
export async function uploadKbDocument(
  filename: string,
  content: string,
  source?: string,
): Promise<KbUploadResponse> {
  const response = await fetch(`${API_BASE}/api/knowledge-base/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content, source }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to upload knowledge-base document'));
  }
  return (await response.json()) as KbUploadResponse;
}

/** List all documents in the RAG knowledge base. */
export async function fetchKbDocuments(): Promise<KbDocumentMeta[]> {
  const data = await apiFetch<{ documents: KbDocumentMeta[]; count: number }>(
    '/api/knowledge-base/documents',
  );
  return data.documents;
}

/** Delete a document (and its chunks) from the RAG knowledge base. */
export async function deleteKbDocument(id: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/api/knowledge-base/documents/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to delete knowledge-base document'));
  }
}

/** Manual retrieval test against the RAG knowledge base. */
export async function searchKb(query: string, topK?: number): Promise<KbSearchResult[]> {
  const response = await fetch(`${API_BASE}/api/knowledge-base/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK }),
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to search knowledge base'));
  }
  const data = (await response.json()) as KbSearchResponse;
  return data.results;
}

/** Enable the built-in RAG plugin (activates beforeLLMCall auto-inject + tool). */
export async function enableRagPlugin(): Promise<{ enabled: boolean }> {
  const response = await fetch(`${API_BASE}/api/knowledge-base/enable`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to enable RAG plugin'));
  }
  return (await response.json()) as { enabled: boolean };
}

/** Disable the built-in RAG plugin. */
export async function disableRagPlugin(): Promise<{ enabled: boolean }> {
  const response = await fetch(`${API_BASE}/api/knowledge-base/disable`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await readError(response, 'Failed to disable RAG plugin'));
  }
  return (await response.json()) as { enabled: boolean };
}

// ============================================================================
// Onboarding Wizard — Web 端上手引导向导 (POC→生产 鸿沟修复)
// ============================================================================
//
// 调研发现 93% 企业 Agent 项目卡在 POC→生产，上手体验是关键。CLI 端已有
// quickstart，Web 端此前完全缺失引导。以下 API 支撑新用户首次登录后的
// 多步骤向导（provider 配置 → 首个任务 → 完成）。

export type OnboardingProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'ollama'
  | 'openrouter';

export interface OnboardingStatus {
  hasProvider: boolean;
  hasApiKey: boolean;
  provider: OnboardingProvider | string | null;
  providerLabel: string | null;
  model: string | null;
  hasRunTask: boolean;
  hasKnowledge: boolean;
  completedSteps: string[];
  isComplete: boolean;
}

export interface OnboardingProviderTestResult {
  success: boolean;
  latency: number;
  provider: OnboardingProvider | string | null;
  model: string | null;
  error?: string;
}

export interface OnboardingSaveConfigPayload {
  provider: OnboardingProvider;
  model: string;
  apiKey?: string;
}

export interface OnboardingFirstTaskResult {
  success: boolean;
  result?: string;
  error?: string;
  provider?: string;
  model?: string;
}

export interface OnboardingCompleteResult {
  success: boolean;
  completedAt?: string;
}

export async function fetchOnboardingStatus(): Promise<OnboardingStatus> {
  return apiFetch<OnboardingStatus>(`/api/onboarding/status`);
}

export async function testProvider(
  provider?: OnboardingProvider,
  model?: string,
  apiKey?: string,
): Promise<OnboardingProviderTestResult> {
  const body: Record<string, unknown> = {};
  if (provider) body.provider = provider;
  if (model) body.model = model;
  if (apiKey) body.apiKey = apiKey;
  return apiFetch<OnboardingProviderTestResult>(`/api/onboarding/test-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function saveOnboardingConfig(
  config: OnboardingSaveConfigPayload,
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/onboarding/save-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function runFirstTask(task: string): Promise<OnboardingFirstTaskResult> {
  return apiFetch<OnboardingFirstTaskResult>(`/api/onboarding/run-first-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  });
}

export async function completeOnboarding(steps?: string[]): Promise<OnboardingCompleteResult> {
  const body: Record<string, unknown> = {};
  if (steps) body.steps = steps;
  return apiFetch<OnboardingCompleteResult>(`/api/onboarding/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Sample tasks (供向导展示的示例任务) ──────────────────────────────────────

export interface OnboardingSampleTask {
  id: string;
  title: string;
  description: string;
  prompt: string;
}

export interface OnboardingSampleTasksResponse {
  tasks: OnboardingSampleTask[];
}

/**
 * 获取示例任务列表。
 * 失败时返回空数组，不阻塞向导流程（向导内部有 fallback 任务）。
 */
export async function fetchSampleTasks(): Promise<OnboardingSampleTask[]> {
  try {
    const data = await apiFetch<OnboardingSampleTasksResponse>(`/api/onboarding/sample-tasks`);
    return data.tasks ?? [];
  } catch {
    return [];
  }
}

// ============================================================================
// Eval / Reporting / Consensus plugin control (builtin plugins)
// ============================================================================

export interface PluginStatus {
  plugin: string;
  registered: boolean;
  enabled: boolean;
  [key: string]: unknown;
}

export async function fetchEvalStatus(): Promise<PluginStatus> {
  return apiFetch<PluginStatus>('/api/eval/status');
}
export async function enableEvalPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/eval/enable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to enable eval plugin'));
  return res.json();
}
export async function disableEvalPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/eval/disable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to disable eval plugin'));
  return res.json();
}

export async function fetchReportingStatus(): Promise<PluginStatus> {
  return apiFetch<PluginStatus>('/api/reporting/status');
}
export async function enableReportingPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/reporting/enable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to enable reporting plugin'));
  return res.json();
}
export async function disableReportingPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/reporting/disable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to disable reporting plugin'));
  return res.json();
}

export async function fetchConsensusStatus(): Promise<PluginStatus> {
  return apiFetch<PluginStatus>('/api/consensus/status');
}
export async function enableConsensusPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/consensus/enable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to enable consensus plugin'));
  return res.json();
}
export async function disableConsensusPlugin(): Promise<{ enabled: boolean }> {
  const res = await fetch(`${API_BASE}/api/consensus/disable`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Failed to disable consensus plugin'));
  return res.json();
}

