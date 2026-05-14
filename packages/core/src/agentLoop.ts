import { AgentRuntime } from './runtime/agentRuntime';
import { OpenAIProvider } from './runtime/providers/openaiProvider';
import { AnthropicProvider } from './runtime/providers/anthropicProvider';
import { getMessageBus } from './runtime/messageBus';
import { createAllTools } from './tools/index';
import { UltimateOrchestrator } from './ultimate/orchestrator';
import { TELOSOrchestrator } from './telos/telosOrchestrator';
import { getEffortRules, classifyEffortLevel } from './ultimate/effortScaler';
import { deliberate } from './ultimate/deliberation';
import type { EffortLevel } from './ultimate/types';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentLoopConfig {
  projectRoot: string;
  maxConcurrentTasks: number;
  sessionTimeoutMs: number;
  stateFile: string;
  tools: string[];
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  projectRoot: process.cwd(),
  maxConcurrentTasks: 5,
  sessionTimeoutMs: 3600000,
  stateFile: '.commander_state.json',
  tools: ['web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_search', 'file_list', 'python_execute', 'shell_execute'],
};

export class CommanderAgentLoop {
  private runtime: AgentRuntime;
  private telos: TELOSOrchestrator;
  private orchestrator: UltimateOrchestrator;
  private config: AgentLoopConfig;
  private taskQueue: Array<{ id: string; goal: string; priority: number; status: string; createdAt: string }> = [];
  private activeSessions: Map<string, { startTime: number; goal: string }> = new Map();
  private isRunning = false;

  constructor(config?: Partial<AgentLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtime = new AgentRuntime();

    // Register providers from environment
    if (process.env.OPENAI_API_KEY) {
      this.runtime.registerProvider('openai', new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL,
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4o',
      }));
    }
    if (process.env.ANTHROPIC_API_KEY) {
      this.runtime.registerProvider('anthropic', new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY,
      }));
    }

    // Register all tools
    const allTools = createAllTools();
    for (const [name, tool] of allTools) {
      this.runtime.registerTool(name, tool);
    }

    this.telos = new TELOSOrchestrator(this.runtime);
    this.orchestrator = new UltimateOrchestrator(this.telos, this.runtime);
    this.loadState();
  }

  private loadState() {
    try {
      if (fs.existsSync(this.config.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf-8'));
        this.taskQueue = data.taskQueue || [];
        console.log(`[Commander] Loaded state: ${this.taskQueue.length} pending tasks`);
      }
    } catch {
      this.taskQueue = [];
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.config.stateFile, JSON.stringify({
        taskQueue: this.taskQueue,
        updatedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch {}
  }

  addTask(goal: string, priority = 0): string {
    const id = `task_${Date.now()}_${this.taskQueue.length}`;
    this.taskQueue.push({ id, goal, priority, status: 'pending', createdAt: new Date().toISOString() });
    this.taskQueue.sort((a, b) => b.priority - a.priority);
    this.saveState();
    console.log(`[Commander] Task added: ${goal.slice(0, 60)}... (${id})`);
    return id;
  }

  getQueueLength(): number { return this.taskQueue.length; }
  getActiveCount(): number { return this.activeSessions.size; }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[Commander] Agent loop started. Tools: ${this.config.tools.join(', ')}`);
    console.log(`[Commander] Pending tasks: ${this.taskQueue.length}`);

    while (this.isRunning && this.taskQueue.length > 0) {
      if (this.activeSessions.size >= this.config.maxConcurrentTasks) {
        await this.sleep(1000);
        continue;
      }

      const task = this.taskQueue.shift();
      if (!task) continue;

      this.saveState();
      this.executeTask(task).catch(err => {
        console.error(`[Commander] Task ${task.id} failed:`, err);
      });
    }

    console.log(`[Commander] Queue empty. Waiting for active sessions...`);
  }

  private async executeTask(task: { id: string; goal: string }) {
    const bus = getMessageBus();
    this.activeSessions.set(task.id, { startTime: Date.now(), goal: task.goal });

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[Commander] Executing: ${task.goal.slice(0, 80)}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    bus.publish('agent.started', 'commander-loop', { taskId: task.id, goal: task.goal });

    try {
      // Phase 1: Deliberation
      const plan = deliberate(task.goal);
      console.log(`  Type: ${plan.taskType} | Agents: ${plan.estimatedAgentCount} | Topology: ${plan.recommendedTopology}`);

      // Phase 2: Execute via orchestrator
      const result = await this.orchestrator.execute({
        projectId: 'commander',
        agentId: 'commander-lead',
        goal: task.goal,
        contextData: {
          availableTools: this.config.tools,
          governanceProfile: { riskLevel: 'LOW' },
        },
      });

      console.log(`  Status: ${result.status}`);
      console.log(`  Synthesis: ${result.synthesis.slice(0, 200)}...`);

      bus.publish('agent.completed', 'commander-loop', {
        taskId: task.id, status: result.status,
        metrics: result.metrics,
      });

      return result;
    } catch (err) {
      console.error(`[Commander] Task error:`, err);
      bus.publish('agent.failed', 'commander-loop', { taskId: task.id, error: String(err) });
    } finally {
      this.activeSessions.delete(task.id);
    }
  }

  stop() {
    this.isRunning = false;
    console.log(`[Commander] Loop stopped. ${this.activeSessions.size} sessions remaining.`);
  }

  getStatus(): object {
    return {
      running: this.isRunning,
      queueLength: this.taskQueue.length,
      activeSessions: this.activeSessions.size,
      sessions: Array.from(this.activeSessions.entries()).map(([id, s]) => ({
        id, goal: s.goal.slice(0, 60), runningFor: Date.now() - s.startTime,
      })),
      tools: this.config.tools,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
