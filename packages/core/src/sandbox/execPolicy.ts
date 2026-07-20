import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  private userRulesLoaded = false;

  constructor() {
    this.loadDefaultRules();
  }

  private ensureUserRulesLoaded(): void {
    if (this.userRulesLoaded) return;
    this.userRulesLoaded = true;
    this.loadUserRules();
  }

  private loadDefaultRules(): void {
    // Codex CLI command safety classification (from codex-rs/shell-command/src/command_safety/)
    // Safe commands — auto-approved without prompting
    const SAFE_READONLY = [
      'cat',
      'cd',
      'cut',
      'echo',
      'grep',
      'head',
      'tail',
      'less',
      'more',
      'ls',
      'pwd',
      'stat',
      'wc',
      'which',
      'whoami',
      'type',
      'find',
      'du',
      'diff',
      'sort',
      'uniq',
      'tr',
      'tee',
      'xargs',
      'basename',
      'dirname',
      'realpath',
      'readlink',
      'file',
      'md5sum',
      'sha256sum',
    ];
    const SAFE_GIT = [
      'git status',
      'git diff',
      'git log',
      'git branch',
      'git show',
      'git blame',
      'git remote',
      'git tag',
      'git stash list',
      'git rev-parse',
    ];
    const SAFE_DEV = [
      'npm',
      'pnpm',
      'yarn',
      // npx forbidden — download-on-execute supply-chain risk (align with MCP whitelist)
      'tsc',
      'eslint',
      'prettier',
      'jest',
      'vitest',
      'mocha',
      'node',
      'python3',
      'pip',
      'cargo',
      'go',
    ];

    this.rules.push(
      // Safe: read-only commands (priority 1 — lowest, easily overridden)
      {
        id: 'allow-readonly',
        pattern: SAFE_READONLY,
        decision: 'allow',
        justification: 'Safe read-only commands (Codex classification)',
        priority: 1,
      },
      {
        id: 'allow-git-read',
        pattern: SAFE_GIT,
        decision: 'allow',
        justification: 'Safe git read operations',
        priority: 2,
      },
      {
        id: 'allow-dev',
        pattern: SAFE_DEV,
        decision: 'allow',
        justification: 'Development tooling',
        priority: 2,
      },

      // Network: prompt required
      {
        id: 'default-deny-network',
        pattern: ['curl', 'wget', 'nc', 'telnet', 'ssh', 'sftp'],
        decision: 'prompt',
        justification: 'Network access requires approval',
        priority: 10,
      },

      // Catastrophic destructive: always forbidden (can never be approved)
      {
        id: 'forbid-catastrophic',
        pattern: [
          'rm -rf /',
          'rm -rf ~',
          'rm -rf *',
          'rm -rf .',
          'rm -rf $HOME',
          'rm -rf $PWD',
          'rm -fr /',
          'rm -fr ~',
          'rm -fr *',
          'rm -fr .',
          'rm -r /',
          'rm -r ~',
          'rm -r *',
          'rm -r .',
          'chmod -R 777 /',
          'chmod -R 777 ~',
        ],
        decision: 'forbidden',
        justification:
          'Catastrophic destructive operation — can never be approved (protects root/home/workspace from deletion)',
        priority: 99,
      },

      // Destructive: always prompt (requires explicit approval)
      {
        id: 'prompt-destructive',
        pattern: [
          'rm -rf',
          'rm -r',
          'rm -f',
          'chmod -R',
          'chown -R',
          'git reset --hard',
          'git clean -f',
        ],
        decision: 'prompt',
        justification: 'Destructive operation requires approval',
        priority: 30,
      },

      // Dangerous: prompt with strong warning
      {
        id: 'forbid-secrets',
        pattern: ['chmod 777', 'git push --force', 'git push -f'],
        decision: 'prompt',
        justification: 'Potentially dangerous operations',
        priority: 40,
      },

      // Banned prefixes (from Codex CLI) — inline code execution never auto-approved
      {
        id: 'ban-inline-exec',
        pattern: [
          'python3 -c',
          'python -c',
          'bash -lc',
          'sh -c',
          'node -e',
          'perl -e',
          'ruby -e',
          'osascript',
          'php -r',
        ],
        decision: 'prompt',
        justification: 'Inline code execution requires approval (Codex banned prefix)',
        priority: 50,
      },

      // Forbidden: always blocked
      {
        id: 'forbid-dangerous',
        pattern: ['sudo', 'su ', 'passwd', 'mkfs', 'dd if=', '> /dev/', ':(){ :|:& };:', 'npx'],
        decision: 'forbidden',
        justification:
          'Dangerous commands are blocked (npx = download-on-execute supply-chain risk)',
        priority: 100,
      },
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
          const files = fs.readdirSync(loc).filter((f) => f.endsWith('.json'));
          for (const f of files) this.loadFile(path.join(loc, f));
        } else {
          this.loadFile(loc);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          getGlobalLogger().warn('ExecPolicyEngine', 'User rules load failed', {
            error: (e as Error)?.message,
            location: loc,
          });
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
          // SBX-3: repo/home-supplied rules must never outrank the built-in
          // `prompt`/`forbidden` rules, or an attacker-controlled
          // .commander/execpolicy.json could `allow` a command the built-ins
          // forbid. Clamp user-rule priority strictly below the built-ins.
          const requested = typeof rule.priority === 'number' ? rule.priority : 0;
          rule.priority = Math.min(requested, ExecPolicyEngine.MAX_USER_RULE_PRIORITY);
          this.rules.push(rule);
        }
        this.loadedFiles.add(filepath);
      }
    } catch (err) {
      getGlobalLogger().warn('ExecPolicyEngine', `Failed to load ${filepath}`, {
        error: (err as Error)?.message,
      });
    }
  }

  // SBX-3: the highest priority a repo/home-supplied user rule may take. Kept
  // strictly below the built-in `prompt` (50) and `forbidden` (100) rules so a
  // caller-supplied policy can never override a built-in denial.
  private static readonly MAX_USER_RULE_PRIORITY = 49;

  // Process wrapper prefixes to strip before matching (from Claude Code's permission system)
  // e.g., "timeout 30 npm test" should match the "npm" rule
  private static readonly WRAPPER_PREFIXES = ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'env'];

  evaluate(command: string): {
    decision: PolicyDecision;
    rule?: PolicyRule;
    matchedPattern?: string;
  } {
    this.ensureUserRulesLoaded();
    // Normalize: lowercase, trim, AND collapse internal whitespace (spaces, tabs, newlines)
    // to single spaces. This prevents bypass via multiple spaces/tabs: `rm  -rf  /`
    // would otherwise not match `rm -rf /` and fall through to 'prompt' instead of 'forbidden'.
    const normalized = command.toLowerCase().trim().replace(/\s+/g, ' ');

    // Strip process wrapper prefixes for matching (Claude Code pattern)
    let strippedOriginal = command;
    for (const wrapper of ExecPolicyEngine.WRAPPER_PREFIXES) {
      const re = new RegExp(`^${wrapper}(\\s+(-[a-zA-Z]+|\\d+))*\\s+`, 'i');
      const match = strippedOriginal.match(re);
      if (match) {
        strippedOriginal = strippedOriginal.slice(match[0].length);
        break; // only strip one wrapper level
      }
    }
    // Collapse whitespace but PRESERVE case for candidate extraction. Linux CI
    // is case-sensitive; mkdtemp suffixes often include uppercase letters.
    // Lowercasing before realpath makes symlink resolution miss the file
    // (aliases stay `mycat` → default prompt). macOS APFS hid this bug.
    strippedOriginal = strippedOriginal.trim().replace(/\s+/g, ' ');
    const strippedNormalized = strippedOriginal.toLowerCase();

    const candidates = this.extractCommandCandidates(strippedOriginal);
    const sorted = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // SECURITY: Check for command substitution ($(...) or backticks) BEFORE rule matching.
    // Commands like `npm run build $(rm -rf /)` contain `npm` and would otherwise match
    // the `allow-dev` rule and bypass the substitution check entirely.
    if (this.hasCommandSubstitution(normalized)) {
      return {
        decision: 'prompt',
        rule: {
          id: 'implicit-command-substitution',
          pattern: ['$('],
          decision: 'prompt',
          justification: 'Shell command substitution requires review — may execute hidden commands',
          priority: 20,
        },
        matchedPattern: '$(',
      };
    }

    // When a wrapper was stripped, also match against the pre-strip command.
    const originalCandidates =
      strippedNormalized !== normalized
        ? this.extractCommandCandidates(command.trim().replace(/\s+/g, ' '))
        : candidates;

    for (const rule of sorted) {
      for (const pattern of rule.pattern) {
        if (
          this.matchesPattern(candidates, pattern) ||
          this.matchesPattern(originalCandidates, pattern)
        ) {
          return { decision: rule.decision, rule, matchedPattern: pattern };
        }
      }
    }

    // Security: default to 'prompt' for unmatched commands (fail-safe)
    return {
      decision: 'prompt',
      rule: {
        id: 'default-unknown-command',
        pattern: ['*'],
        decision: 'prompt',
        justification: 'Unknown command — requires review before execution',
        priority: 0,
      },
    };
  }

  private matchesPattern(candidates: CommandCandidates, pattern: string): boolean {
    const p = pattern.toLowerCase().trim();
    if (!p) return false;
    if (/^[a-z0-9._+-]+$/i.test(p)) {
      return candidates.commandNames.has(p);
    }
    if (Array.from(candidates.rawCommands).some((command) => this.rawCommandMatches(command, p))) {
      return true;
    }
    return Array.from(candidates.segments).some((segment) => this.segmentMatches(segment, p));
  }

  private rawCommandMatches(command: string, pattern: string): boolean {
    if (command === pattern) return true;
    if (this.isShellPayloadPattern(pattern)) {
      return command.includes(pattern);
    }
    return false;
  }

  private segmentMatches(segment: string, pattern: string): boolean {
    if (segment === pattern) return true;
    if (pattern.endsWith('=') && segment.startsWith(pattern)) return true;
    if (this.startsWithTokenBoundary(segment, pattern)) return true;
    if (pattern.includes('/dev/') || pattern.includes('>')) {
      return segment.includes(pattern);
    }
    return false;
  }

  private isShellPayloadPattern(pattern: string): boolean {
    return (
      pattern.includes('|') ||
      pattern.includes(';') ||
      pattern.includes('&') ||
      pattern.includes('>')
    );
  }

  private startsWithTokenBoundary(segment: string, pattern: string): boolean {
    if (!segment.startsWith(pattern)) return false;
    const next = segment.charAt(pattern.length);
    return next === '' || /\s/.test(next);
  }

  private extractCommandCandidates(command: string): CommandCandidates {
    const rawCommands = new Set<string>();
    const segments = new Set<string>();
    const commandNames = new Set<string>();
    const queue = [command, ...this.extractCommandSubstitutions(command)];

    for (const source of queue) {
      const rawCommand = source.trim().toLowerCase();
      if (rawCommand) rawCommands.add(rawCommand);
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

    return { rawCommands, segments, commandNames };
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
        if (ch === '|' && next === '|') i++;
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
    const basename = path.basename(cleaned);
    aliases.add(basename);
    if (basename.startsWith('mkfs.')) aliases.add('mkfs');

    // Pass the ORIGINAL token (not lowercased) to resolveRealPath so that
    // fs.existsSync/realpathSync work correctly on case-sensitive filesystems
    // (Linux CI). macOS APFS is case-insensitive, so the bug was hidden locally.
    const resolved = this.resolveRealPath(token);
    if (resolved) {
      const realBasename = path.basename(resolved).toLowerCase();
      aliases.add(realBasename);
      if (realBasename.startsWith('mkfs.')) aliases.add('mkfs');
    }

    return Array.from(aliases);
  }

  /** Resolve symlinks for any command path (by path or by PATH lookup). */
  private resolveRealPath(token: string): string | null {
    if (token.includes('/')) {
      try {
        if (fs.existsSync(token)) return fs.realpathSync(token);
      } catch (err) {
        reportSilentFailure(err, 'execPolicy:511');
        return null;
      }
    } else {
      const pathDirs = (process.env.PATH || '').split(':');
      for (const dir of pathDirs) {
        const fullPath = path.join(dir, token);
        try {
          if (fs.existsSync(fullPath)) return fs.realpathSync(fullPath);
        } catch (err) {
          reportSilentFailure(err, 'execPolicy:521');
          continue;
        }
      }
    }
    return null;
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
    const newRule: PolicyRule = {
      ...rule,
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    };
    newRule.priority = newRule.priority ?? 25;
    this.rules.push(newRule);
    return newRule;
  }

  removeRule(id: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === id);
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
  rawCommands: Set<string>;
  segments: Set<string>;
  commandNames: Set<string>;
}

// ── Singleton accessor ────────────────────────────────────────────────────
// Mirrors the getGuardianAgent()/resetGuardianAgent() pattern so callers can
// obtain a shared ExecPolicyEngine without re-loading rules on every call.

let defaultExecPolicyInstance: ExecPolicyEngine | undefined;

/** Get the shared singleton ExecPolicyEngine instance. */
export function getExecPolicyEngine(): ExecPolicyEngine {
  if (!defaultExecPolicyInstance) {
    defaultExecPolicyInstance = new ExecPolicyEngine();
  }
  return defaultExecPolicyInstance;
}

/** Reset the singleton (primarily for tests). */
export function resetExecPolicyEngine(): void {
  defaultExecPolicyInstance = undefined;
}
