/**
 * Task Framework — Claude Code-inspired task lifecycle.
 *
 * Each task has a type, status, lifecycle, and can be killed.
 * Tasks write output to files for parallel sub-agent communication.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type TaskType = 'local_agent' | 'local_shell' | 'remote_agent' | 'dream';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';

export interface TaskHandle {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  startTime: number;
  endTime?: number;
  outputFile: string;
  outputOffset: number;
}

export interface TaskSpec {
  type: TaskType;
  description: string;
  command?: string;
  agentId?: string;
  goal?: string;
  tools?: string[];
  timeout?: number;
}

const TASKS_DIR = path.join(process.cwd(), '.commander_tasks');
const activeTasks = new Map<string, TaskHandle>();

function ensureDir(): void {
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createTask(spec: TaskSpec): TaskHandle {
  ensureDir();
  const taskId = generateTaskId();
  const outputFile = path.join(TASKS_DIR, `${taskId}.out`);

  const handle: TaskHandle = {
    taskId,
    type: spec.type,
    status: 'pending',
    description: spec.description,
    startTime: Date.now(),
    outputFile,
    outputOffset: 0,
  };

  activeTasks.set(taskId, handle);
  return handle;
}

export function updateTaskStatus(taskId: string, status: TaskStatus): void {
  const task = activeTasks.get(taskId);
  if (task) {
    task.status = status;
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      task.endTime = Date.now();
    }
  }
}

export function appendTaskOutput(taskId: string, output: string): void {
  ensureDir();
  const task = activeTasks.get(taskId);
  if (task) {
    fs.appendFileSync(task.outputFile, output + '\n', 'utf-8');
  }
}

export function readTaskOutput(taskId: string, maxChars = 5000): string {
  const task = activeTasks.get(taskId);
  if (!task) return '';
  try {
    const content = fs.readFileSync(task.outputFile, 'utf-8');
    return content.slice(-maxChars);
  } catch {
    return '';
  }
}

export function killTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task || task.status === 'completed' || task.status === 'killed') return false;
  task.status = 'killed';
  task.endTime = Date.now();
  return true;
}

export function getTask(taskId: string): TaskHandle | undefined {
  return activeTasks.get(taskId);
}

export function listTasks(status?: TaskStatus): TaskHandle[] {
  const all = Array.from(activeTasks.values());
  return status ? all.filter(t => t.status === status) : all;
}

export function cleanupTask(taskId: string): void {
  const task = activeTasks.get(taskId);
  if (task) {
    try { fs.unlinkSync(task.outputFile); } catch {}
    activeTasks.delete(taskId);
  }
}

export function getActiveCount(): number {
  return Array.from(activeTasks.values()).filter(t => t.status === 'running' || t.status === 'pending').length;
}
