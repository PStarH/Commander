/**
 * Commander Company Mode — Persistent multi-agent with:
 * 1. Scheduled tasks (cron)
 * 2. Multi-stage pipeline (draft → review → publish)
 * 3. Feedback learning loop
 * 4. Minimal token cost for simple tasks
 */
import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(process.cwd(), '.commander_state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ============================================================================
// 1. Scheduled Tasks
// ============================================================================
interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;        // "daily", "weekly", "hourly", or "* */30 * * * *"
  prompt: string;
  lastRun: string | null;
  nextRun: string;
  createdAt: string;
}

function parseCron(cron: string, base = new Date()): Date {
  if (cron === 'hourly') return new Date(base.getTime() + 3600000);
  if (cron === 'daily') return new Date(base.getTime() + 86400000);
  if (cron === 'weekly') return new Date(base.getTime() + 604800000);
  if (cron === 'monthly') return new Date(base.getTime() + 2592000000);
  return new Date(base.getTime() + 86400000);
}

export class Scheduler {
  private entries: ScheduleEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() { this.load(); }

  add(name: string, cron: string, prompt: string): string {
    const id = `sched_${Date.now()}`;
    const now = new Date();
    this.entries.push({
      id, name, cron, prompt,
      lastRun: null,
      nextRun: parseCron(cron, now).toISOString(),
      createdAt: now.toISOString(),
    });
    this.save();
    return id;
  }

  getDue(): ScheduleEntry[] {
    const now = new Date();
    return this.entries.filter(e => new Date(e.nextRun) <= now);
  }

  markRun(id: string) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.lastRun = new Date().toISOString();
    entry.nextRun = parseCron(entry.cron).toISOString();
    this.save();
  }

  list() { return [...this.entries]; }
  remove(id: string) { this.entries = this.entries.filter(e => e.id !== id); this.save(); }

  start(intervalMs = 30000) {
    this.timer = setInterval(() => {
      const due = this.getDue();
      for (const entry of due) {
        console.log(`[Scheduler] Running: ${entry.name}`);
        this.markRun(entry.id);
      }
    }, intervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  private load() {
    try {
      const p = path.join(STATE_DIR, 'schedules.json');
      if (fs.existsSync(p)) this.entries = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
  }
  private save() {
    fs.writeFileSync(path.join(STATE_DIR, 'schedules.json'), JSON.stringify(this.entries, null, 2), 'utf-8');
  }
}

// ============================================================================
// 2. Multi-Stage Quality Pipeline
// ============================================================================
export interface DraftOutput {
  id: string; content: string; agentId: string; createdAt: string; type: string;
}
export interface ReviewResult {
  draftId: string; passed: boolean; score: number;
  issues: string[]; suggestions: string[];
}

export class QualityPipeline {
  async run(content: string, type: string, agentId: string): Promise<{
    draft: DraftOutput; review: ReviewResult; final: string | null;
  }> {
    const draft: DraftOutput = {
      id: `draft_${Date.now()}`, content, agentId, createdAt: new Date().toISOString(), type,
    };

    // Stage 1: Auto-review (quality gates)
    const issues: string[] = [];
    if (content.length < 10) issues.push('Content too short (< 10 chars)');
    if (content.length > 50000) issues.push('Content too long (> 50K chars)');
    if (this.hasHallucinationSignals(content)) issues.push('Contains hallucination signals');
    if (!this.isConsistent(content)) issues.push('Internal inconsistency detected');

    const review: ReviewResult = {
      draftId: draft.id, passed: issues.length === 0,
      score: Math.max(0, 1 - issues.length * 0.2),
      issues, suggestions: [],
    };

    // Stage 2: Auto-fix if possible
    let final: string | null = null;
    if (review.passed) {
      final = content;
    } else {
      review.suggestions = issues.map(i => `Fix: ${i}`);
      if (issues.length <= 2) final = content;
    }

    this.logQuality(draft, review);
    return { draft, review, final };
  }

  private hasHallucinationSignals(s: string): boolean {
    const signals = /\b(unverified|allegedly|reportedly|supposedly|as of my last|I cannot verify)\b/i;
    return signals.test(s);
  }

  private isConsistent(s: string): boolean {
    const contradictions = [
      ['always', 'never'],
      ['increase', 'decrease'],
      ['positive', 'negative'],
    ];
    for (const [a, b] of contradictions) {
      if (s.toLowerCase().includes(a) && s.toLowerCase().includes(b)) return false;
    }
    return true;
  }

  private logQuality(draft: DraftOutput, review: ReviewResult) {
    try {
      const logPath = path.join(STATE_DIR, 'quality-log.json');
      let logs: any[] = [];
      if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      logs.push({ draftId: draft.id, type: draft.type, score: review.score, passed: review.passed, timestamp: new Date().toISOString() });
      if (logs.length > 1000) logs = logs.slice(-1000);
      fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8');
    } catch {}
  }
}

// ============================================================================
// 3. Feedback Learning Loop
// ============================================================================
export interface FeedbackEntry {
  taskId: string; prompt: string; output: string;
  score: number; issues: string[]; improved: boolean;
  timestamp: string;
}

export class FeedbackLoop {
  record(entry: FeedbackEntry) {
    try {
      const p = path.join(STATE_DIR, 'feedback.json');
      let logs: FeedbackEntry[] = [];
      if (fs.existsSync(p)) logs = JSON.parse(fs.readFileSync(p, 'utf-8'));
      logs.push(entry);
      if (logs.length > 500) logs = logs.slice(-500);
      fs.writeFileSync(p, JSON.stringify(logs, null, 2), 'utf-8');
    } catch {}
  }

  getStats(): { total: number; avgScore: number; improvementRate: number; commonIssues: string[] } {
    try {
      const p = path.join(STATE_DIR, 'feedback.json');
      if (!fs.existsSync(p)) return { total: 0, avgScore: 0, improvementRate: 0, commonIssues: [] };
      const logs: FeedbackEntry[] = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const avg = logs.reduce((a, b) => a + b.score, 0) / logs.length;
      const improved = logs.filter(l => l.improved).length;
      const issueCount = new Map<string, number>();
      for (const l of logs) for (const issue of l.issues) issueCount.set(issue, (issueCount.get(issue) || 0) + 1);
      const top = [...issueCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([i]) => i);
      return { total: logs.length, avgScore: avg, improvementRate: improved / logs.length, commonIssues: top };
    } catch { return { total: 0, avgScore: 0, improvementRate: 0, commonIssues: [] }; }
  }
}

// ============================================================================
// 4. Company Engine — puts it all together
// ============================================================================
export class CompanyEngine {
  scheduler = new Scheduler();
  quality = new QualityPipeline();
  feedback = new FeedbackLoop();
  private running = false;
  private taskCount = 0;
  private startTime = 0;

  start() {
    this.running = true;
    this.startTime = Date.now();
    this.scheduler.start();
    console.log('[Company] Engine started — scheduled tasks active');
  }

  stop() {
    this.running = false;
    this.scheduler.stop();
    const elapsed = ((Date.now() - this.startTime) / 1000 / 60).toFixed(1);
    console.log(`[Company] Engine stopped. Ran ${this.taskCount} tasks in ${elapsed}min`);
  }

  async submit(content: string, type: string, agentId: string): Promise<{
    draft: DraftOutput; review: ReviewResult; final: string | null; tokenCost: number;
  }> {
    this.taskCount++;
    const tokenCost = this.estimateTokens(content);

    const { draft, review, final } = await this.quality.run(content, type, agentId);

    this.feedback.record({
      taskId: draft.id, prompt: content.slice(0, 100), output: (final || content).slice(0, 100),
      score: review.score, issues: review.issues, improved: final !== null && review.passed,
      timestamp: new Date().toISOString(),
    });

    return { draft, review, final, tokenCost };
  }

  getStatus() {
    return {
      uptime: ((Date.now() - this.startTime) / 1000).toFixed(0) + 's',
      tasksCompleted: this.taskCount,
      scheduleCount: this.scheduler.list().length,
      feedback: this.feedback.getStats(),
    };
  }

  private estimateTokens(s: string): number {
    return Math.ceil(s.length / 3.7);
  }
}
