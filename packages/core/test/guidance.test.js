const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
  createSlimSnapshot,
  getDefaultInvocationProfile,
  recommendStrategy,
} = require('../dist/index.js');

function createContext({ missionId, agentId, intent = 'EXECUTE' } = {}) {
  const data = createSeedWarRoomData(new Date('2026-03-23T15:00:00.000Z'));
  const snapshot = getProjectWarRoomSnapshot(data, 'project-war-room', new Date('2026-03-23T15:00:00.000Z'));
  assert.ok(snapshot, 'seed snapshot should exist');

  const slimSnapshot = createSlimSnapshot(snapshot, {
    focusMissionId: missionId,
    maxMissionsPerBucket: 6,
    maxLogs: 8,
  });

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

  return {
    projectId: 'project-war-room',
    run: {
      runId: 'test-run',
      issuedAt: '2026-03-23T15:00:00.000Z',
    },
    focus: { missionId, agentId, intent },
    slimSnapshot,
    recentMemory: [],
    recommendedMemory: { items: [], sourceTags: ['test'] },
    agentRoster,
  };
}

test('recommendStrategy returns MANUAL_APPROVAL_GATE for manual governance missions', () => {
  const context = createContext({
    missionId: 'mission-api-spine',
    agentId: 'agent-builder',
    intent: 'EXECUTE',
  });

  const strategy = recommendStrategy(context);
  assert.equal(strategy.kind, 'MANUAL_APPROVAL_GATE');
  assert.deepEqual(strategy.executorAgentIds, ['agent-builder']);
  assert.equal(strategy.approval.required, true);
  assert.ok(strategy.reviewerAgentIds.includes('agent-scout'));
});

test('getDefaultInvocationProfile requires approval for manual high-risk execution', () => {
  const context = createContext({
    missionId: 'mission-api-spine',
    agentId: 'agent-builder',
    intent: 'EXECUTE',
  });

  const agent = context.agentRoster.find(item => item.id === 'agent-builder');
  const mission = context.slimSnapshot.focusMission;
  assert.ok(agent);
  assert.ok(mission);

  const profile = getDefaultInvocationProfile({
    agent,
    mission,
    intent: 'EXECUTE',
  });

  assert.equal(profile.disposition, 'REQUIRE_APPROVAL');
  assert.equal(profile.intent, 'PROPOSE');
  assert.ok(profile.allowedOperations.includes('REQUEST_APPROVAL'));
  assert.ok(profile.forbiddenOperations.includes('UPDATE_MISSION_STATUS'));
});

test('recommendStrategy returns GUARDED_EXECUTION for guarded missions', () => {
  const context = createContext({
    missionId: 'mission-dashboard',
    agentId: 'agent-scout',
    intent: 'EXECUTE',
  });

  const strategy = recommendStrategy(context);
  assert.equal(strategy.kind, 'GUARDED_EXECUTION');
  assert.equal(strategy.primaryAgentId, 'agent-scout');
  assert.ok(strategy.reviewerAgentIds.length >= 1);
});

test('recommendStrategy falls back to SINGLE_AGENT without a focus mission', () => {
  const context = createContext({
    agentId: 'agent-builder',
    intent: 'PLAN',
  });

  const strategy = recommendStrategy(context);
  assert.equal(strategy.kind, 'SINGLE_AGENT');
  assert.equal(strategy.primaryAgentId, 'agent-builder');
  assert.deepEqual(strategy.reviewerAgentIds, []);
});

test('recommendStrategy falls back to first available executor when preferred agent is offline or missing', () => {
  const context = createContext({
    missionId: 'mission-dashboard',
    agentId: 'agent-missing',
    intent: 'EXECUTE',
  });

  const strategy = recommendStrategy(context);
  assert.equal(strategy.kind, 'GUARDED_EXECUTION');
  assert.equal(strategy.primaryAgentId, 'agent-builder');
  assert.ok(strategy.executorAgentIds.includes('agent-builder'));
});

test('getDefaultInvocationProfile returns PROPOSE_ONLY when no mission is bound', () => {
  const context = createContext({
    agentId: 'agent-builder',
    intent: 'PLAN',
  });

  const agent = context.agentRoster.find(item => item.id === 'agent-builder');
  assert.ok(agent);

  const profile = getDefaultInvocationProfile({
    agent,
    intent: 'PLAN',
  });

  assert.equal(profile.disposition, 'PROPOSE_ONLY');
  assert.equal(profile.intent, 'PLAN');
  assert.ok(profile.allowedOperations.includes('READ_CONTEXT'));
  assert.ok(profile.allowedOperations.includes('WRITE_MEMORY'));
  assert.ok(profile.forbiddenOperations.includes('UPDATE_MISSION_FIELDS'));
});
