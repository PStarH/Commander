"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecPolicyEngine = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
class ExecPolicyEngine {
    constructor() {
        this.rules = [];
        this.loadedFiles = new Set();
        this.loadDefaultRules();
        this.loadUserRules();
    }
    loadDefaultRules() {
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
            'npx',
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
        }, {
            id: 'allow-git-read',
            pattern: SAFE_GIT,
            decision: 'allow',
            justification: 'Safe git read operations',
            priority: 2,
        }, {
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
        // Destructive: always prompt
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
            pattern: ['sudo', 'su ', 'passwd', 'mkfs', 'dd if=', '> /dev/', ':(){ :|:& };:'],
            decision: 'forbidden',
            justification: 'Dangerous commands are blocked',
            priority: 100,
        });
    }
    loadUserRules() {
        const locations = [
            path.join(process.cwd(), '.commander', 'execpolicy.json'),
            path.join(process.cwd(), '.commander', 'rules'),
            path.join(os.homedir(), '.commander', 'execpolicy.json'),
        ];
        for (const loc of locations) {
            try {
                if (fs.statSync(loc).isDirectory()) {
                    const files = fs.readdirSync(loc).filter((f) => f.endsWith('.json'));
                    for (const f of files)
                        this.loadFile(path.join(loc, f));
                }
                else {
                    this.loadFile(loc);
                }
            }
            catch (e) {
                if (e.code !== 'ENOENT') {
                    (0, logging_1.getGlobalLogger)().warn('ExecPolicyEngine', 'User rules load failed', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                        location: loc,
                    });
                }
            }
        }
    }
    loadFile(filepath) {
        var _a;
        try {
            const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
            if (content.rules) {
                for (const rule of content.rules) {
                    rule.id = `user-${rule.pattern.join('-')}-${Date.now()}`;
                    rule.priority = (_a = rule.priority) !== null && _a !== void 0 ? _a : 50;
                    this.rules.push(rule);
                }
                this.loadedFiles.add(filepath);
            }
        }
        catch (err) {
            (0, logging_1.getGlobalLogger)().warn('ExecPolicyEngine', `Failed to load ${filepath}`, {
                error: err === null || err === void 0 ? void 0 : err.message,
            });
        }
    }
    evaluate(command) {
        const normalized = command.toLowerCase().trim();
        // Strip process wrapper prefixes for matching (Claude Code pattern)
        let strippedCommand = command;
        for (const wrapper of ExecPolicyEngine.WRAPPER_PREFIXES) {
            const re = new RegExp(`^${wrapper}(\\s+(-[a-zA-Z]+|\\d+))*\\s+`, 'i');
            const match = strippedCommand.match(re);
            if (match) {
                strippedCommand = strippedCommand.slice(match[0].length);
                break; // only strip one wrapper level
            }
        }
        const candidates = this.extractCommandCandidates(strippedCommand);
        const sorted = [...this.rules].sort((a, b) => { var _a, _b; return ((_a = b.priority) !== null && _a !== void 0 ? _a : 0) - ((_b = a.priority) !== null && _b !== void 0 ? _b : 0); });
        // Evaluate each rule against the (possibly wrapper-stripped) command
        const effectiveCandidates = strippedCommand !== command ? this.extractCommandCandidates(strippedCommand) : candidates;
        for (const rule of sorted) {
            for (const pattern of rule.pattern) {
                if (this.matchesPattern(candidates, pattern) ||
                    this.matchesPattern(effectiveCandidates, pattern)) {
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
    matchesPattern(candidates, pattern) {
        const p = pattern.toLowerCase().trim();
        if (!p)
            return false;
        if (/^[a-z0-9._+-]+$/i.test(p)) {
            return candidates.commandNames.has(p);
        }
        if (Array.from(candidates.rawCommands).some((command) => this.rawCommandMatches(command, p))) {
            return true;
        }
        return Array.from(candidates.segments).some((segment) => this.segmentMatches(segment, p));
    }
    rawCommandMatches(command, pattern) {
        if (command === pattern)
            return true;
        if (this.isShellPayloadPattern(pattern)) {
            return command.includes(pattern);
        }
        return false;
    }
    segmentMatches(segment, pattern) {
        if (segment === pattern)
            return true;
        if (pattern.endsWith('=') && segment.startsWith(pattern))
            return true;
        if (this.startsWithTokenBoundary(segment, pattern))
            return true;
        if (pattern.includes('/dev/') || pattern.includes('>')) {
            return segment.includes(pattern);
        }
        return false;
    }
    isShellPayloadPattern(pattern) {
        return (pattern.includes('|') ||
            pattern.includes(';') ||
            pattern.includes('&') ||
            pattern.includes('>'));
    }
    startsWithTokenBoundary(segment, pattern) {
        if (!segment.startsWith(pattern))
            return false;
        const next = segment.charAt(pattern.length);
        return next === '' || /\s/.test(next);
    }
    extractCommandCandidates(command) {
        const rawCommands = new Set();
        const segments = new Set();
        const commandNames = new Set();
        const queue = [command, ...this.extractCommandSubstitutions(command)];
        for (const source of queue) {
            const rawCommand = source.trim().toLowerCase();
            if (rawCommand)
                rawCommands.add(rawCommand);
            for (const rawSegment of this.splitCommandSegments(source)) {
                const segment = rawSegment.trim().toLowerCase();
                if (!segment)
                    continue;
                segments.add(segment);
                const firstToken = this.firstCommandToken(rawSegment);
                if (!firstToken)
                    continue;
                for (const name of this.commandNameAliases(firstToken)) {
                    commandNames.add(name);
                }
            }
        }
        return { rawCommands, segments, commandNames };
    }
    splitCommandSegments(command) {
        const segments = [];
        let current = '';
        let quote = null;
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
                if (ch === quote)
                    quote = null;
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
                if (ch === '|' && next === '|')
                    i++;
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
    firstCommandToken(segment) {
        const tokens = this.tokenizeSegment(segment);
        let idx = 0;
        if (tokens[idx] === 'env')
            idx++;
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
    tokenizeSegment(segment) {
        const trimmed = segment.trim();
        if (!trimmed)
            return [];
        const tokens = [];
        let token = '';
        let quote = null;
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
                }
                else {
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
        if (token)
            tokens.push(token);
        return tokens;
    }
    commandNameAliases(token) {
        const aliases = new Set();
        const cleaned = token.toLowerCase();
        const basename = path.basename(cleaned);
        aliases.add(basename);
        if (basename.startsWith('mkfs.'))
            aliases.add('mkfs');
        const resolved = this.resolveRealPath(cleaned);
        if (resolved) {
            const realBasename = path.basename(resolved).toLowerCase();
            aliases.add(realBasename);
            if (realBasename.startsWith('mkfs.'))
                aliases.add('mkfs');
        }
        return Array.from(aliases);
    }
    /** Resolve symlinks for any command path (by path or by PATH lookup). */
    resolveRealPath(token) {
        if (token.includes('/')) {
            try {
                if (fs.existsSync(token))
                    return fs.realpathSync(token);
            }
            catch {
                return null;
            }
        }
        else {
            const pathDirs = (process.env.PATH || '').split(':');
            for (const dir of pathDirs) {
                const fullPath = path.join(dir, token);
                try {
                    if (fs.existsSync(fullPath))
                        return fs.realpathSync(fullPath);
                }
                catch {
                    continue;
                }
            }
        }
        return null;
    }
    extractCommandSubstitutions(command) {
        var _a, _b;
        const extracted = [];
        const regex = /\$\(([^()]*)\)|`([^`]*)`/g;
        let match;
        while ((match = regex.exec(command)) !== null) {
            extracted.push((_b = (_a = match[1]) !== null && _a !== void 0 ? _a : match[2]) !== null && _b !== void 0 ? _b : '');
        }
        return extracted;
    }
    hasCommandSubstitution(normalized) {
        return normalized.includes('$(') || normalized.includes('`');
    }
    addRule(rule) {
        var _a;
        const newRule = {
            ...rule,
            id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        };
        newRule.priority = (_a = newRule.priority) !== null && _a !== void 0 ? _a : 25;
        this.rules.push(newRule);
        return newRule;
    }
    removeRule(id) {
        const idx = this.rules.findIndex((r) => r.id === id);
        if (idx === -1)
            return false;
        this.rules.splice(idx, 1);
        return true;
    }
    getRules() {
        return [...this.rules];
    }
    persist(filepath) {
        const fp = filepath !== null && filepath !== void 0 ? filepath : path.join(process.cwd(), '.commander', 'execpolicy.json');
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, JSON.stringify({ rules: this.rules, version: 2 }, null, 2), 'utf-8');
    }
}
exports.ExecPolicyEngine = ExecPolicyEngine;
// Process wrapper prefixes to strip before matching (from Claude Code's permission system)
// e.g., "timeout 30 npm test" should match the "npm" rule
ExecPolicyEngine.WRAPPER_PREFIXES = ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'env'];
