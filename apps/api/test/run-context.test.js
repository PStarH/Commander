const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const apiDir = path.resolve(__dirname, '..');
const port = 4311;
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;

async function waitForServer(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('API server did not become healthy in time');
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});

  await waitForServer(baseUrl);
});

test.after(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
  }
});

test('run-context returns guidance for manual approval missions', async () => {
  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-builder&missionId=mission-api-spine&intent=EXECUTE&memoryLimit=8`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.focus.intent, 'EXECUTE');
  assert.equal(body.guidance.strategy.kind, 'MANUAL_APPROVAL_GATE');
  assert.equal(body.guidance.strategy.primaryAgentId, 'agent-builder');
  assert.ok(body.guidance.strategy.reviewerAgentIds.includes('agent-scout'));
  assert.equal(body.guidance.invocationProfile.agentId, 'agent-builder');
  assert.equal(body.guidance.invocationProfile.disposition, 'REQUIRE_APPROVAL');
  assert.equal(body.guidance.invocationProfile.intent, 'PROPOSE');
  assert.ok(body.guidance.invocationProfile.allowedOperations.includes('REQUEST_APPROVAL'));
});

test('run-context returns guarded execution guidance for guarded missions', async () => {
  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-scout&missionId=mission-dashboard&intent=EXECUTE&memoryLimit=8`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.guidance.strategy.kind, 'GUARDED_EXECUTION');
  assert.equal(body.guidance.strategy.primaryAgentId, 'agent-scout');
  assert.ok(Array.isArray(body.guidance.strategy.reviewerAgentIds));
  assert.ok(body.guidance.strategy.reviewerAgentIds.length >= 1);
  assert.equal(body.guidance.invocationProfile.disposition, 'ALLOW_EXECUTION');
  assert.equal(body.guidance.invocationProfile.intent, 'EXECUTE');
  assert.ok(body.guidance.invocationProfile.allowedOperations.includes('UPDATE_MISSION_STATUS'));
});

test('run-context falls back to single-agent guidance when no mission is focused', async () => {
  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-builder&intent=PLAN&memoryLimit=5`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.focus.intent, 'PLAN');
  assert.equal(body.guidance.strategy.kind, 'SINGLE_AGENT');
  assert.equal(body.guidance.strategy.primaryAgentId, 'agent-builder');
  assert.deepEqual(body.guidance.strategy.reviewerAgentIds, []);
  assert.equal(body.guidance.invocationProfile.agentId, 'agent-builder');
  assert.equal(body.guidance.invocationProfile.disposition, 'PROPOSE_ONLY');
  assert.equal(body.guidance.invocationProfile.intent, 'PLAN');
  assert.deepEqual(body.recommendedMemory.sourceTags, ['recent']);
});

test('run-context mission-scopes recommendedMemory when matching memory exists', async () => {
  const createResponse = await fetch(`${baseUrl}/projects/project-war-room/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'API spine note',
      content: 'Mission-specific memory for run-context selection.',
      kind: 'LESSON',
      missionId: 'mission-api-spine',
      agentId: 'agent-builder',
      tags: ['api', 'spine'],
    }),
  });
  assert.equal(createResponse.status, 201);

  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-builder&missionId=mission-api-spine&intent=EXECUTE&memoryLimit=8`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(Array.isArray(body.recommendedMemory.items));
  assert.ok(body.recommendedMemory.items.length >= 1);
  assert.equal(body.recommendedMemory.sourceTags[0], 'mission-scoped');
  assert.ok(body.recommendedMemory.items.every(item => item.missionId === 'mission-api-spine'));
});

test('run-context falls back to recent recommendedMemory when mission-scoped memory is absent', async () => {
  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-builder&missionId=mission-dashboard&intent=EXECUTE&memoryLimit=8`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(Array.isArray(body.recommendedMemory.items));
  assert.ok(body.recommendedMemory.items.length >= 1);
  assert.deepEqual(body.recommendedMemory.sourceTags, ['recent']);
});

test('run-context exposes a stable guidance + snapshot contract for manual-approval missions', async () => {
  const response = await fetch(
    `${baseUrl}/projects/project-war-room/run-context?agentId=agent-builder&missionId=mission-api-spine&intent=EXECUTE&memoryLimit=8`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  const contract = {
    projectId: body.projectId,
    focus: body.focus,
    slimSnapshot: {
      project: {
        codename: body.slimSnapshot.project.codename,
        status: body.slimSnapshot.project.status,
      },
      focusMission: {
        id: body.slimSnapshot.focusMission?.id,
        status: body.slimSnapshot.focusMission?.status,
        governanceMode: body.slimSnapshot.focusMission?.governanceMode,
        riskLevel: body.slimSnapshot.focusMission?.riskLevel,
        assignedAgentId: body.slimSnapshot.focusMission?.assignedAgentId,
      },
      battleMetrics: {
        highRiskMissionCount: body.slimSnapshot.battleMetrics.highRiskMissionCount,
        manualGovernanceMissionCount: body.slimSnapshot.battleMetrics.manualGovernanceMissionCount,
      },
    },
    recommendedMemory: {
      sourceTags: body.recommendedMemory.sourceTags,
      itemCount: body.recommendedMemory.items.length,
    },
    guidance: {
      strategy: {
        kind: body.guidance.strategy.kind,
        primaryAgentId: body.guidance.strategy.primaryAgentId,
        reviewerAgentIds: body.guidance.strategy.reviewerAgentIds,
      },
      invocationProfile: {
        agentId: body.guidance.invocationProfile.agentId,
        disposition: body.guidance.invocationProfile.disposition,
        intent: body.guidance.invocationProfile.intent,
        allowedOperations: body.guidance.invocationProfile.allowedOperations,
      },
    },
  };

  assert.deepEqual(contract, {
    projectId: 'project-war-room',
    focus: {
      agentId: 'agent-builder',
      missionId: 'mission-api-spine',
      intent: 'EXECUTE',
    },
    slimSnapshot: {
      project: {
        codename: body.slimSnapshot.project.codename,
        status: 'ACTIVE',
      },
      focusMission: {
        id: 'mission-api-spine',
        status: 'RUNNING',
        governanceMode: 'MANUAL',
        riskLevel: 'HIGH',
        assignedAgentId: 'agent-builder',
      },
      battleMetrics: {
        highRiskMissionCount: body.slimSnapshot.battleMetrics.highRiskMissionCount,
        manualGovernanceMissionCount: body.slimSnapshot.battleMetrics.manualGovernanceMissionCount,
      },
    },
    recommendedMemory: {
      sourceTags: ['mission-scoped'],
      itemCount: body.recommendedMemory.items.length,
    },
    guidance: {
      strategy: {
        kind: 'MANUAL_APPROVAL_GATE',
        primaryAgentId: 'agent-builder',
        reviewerAgentIds: ['agent-scout'],
      },
      invocationProfile: {
        agentId: 'agent-builder',
        disposition: 'REQUIRE_APPROVAL',
        intent: 'PROPOSE',
        allowedOperations: ['READ_CONTEXT', 'WRITE_LOG', 'WRITE_MEMORY', 'REQUEST_APPROVAL'],
      },
    },
  });

  assert.ok(contract.slimSnapshot.project.codename);
  assert.ok(contract.slimSnapshot.battleMetrics.highRiskMissionCount >= 1);
  assert.ok(contract.slimSnapshot.battleMetrics.manualGovernanceMissionCount >= 1);
});
