import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { WarRoomStore } = require('../dist/store.js') as {
  WarRoomStore: new (filePath?: string) => any;
};

function createLegacyFixture(filePath: string): void {
  const data = {
    projects: [
      {
        id: 'project-war-room',
        name: 'Agent War Room',
        codename: 'Operation Glassboard',
        objective: 'Test normalization',
        status: 'ACTIVE',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ],
    agents: [
      {
        id: 'agent-scout',
        projectId: 'project-war-room',
        name: 'Scout',
        callsign: 'INTEL-7',
        role: 'Research Strategist',
        model: 'gpt-4.1',
        status: 'RUNNING',
        specialty: 'Requirement digestion',
        lastHeartbeatAt: '2026-03-12T00:00:00.000Z',
      },
      {
        id: 'agent-builder',
        projectId: 'project-war-room',
        name: 'Builder',
        callsign: 'STACK-3',
        role: 'Implementation Operator',
        model: 'gpt-4.1-mini',
        status: 'READY',
        specialty: 'API delivery',
        lastHeartbeatAt: '2026-03-12T00:00:00.000Z',
      },
    ],
    missions: [
      {
        id: 'mission-api-spine',
        projectId: 'project-war-room',
        title: 'Stand up mission persistence and control endpoints',
        objective: 'Persist state',
        status: 'RUNNING',
        priority: 'CRITICAL',
        assignedAgentId: 'agent-builder',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
      },
    ],
    logs: [],
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

test('WarRoomStore normalizes legacy agents and missions on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-store-test-'));
  const filePath = path.join(dir, 'war-room.json');
  createLegacyFixture(filePath);

  const store = new WarRoomStore(filePath);
  const agents = store.listAgents('project-war-room');
  const builder = agents.find((agent: any) => agent.id === 'agent-builder');
  const scout = agents.find((agent: any) => agent.id === 'agent-scout');
  assert.equal(builder.governanceRole, 'EXECUTOR');
  assert.equal(scout.governanceRole, 'SENATE');

  const snapshot = store.getProjectSnapshot('project-war-room');
  assert.ok(snapshot);
  const mission = snapshot.missions.find((item: any) => item.id === 'mission-api-spine');
  assert.equal(mission.riskLevel, 'HIGH');
  assert.equal(mission.governanceMode, 'MANUAL');
});
