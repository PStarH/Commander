const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
  createSlimSnapshot,
  recommendStrategy,
  getDefaultInvocationProfile,
} = require('../../../packages/core/dist/index.js');
const { runAgentStep } = require('../dist/orchestrator.js');

function createRunContext({ includeGuidance = true, missionId = 'mission-api-spine', requestedAgentId = 'agent-builder' } = {}) {
  const now = new Date('2026-03-24T00:00:00.000Z');
  const data = createSeedWarRoomData(now);
  const snapshot = getProjectWarRoomSnapshot(data, 'project-war-room', now);
  assert.ok(snapshot, 'seed snapshot should exist');

  const slimSnapshot = createSlimSnapshot(snapshot, {
    focusMissionId: missionId,
    maxMissionsPerBucket: 6,
    maxLogs: 8,
  });

  const focusMission = slimSnapshot.focusMission;
  assert.ok(focusMission, 'focus mission should exist');

  const agentRoster = data.agents.map(agent => ({
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    callsign: agent.callsign,
    status: agent.status,
    specialty: agent.specialty,
    governanceRole: agent.governanceRole,
    model: agent.model,
    role: agent.role,
  }));

  const baseContext = {
    projectId: 'project-war-room',
    run: {
      runId: 'test-run',
      issuedAt: now.toISOString(),
    },
    focus: {
      missionId,
      agentId: requestedAgentId,
      intent: 'EXECUTE',
    },
    slimSnapshot,
    recentMemory: [],
    recommendedMemory: { items: [], sourceTags: ['test'] },
    agentRoster,
  };

  if (!includeGuidance) {
    return baseContext;
  }

  const requestedAgent = agentRoster.find(agent => agent.id === requestedAgentId);
  assert.ok(requestedAgent, 'requested agent should exist');

  return {
    ...baseContext,
    guidance: {
      strategy: recommendStrategy(baseContext),
      invocationProfile: getDefaultInvocationProfile({
        agent: requestedAgent,
        mission: focusMission,
        intent: 'EXECUTE',
      }),
    },
  };
}

function createDeps(runContext, invokeModelImpl) {
  const calls = {
    fetchJson: [],
    tryFetchJson: [],
    postJson: [],
    patchJson: [],
  };

  return {
    calls,
    deps: {
      http: {
        async fetchJson(url) {
          calls.fetchJson.push(url);
          return runContext;
        },
        async tryFetchJson(url) {
          calls.tryFetchJson.push(url);
          return null;
        },
        async postJson(url, body) {
          calls.postJson.push({ url, body });
        },
        async patchJson(url, body) {
          calls.patchJson.push({ url, body });
        },
      },
      invokeModel: invokeModelImpl,
    },
  };
}

test('runAgentStep prefers framework guidance when run-context provides it', async () => {
  const runContext = createRunContext({ includeGuidance: true });
  const { calls, deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.agentId, 'agent-builder');
    assert.equal(args.invocationProfile.disposition, 'REQUIRE_APPROVAL');
    assert.equal(args.invocationProfile.intent, 'PROPOSE');
    assert.match(args.context, /strategyKind: MANUAL_APPROVAL_GATE/);
    assert.match(args.context, /effectiveIntent: PROPOSE/);
    assert.match(args.context, /primaryAgentId: agent-builder/);
    return {
      summary: 'used guidance',
      logs: ['request approval before execution'],
      missionPatch: { status: 'DONE', objective: 'should be ignored without permissions' },
      decisions: [{ title: 'should not persist', content: 'write blocked' }],
      agentStatePatch: { summary: 'waiting for approval' },
    };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-builder', missionId: 'mission-api-spine' },
    deps
  );

  assert.equal(summary, 'used guidance');
  assert.equal(calls.fetchJson.length, 1);
  assert.equal(calls.tryFetchJson.length, 1);
  assert.equal(calls.postJson.length, 2, 'manual proposal profile may still write logs and memory');
  assert.match(calls.postJson[0].url, /\/missions\/mission-api-spine\/logs$/);
  assert.equal(calls.postJson[0].body.message, 'request approval before execution');
  assert.match(calls.postJson[1].url, /\/projects\/project-war-room\/memory$/);
  assert.equal(calls.postJson[1].body.title, 'should not persist');
  assert.equal(calls.patchJson.length, 0, 'manual proposal profile should not patch mission or agent state');
});

test('runAgentStep falls back to local strategy/profile calculation when guidance is absent', async () => {
  const runContext = createRunContext({ includeGuidance: false });
  const { calls, deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.agentId, 'agent-builder');
    assert.equal(args.invocationProfile.disposition, 'REQUIRE_APPROVAL');
    assert.equal(args.invocationProfile.intent, 'PROPOSE');
    assert.match(args.context, /strategyKind: MANUAL_APPROVAL_GATE/);
    assert.match(args.context, /effectiveIntent: PROPOSE/);
    return {
      summary: 'used fallback',
    };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-builder', missionId: 'mission-api-spine' },
    deps
  );

  assert.equal(summary, 'used fallback');
  assert.equal(calls.fetchJson.length, 1);
  assert.equal(calls.tryFetchJson.length, 1);
  assert.equal(calls.postJson.length, 0);
  assert.equal(calls.patchJson.length, 0);
});

test('runAgentStep uses guidance invocation profile only when it matches the executor agent', async () => {
  const runContext = createRunContext({ includeGuidance: true });
  runContext.guidance.invocationProfile = {
    ...runContext.guidance.invocationProfile,
    agentId: 'agent-scout',
    disposition: 'ALLOW_EXECUTION',
    intent: 'EXECUTE',
    allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'UPDATE_MISSION_STATUS', 'UPDATE_MISSION_FIELDS'],
    forbiddenOperations: [],
    rationale: ['mismatched profile should be ignored'],
  };

  const { deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.agentId, 'agent-builder');
    assert.equal(args.invocationProfile.disposition, 'REQUIRE_APPROVAL');
    assert.equal(args.invocationProfile.intent, 'PROPOSE');
    assert.match(args.context, /effectiveIntent: PROPOSE/);
    return { summary: 'ignored mismatched profile' };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-builder', missionId: 'mission-api-spine' },
    deps
  );

  assert.equal(summary, 'ignored mismatched profile');
});

test('runAgentStep write-back matrix allows all side effects for ALLOW_EXECUTION profiles', async () => {
  const runContext = createRunContext({
    includeGuidance: true,
    missionId: 'mission-dashboard',
    requestedAgentId: 'agent-scout',
  });

  runContext.guidance.invocationProfile = {
    ...runContext.guidance.invocationProfile,
    agentId: 'agent-scout',
    missionId: 'mission-dashboard',
    disposition: 'ALLOW_EXECUTION',
    intent: 'EXECUTE',
    allowedOperations: [
      'READ_CONTEXT',
      'WRITE_LOG',
      'UPDATE_MISSION_STATUS',
      'UPDATE_MISSION_FIELDS',
      'WRITE_MEMORY',
      'UPDATE_AGENT_STATE',
    ],
    forbiddenOperations: ['REQUEST_APPROVAL'],
    approval: { required: false, requiredRoles: [], minApprovals: 0 },
    rationale: ['full execution rights for guarded mission'],
  };

  const { calls, deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.disposition, 'ALLOW_EXECUTION');
    assert.equal(args.invocationProfile.intent, 'EXECUTE');
    assert.match(args.context, /effectiveIntent: EXECUTE/);
    return {
      summary: 'executed with full write-back rights',
      logs: ['dashboard mission progressing'],
      missionPatch: { status: 'DONE', objective: 'Ship dashboard polishing pass' },
      decisions: [{ title: 'Dashboard rollout note', content: 'Persist the guarded execution outcome.' }],
      agentStatePatch: { summary: 'dashboard shipped', tags: ['dashboard', 'done'] },
    };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-scout', missionId: 'mission-dashboard' },
    deps
  );

  assert.equal(summary, 'executed with full write-back rights');
  assert.equal(calls.patchJson.length, 2, 'allow-execution should patch mission and agent state');
  assert.match(calls.patchJson[0].url, /\/missions\/mission-dashboard$/);
  assert.deepEqual(calls.patchJson[0].body, {
    status: 'DONE',
    objective: 'Ship dashboard polishing pass',
  });
  assert.match(calls.patchJson[1].url, /\/projects\/project-war-room\/agents\/agent-scout\/state$/);
  assert.deepEqual(calls.patchJson[1].body, {
    summary: 'dashboard shipped',
    tags: ['dashboard', 'done'],
  });
  assert.equal(calls.postJson.length, 2, 'allow-execution should still write logs and memory');
  assert.match(calls.postJson[0].url, /\/missions\/mission-dashboard\/logs$/);
  assert.match(calls.postJson[1].url, /\/projects\/project-war-room\/memory$/);
});

test('runAgentStep write-back matrix restricts PROPOSE_ONLY profiles to logs and memory only', async () => {
  const runContext = createRunContext({ includeGuidance: true });
  runContext.guidance.invocationProfile = {
    ...runContext.guidance.invocationProfile,
    agentId: 'agent-builder',
    missionId: 'mission-api-spine',
    disposition: 'PROPOSE_ONLY',
    intent: 'PROPOSE',
    allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY'],
    forbiddenOperations: [
      'UPDATE_MISSION_STATUS',
      'UPDATE_MISSION_FIELDS',
      'UPDATE_AGENT_STATE',
      'REQUEST_APPROVAL',
    ],
    approval: { required: false, requiredRoles: [], minApprovals: 0 },
    rationale: ['proposal mode only'],
  };

  const { calls, deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.disposition, 'PROPOSE_ONLY');
    assert.equal(args.invocationProfile.intent, 'PROPOSE');
    return {
      summary: 'proposal captured',
      logs: ['captured proposal without execution rights'],
      missionPatch: { status: 'DONE', objective: 'should be ignored in propose-only mode' },
      decisions: [{ title: 'Proposal memory', content: 'Safe to persist as memory.' }],
      agentStatePatch: { summary: 'should not patch state' },
    };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-builder', missionId: 'mission-api-spine' },
    deps
  );

  assert.equal(summary, 'proposal captured');
  assert.equal(calls.postJson.length, 2, 'propose-only should write logs and memory');
  assert.match(calls.postJson[0].url, /\/missions\/mission-api-spine\/logs$/);
  assert.match(calls.postJson[1].url, /\/projects\/project-war-room\/memory$/);
  assert.equal(calls.patchJson.length, 0, 'propose-only should not patch mission or agent state');
});

test('runAgentStep write-back matrix denies all write-backs for DENY profiles', async () => {
  const runContext = createRunContext({ includeGuidance: true });
  runContext.guidance.invocationProfile = {
    ...runContext.guidance.invocationProfile,
    agentId: 'agent-builder',
    missionId: 'mission-api-spine',
    disposition: 'DENY',
    intent: 'EXECUTE',
    allowedOperations: ['READ_CONTEXT'],
    forbiddenOperations: [
      'WRITE_LOG',
      'UPDATE_MISSION_STATUS',
      'UPDATE_MISSION_FIELDS',
      'WRITE_MEMORY',
      'UPDATE_AGENT_STATE',
      'REQUEST_APPROVAL',
    ],
    approval: { required: true, requiredRoles: ['COMMANDER'], minApprovals: 1 },
    rationale: ['deny all write-backs'],
  };

  const { calls, deps } = createDeps(runContext, async args => {
    assert.equal(args.invocationProfile.disposition, 'DENY');
    assert.match(args.context, /allowedOperations: READ_CONTEXT/);
    return {
      summary: 'denied execution',
      logs: ['should not be written'],
      missionPatch: { status: 'DONE', objective: 'should not patch mission' },
      decisions: [{ title: 'Denied memory', content: 'should not persist' }],
      agentStatePatch: { summary: 'should not patch state' },
    };
  });

  const summary = await runAgentStep(
    { agentId: 'agent-builder', missionId: 'mission-api-spine' },
    deps
  );

  assert.equal(summary, 'denied execution');
  assert.equal(calls.postJson.length, 0, 'deny should suppress logs and memory');
  assert.equal(calls.patchJson.length, 0, 'deny should suppress mission and agent state patches');
});
