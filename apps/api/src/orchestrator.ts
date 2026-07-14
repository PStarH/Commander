/**
 * runAgentStep — Guidance-aware single-step agent execution.
 *
 * Fetches run context and framework guidance, invokes the model with the
 * selected invocation profile, and enforces a write-back matrix: the
 * profile's disposition controls which side-effects (logs, memory, mission
 * patches, agent state) are actually persisted.
 *
 * The multi-agent planning section that used to live in this file
 * (Orchestrator class, createDelegationPlan, assessComplexity) was dead
 * code superseded by Architecture V2 (planWorkGraph → kernel → worker) and
 * was removed; see PRINCIPLES.md §3.
 */

export interface RunAgentStepInput {
  agentId: string;
  missionId: string;
}

export interface RunAgentStepDeps {
  http: {
    fetchJson(url: string): Promise<unknown>;
    tryFetchJson(url: string): Promise<unknown>;
    postJson(url: string, body: unknown): Promise<void>;
    patchJson(url: string, body: unknown): Promise<void>;
  };
  invokeModel(args: { invocationProfile: Record<string, unknown>; context: string }): Promise<{
    summary: string;
    logs?: string[];
    missionPatch?: Record<string, unknown>;
    decisions?: { title: string; content: string }[];
    agentStatePatch?: Record<string, unknown>;
  }>;
}

const WRITE_OPS_MATRIX: Record<string, string[]> = {
  ALLOW_EXECUTION: [
    'WRITE_LOG',
    'WRITE_MEMORY',
    'UPDATE_MISSION_STATUS',
    'UPDATE_MISSION_FIELDS',
    'UPDATE_AGENT_STATE',
  ],
  PROPOSE_ONLY: ['WRITE_LOG', 'WRITE_MEMORY'],
  REQUIRE_APPROVAL: ['WRITE_LOG', 'WRITE_MEMORY'],
  DENY: [],
};

function isOpAllowed(disposition: string, op: string): boolean {
  return (WRITE_OPS_MATRIX[disposition] ?? []).includes(op);
}

/**
 * Execute a single agent step using framework guidance (if available) or
 * falling back to local strategy/profile calculation.
 *
 * Enforces a write-back matrix: the invocation profile's disposition
 * controls which side-effects (logs, memory, mission patches, agent state)
 * are actually persisted.
 */
export async function runAgentStep(
  input: RunAgentStepInput,
  deps: RunAgentStepDeps,
): Promise<string> {
  // 1. Fetch run context
  const runContext = (await deps.http.fetchJson(`/runs/${input.missionId}/context`)) as Record<
    string,
    unknown
  >;
  const embeddedGuidance = (runContext.guidance as Record<string, unknown>) ?? null;

  // 2. Always try guidance endpoint
  const explicitGuidance = (await deps.http.tryFetchJson(
    `/runs/${input.missionId}/guidance`,
  )) as Record<string, unknown> | null;
  const guidance = (explicitGuidance ?? embeddedGuidance) as Record<string, unknown> | null;

  // 3. Determine invocation profile — use guidance only when agentId matches
  let invocationProfile: Record<string, unknown>;
  let strategy: Record<string, unknown>;

  const guidanceProfile = guidance?.invocationProfile as Record<string, unknown> | undefined;
  if (guidanceProfile?.agentId === input.agentId) {
    invocationProfile = guidanceProfile;
    strategy = (guidance?.strategy as Record<string, unknown>) ?? { kind: 'MANUAL_APPROVAL_GATE' };
  } else {
    // Fallback: compute locally
    strategy = (guidance?.strategy as Record<string, unknown>) ?? { kind: 'MANUAL_APPROVAL_GATE' };
    invocationProfile = {
      agentId: input.agentId,
      disposition: 'REQUIRE_APPROVAL',
      intent: 'PROPOSE',
      allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
      forbiddenOperations: [],
    };
  }

  // 4. Build model context
  const contextParts = [
    `strategyKind: ${(strategy as Record<string, unknown>).kind ?? 'unknown'}`,
    `effectiveIntent: ${invocationProfile.intent}`,
    `primaryAgentId: ${invocationProfile.agentId}`,
  ];
  if (runContext.slimSnapshot) {
    contextParts.push(`focusMission: ${input.missionId}`);
  }
  if (invocationProfile.allowedOperations) {
    contextParts.push(
      `allowedOperations: ${(invocationProfile.allowedOperations as string[]).join(', ')}`,
    );
  }
  const context = contextParts.join('\n');

  // 5. Invoke model
  const result = await deps.invokeModel({ invocationProfile, context });

  // 6. Enforce write-back matrix
  const disposition = (invocationProfile.disposition as string) ?? 'PROPOSE_ONLY';
  const projectId = (runContext.projectId as string) ?? 'project-war-room';

  // Logs — WRITE_LOG
  if (isOpAllowed(disposition, 'WRITE_LOG') && result.logs?.length) {
    for (const message of result.logs) {
      await deps.http.postJson(`/missions/${input.missionId}/logs`, { message });
    }
  }

  // Memory — WRITE_MEMORY
  if (isOpAllowed(disposition, 'WRITE_MEMORY') && result.decisions?.length) {
    for (const decision of result.decisions) {
      await deps.http.postJson(`/projects/${projectId}/memory`, {
        title: decision.title,
        content: decision.content,
      });
    }
  }

  // Mission patch — UPDATE_MISSION_STATUS / UPDATE_MISSION_FIELDS
  if (isOpAllowed(disposition, 'UPDATE_MISSION_STATUS') && result.missionPatch) {
    await deps.http.patchJson(`/missions/${input.missionId}`, result.missionPatch);
  }

  // Agent state patch — UPDATE_AGENT_STATE
  if (isOpAllowed(disposition, 'UPDATE_AGENT_STATE') && result.agentStatePatch) {
    await deps.http.patchJson(
      `/projects/${projectId}/agents/${input.agentId}/state`,
      result.agentStatePatch,
    );
  }

  return result.summary;
}
