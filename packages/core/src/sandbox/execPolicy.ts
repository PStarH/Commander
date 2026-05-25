import * as fs from 'fs';
import * as os from 'os';
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
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          getGlobalLogger().warn('ExecPolicyEngine', 'User rules load failed', { error: (e as Error)?.message, location: loc });
        }
      }
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
    const normalized = command.toLowerCase().trim();
    const candidates = this.extractCommandCandidates(command);
    const sorted = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of sorted) {
      for (const pattern of rule.pattern) {
        if (this.matchesPattern(candidates, pattern)) {
          return { decision: rule.decision, rule, matchedPattern: pattern };
        }
      }
    }
    if (this.hasCommandSubstitution(normalized)) {
      return {
        decision: 'prompt',
        rule: {
          id: 'implicit-command-substitution',
          pattern: ['$('],
          decision: 'prompt',
          justification: 'Shell command substitution requires approval',
          priority: 20,
        },
        matchedPattern: '$(',
      };
    }
    return { decision: 'allow' };
  }

  private matchesPattern(candidates: CommandCandidates, pattern: string): boolean {
    const p = pattern.toLowerCase().trim();
    if (!p) return false;
    if (/^[a-z0-9._+-]+$/i.test(p)) {
      return candidates.commandNames.has(p);
    }
    return Array.from(candidates.segments).some(segment => this.segmentMatches(segment, p));
  }

  private segmentMatches(segment: string, pattern: string): boolean {
    if (segment === pattern) return true;
    if (this.startsWithTokenBoundary(segment, pattern)) return true;
    if (pattern.includes('/dev/') || pattern.includes('>')) {
      return segment.includes(pattern);
    }
    return false;
  }

  private startsWithTokenBoundary(segment: string, pattern: string): boolean {
    if (!segment.startsWith(pattern)) return false;
    const next = segment.charAt(pattern.length);
    return next === '' || /\s/.test(next);
  }

  private extractCommandCandidates(command: string): CommandCandidates {
    const segments = new Set<string>();
    const commandNames = new Set<string>();
    const queue = [command, ...this.extractCommandSubstitutions(command)];

    for (const source of queue) {
      for (const rawSegment of this.splitCommandSegments(source)) {
        const segment = rawSegment.trim().toLowerCase();
        if (!segment) continue;
        segments.add(segment);
        const firstToken = this.firstCommandToken(rawSegment);
        if (!firstToken) continue;
        for (const name of this.commandNameAliases(firstToken)) {
          commandNames.add(name);
        }
      }
    }

    return { segments, commandNames };
  }

  private splitCommandSegments(command: string): string[] {
    const segments: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];
      const next = command[i + 1];

      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        current += ch;
        escaped = true;
        continue;
      }
      if (quote) {
        current += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        current += ch;
        quote = ch;
        continue;
      }
      if (ch === ';' || ch === '\n' || ch === '|') {
        segments.push(current);
        current = '';
        if ((ch === '|' && next === '|')) i++;
        continue;
      }
      if (ch === '&' && next === '&') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
      current += ch;
    }
    segments.push(current);
    return segments;
  }

  private firstCommandToken(segment: string): string | null {
    const tokens = this.tokenizeSegment(segment);
    let idx = 0;
    if (tokens[idx] === 'env') idx++;
    while (idx < tokens.length) {
      const token = tokens[idx];
      if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
        idx++;
        continue;
      }
      if (tokens[0] === 'env' && token.startsWith('-')) {
        idx++;
        continue;
      }
      return token;
    }
    return null;
  }

  private tokenizeSegment(segment: string): string[] {
    const trimmed = segment.trim();
    if (!trimmed) return [];
    const tokens: string[] = [];
    let token = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (const ch of trimmed) {
      if (escaped) {
        token += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          token += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (token) {
          tokens.push(token);
          token = '';
        }
        continue;
      }
      token += ch;
    }

    if (token) tokens.push(token);
    return tokens;
  }

  private commandNameAliases(token: string): string[] {
    const aliases = new Set<string>();
    const cleaned = token.toLowerCase();
    aliases.add(path.basename(cleaned));

    if (token.includes('/') && fs.existsSync(token)) {
      try {
        aliases.add(path.basename(fs.realpathSync(token)).toLowerCase());
      } catch {
        // Keep the syntactic basename if the path cannot be resolved.
      }
    }

    return Array.from(aliases);
  }

  private extractCommandSubstitutions(command: string): string[] {
    const extracted: string[] = [];
    const regex = /\$\(([^()]*)\)|`([^`]*)`/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(command)) !== null) {
      extracted.push(match[1] ?? match[2] ?? '');
    }
    return extracted;
  }

  private hasCommandSubstitution(normalized: string): boolean {
    return normalized.includes('$(') || normalized.includes('`');
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

interface CommandCandidates {
  segments: Set<string>;
  commandNames: Set<string>;
}
