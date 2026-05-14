import fs from 'fs';
import path from 'path';
import { AgentState } from '@commander/core';

const AGENT_STATE_FILE = path.resolve(__dirname, '../data/agent-state.json');

export interface UpsertAgentStateInput {
  projectId: string;
  agentId: string;
  summary?: string;
  preferences?: string;
  tags?: string[];
}

export class AgentStateStore {
  private items: AgentState[];

  constructor(private readonly filePath = AGENT_STATE_FILE) {
    this.items = this.load();
  }

  get(projectId: string, agentId: string): AgentState | undefined {
    return this.items.find(item => item.projectId === projectId && item.agentId === agentId);
  }

  upsert(input: UpsertAgentStateInput): AgentState {
    const now = new Date().toISOString();
    const existing = this.get(input.projectId, input.agentId);

    const safeTags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : existing?.tags ?? [];

    if (existing) {
      existing.summary = input.summary ?? existing.summary;
      existing.preferences = input.preferences ?? existing.preferences;
      existing.tags = safeTags;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }

    const created: AgentState = {
      projectId: input.projectId,
      agentId: input.agentId,
      summary: input.summary,
      preferences: input.preferences,
      tags: safeTags,
      updatedAt: now,
    };

    this.items.push(created);
    this.persist();
    return created;
  }

  private load(): AgentState[] {
    if (!fs.existsSync(this.filePath)) {
      this.write([]);
      return [];
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    try {
      const parsed = JSON.parse(raw) as AgentState[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [];
    } catch {
      return [];
    }
  }

  private persist() {
    this.write(this.items);
  }

  private write(items: AgentState[]) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(items, null, 2));
  }
}
