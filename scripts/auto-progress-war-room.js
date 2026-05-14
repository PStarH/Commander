#!/usr/bin/env node

// Simple auto-progress script for Agent War Room
// - Picks one mission to advance (PLANNED -> RUNNING -> DONE, or surface BLOCKED)
// - Appends an execution log describing what happened
// - Updates timestamps on mission, project, and agent

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.resolve(__dirname, '../apps/api/data/war-room.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('[auto-progress] data file not found:', DATA_FILE);
    process.exit(0);
  }

  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function nextId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chooseMission(missions) {
  // Prefer RUNNING, then BLOCKED, then PLANNED
  const running = missions.find(m => m.status === 'RUNNING');
  if (running) return running;
  const blocked = missions.find(m => m.status === 'BLOCKED');
  if (blocked) return blocked;
  const planned = missions.find(m => m.status === 'PLANNED');
  if (planned) return planned;
  return null;
}

function main() {
  const data = loadData();
  const now = new Date().toISOString();

  const project = data.projects && data.projects[0];
  if (!project) {
    console.error('[auto-progress] no project found');
    process.exit(0);
  }

  const mission = chooseMission(data.missions || []);
  if (!mission) {
    // nothing to do
    console.log('[auto-progress] no missions to advance');
    return;
  }

  const agent = data.agents.find(a => a.id === mission.assignedAgentId);
  const logsForMission = (data.logs || []).filter(l => l.missionId === mission.id);

  let message;
  let level = 'INFO';

  if (mission.status === 'PLANNED') {
    mission.status = 'RUNNING';
    mission.startedAt = mission.startedAt || now;
    message = `Auto-progress: kicked off mission from PLANNED to RUNNING.`;
  } else if (mission.status === 'RUNNING') {
    if (logsForMission.length >= 2) {
      mission.status = 'DONE';
      mission.completedAt = mission.completedAt || now;
      level = 'SUCCESS';
      message = `Auto-progress: marked mission DONE after iterative work.`;
    } else {
      message = `Auto-progress: added a checkpoint while mission is RUNNING.`;
    }
  } else if (mission.status === 'BLOCKED') {
    level = 'WARN';
    message = `Auto-progress: surfaced BLOCKED mission for human review.`;
  } else {
    console.log('[auto-progress] mission already DONE, skipping');
    return;
  }

  mission.updatedAt = now;
  project.updatedAt = now;

  if (agent) {
    agent.lastHeartbeatAt = now;
  }

  const log = {
    id: nextId('log'),
    projectId: mission.projectId,
    missionId: mission.id,
    agentId: mission.assignedAgentId,
    level,
    message,
    createdAt: now,
  };

  data.logs.push(log);
  saveData(data);

  console.log('[auto-progress] updated mission', mission.id, 'status =', mission.status, '| log:', message);
}

main();
