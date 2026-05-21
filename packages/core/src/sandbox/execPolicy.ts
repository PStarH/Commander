import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';

type PolicyDecision = 'allow' | 'prompt' | 'forbidden';

interface PolicyRule {
  id: string;
  pattern: string[];
  decision: PolicyDecision;
  justification?: string;
  priority?: number;
}

interface PolicyFile {
  rules: PolicyRule[];
  version?: number;
}

export class ExecPolicyEngine {
  private rules: PolicyRule[] = [];
  private loadedFiles: Set<string> = new Set();

  constructor() {
    this.loadDefaultRules();
    this.loadUserRules();
  }

  private loadDefaultRules(): void {
    this.rules.push(
      { id: 'default-deny-network', pattern: ['curl', 'wget', 'nc', 'telnet', 'ssh', 'sftp'], decision: 'prompt', justification: 'Network access requires approval', priority: 10 },
      { id: 'allow-readonly', pattern: ['ls', 'cat', 'head', 'tail', 'less', 'more', 'echo', 'pwd', 'which', 'type'], decision: 'allow', justification: 'Safe read-only commands', priority: 1 },
      { id: 'allow-dev', pattern: ['npm', 'pnpm', 'yarn', 'npx', 'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha'], decision: 'allow', justification: 'Development tooling', priority: 2 },
      { id: 'allow-git', pattern: ['git status', 'git diff', 'git log', 'git branch', 'git show', 'git blame'], decision: 'allow', justification: 'Safe git read operations', priority: 2 },
      { id: 'prompt-destructive', pattern: ['rm -rf', 'rm -r', 'rm -f', 'chmod -R', 'chown -R'], decision: 'prompt', justification: 'Destructive operation requires approval', priority: 30 },
      { id: 'forbid-dangerous', pattern: ['sudo', 'su ', 'passwd', 'mkfs', 'dd if=', '> /dev/', ':(){ :|:& };:'], decision: 'forbidden', justification: 'Dangerous commands are blocked', priority: 100 },
      { id: 'forbid-secrets', pattern: ['chmod 777', 'git push --force', 'git push -f'], decision: 'prompt', justification: 'Potentially dangerous git operations', priority: 40 },
    );
  }

  private loadUserRules(): void {
    const locations = [
      path.join(process.cwd(), '.commander', 'execpolicy.json'),
      path.join(process.cwd(), '.commander', 'rules'),
      path.join(os.homedir(), '.commander', 'execpolicy.json'),
    ];
    for (const loc of locations) {
      try {
        if (fs.statSync(loc).isDirectory()) {
          const files = fs.readdirSync(loc).filter(f => f.endsWith('.json'));
          for (const f of files) this.loadFile(path.join(loc, f));
        } else {
          this.loadFile(loc);
        }
      } catch (e) { getGlobalLogger().warn('ExecPolicyEngine', 'User rules load failed', { error: (e as Error)?.message, location: loc }); }
    }
  }

  private loadFile(filepath: string): void {
    try {
      const content = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as PolicyFile;
      if (content.rules) {
        for (const rule of content.rules) {
          rule.id = `user-${rule.pattern.join('-')}-${Date.now()}`;
          rule.priority = rule.priority ?? 50;
          this.rules.push(rule);
        }
        this.loadedFiles.add(filepath);
      }
    } catch (err) {
      getGlobalLogger().warn('ExecPolicyEngine', `Failed to load ${filepath}`, { error: (err as Error)?.message });
    }
  }

  evaluate(command: string): { decision: PolicyDecision; rule?: PolicyRule; matchedPattern?: string } {
    const cmdLower = command.toLowerCase().trim();
    const sorted = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of sorted) {
      for (const pattern of rule.pattern) {
        const pLower = pattern.toLowerCase();
        if (cmdLower.startsWith(pLower) || cmdLower.includes(` ${pLower}`) || cmdLower.includes(`${pLower} `)) {
          return { decision: rule.decision, rule, matchedPattern: pattern };
        }
      }
    }
    return { decision: 'allow' };
  }

  addRule(rule: Omit<PolicyRule, 'id'>): PolicyRule {
    const newRule: PolicyRule = { ...rule, id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    newRule.priority = newRule.priority ?? 25;
    this.rules.push(newRule);
    return newRule;
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  persist(filepath?: string): void {
    const fp = filepath ?? path.join(process.cwd(), '.commander', 'execpolicy.json');
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify({ rules: this.rules, version: 2 }, null, 2), 'utf-8');
  }
}

import * as os from 'os';
