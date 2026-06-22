/**
 * Interactive REPL for commander.
 *
 * Spawned when `commander` is invoked with no args on a TTY. Each accepted
 * input line is dispatched in-process by calling `runCli([...])` — same
 * code path as a real CLI invocation, so behavior is identical to non-REPL
 * use. Persistent history at ~/.commander/repl_history (capped, best-effort).
 *
 * Features:
 *   - Tab-completion for built-ins + known command names + common flags
 *   - ".env loaded from …" notice on startup when loadEnvUp found files
 *   - --profile transcript file recording all inputs with timestamps
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { $ } from './util';
import type { LoadEnvResult } from './envLoader';

const HISTORY_DIR = path.join(os.homedir(), '.commander');
const HISTORY_FILE = path.join(HISTORY_DIR, 'repl_history');
const MAX_HISTORY = 200;
const REPL_PROMPT = `${$.cyan}commander>${$.reset} `;

export interface StartReplOptions {
  /**
   * Path to write a timestamped session transcript (--profile mode).
   * `true` = auto-generate a filename in cwd.
   */
  profilePath?: string | true;
  /** Result from the initial .env load, for startup banner. */
  envLoadResult?: LoadEnvResult;
}

type Dispatcher = (args: string[]) => Promise<void>;

// ── Tab-completion data ─────────────────────────────────────────────────

const TAB_COMPLETIONS_BUILTINS = [':help', ':exit', ':clear', 'help', 'exit', 'quit', 'clear'];
const TAB_COMPLETIONS_COMMANDS = [
  'run',
  'review',
  'fix',
  'init',
  'status',
  'config',
  'doctor',
  'gui',
  'mode',
  'history',
  'skill',
  'intelligence',
  'experience',
  'debug',
  'budget',
  'checkpoint',
  'goal',
  'sandbox',
  'viz',
  'cost',
  'completion',
  'feedback',
  'resume',
  // Advanced cmds — still discoverable via completion.
  'swarm',
  'drive',
  'company',
  'saga',
  'compensation',
];
const TAB_COMPLETIONS_COMMON_FLAGS = [
  '--dry-run',
  '--stream',
  '--tui',
  '--mode=',
  '--provider=',
  '--budget=',
  '--max-rounds=',
  '--advanced',
  '--help',
  '--version',
];

const ALL_CMD_COMPLETIONS = [...TAB_COMPLETIONS_BUILTINS, ...TAB_COMPLETIONS_COMMANDS];

/**
 * Token-aware TAB completer.
 * - Single token → suggest built-ins + command names.
 * - Second+ token → suggest common flags.
 */
function tabCompleter(line: string): [string[], string] {
  const trimmed = line.replace(/^\s+/, '');
  // Find the last whitespace boundary to extract the stem.
  const lastSp = trimmed.lastIndexOf(' ');
  const stem = lastSp >= 0 ? trimmed.slice(lastSp + 1) : trimmed;

  // Multi-token → flag suggestions.
  if (lastSp >= 0) {
    const hits = TAB_COMPLETIONS_COMMON_FLAGS.filter((f) => f.startsWith(stem));
    return [hits, stem];
  }

  // Single token → commands + built-ins.
  const hits = ALL_CMD_COMPLETIONS.filter((c) => c.startsWith(stem));
  return [hits, stem];
}

// ── History persistence ─────────────────────────────────────────────────

// `readline.Interface` does not expose `.history` as a typed property in
// `@types/node` (it's an internal node state array). The cast below is
// load-bearing — TS strict mode rejects direct access.
// See: https://nodejs.org/api/readline.html#rlhistory
interface InterfaceWithHistory {
  history: string[];
}

function loadHistory(rl: readline.Interface): void {
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = data
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-MAX_HISTORY);
    const history = (rl as unknown as InterfaceWithHistory).history;
    for (const line of lines) history.push(line);
  } catch {
    /* missing/unreadable history is fine */
  }
}

function saveHistoryLine(line: string): void {
  if (!line.trim()) return;
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    // Read existing, dedupe-append last 200, write back.
    let prev = '';
    try {
      prev = fs.readFileSync(HISTORY_FILE, 'utf8');
    } catch {
      /* first write */
    }
    const lines = prev.split('\n').filter(Boolean);
    if (lines[lines.length - 1] !== line) lines.push(line);
    const trimmed = lines.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n');
  } catch {
    /* best-effort */
  }
}

// ── Profile transcript ──────────────────────────────────────────────────

const PROFILE_AUTO_PATTERN = 'commander-repl-{datetime}.log';

function resolveProfilePath(profile: string | true): string {
  if (profile === true) {
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-06-22T12-34-56
    return path.join(process.cwd(), `commander-repl-${now}.log`);
  }
  return path.resolve(profile);
}

/** Append a log line to the profile file (best-effort). */
function profileLog(profilePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.appendFileSync(profilePath, line + '\n');
  } catch {
    /* best-effort */
  }
}

// ── Built-ins help keys ─────────────────────────────────────────────────

const REPL_BUILTINS: Record<string, string> = {
  ':help': 'Show this help',
  ':exit': 'Leave the REPL (also works: Ctrl-D)',
  ':clear': 'Clear the screen',
};

// ── Banner ──────────────────────────────────────────────────────────────

function printBanner(envLoadResult?: LoadEnvResult): void {
  console.log('');
  console.log(
    `  ${$.bold}${$.blue}Commander REPL${$.reset} ${$.dim}type a task — same as the CLI${$.reset}`,
  );

  // Show .env loaded paths (if any).
  if (envLoadResult && envLoadResult.loaded.length > 0) {
    if (envLoadResult.loaded.length === 1) {
      console.log(
        `  ${$.dim}📄 .env loaded:${$.reset} ${$.cyan}${envLoadResult.loaded[0]}${$.reset}`,
      );
    } else {
      console.log(`  ${$.dim}📄 .env loaded from:${$.reset}`);
      for (const p of envLoadResult.loaded) {
        console.log(`    ${$.cyan}${p}${$.reset}`);
      }
    }
  }

  console.log(`  ${$.dim}Examples:${$.reset}`);
  console.log(
    `    ${$.cyan}run${$.reset} "fix the type errors in src/"      ${$.dim}# execute a task${$.reset}`,
  );
  console.log(
    `    ${$.cyan}run --dry-run${$.reset} "summarize this repo"   ${$.dim}# deliberate only, no API call${$.reset}`,
  );
  console.log(
    `    ${$.cyan}review --commit${$.reset}                    ${$.dim}# review code changes${$.reset}`,
  );
  console.log(
    `    ${$.cyan}status${$.reset}                              ${$.dim}# see providers / API keys${$.reset}`,
  );
  console.log(
    `    ${$.cyan}doctor${$.reset}                              ${$.dim}# diagnose issues${$.reset}`,
  );
  console.log(
    `    ${$.cyan}:help${$.reset}                              ${$.dim}# built-ins${$.reset}`,
  );
  console.log(
    `    ${$.cyan}:exit${$.reset}  /  ${$.cyan}Ctrl-D${$.reset}                   ${$.dim}# leave the REPL${$.reset}`,
  );
  console.log(`  ${$.dim}Multi-line input: end a line with \\\` \\\` to continue.${$.reset}`);
  console.log(`  ${$.dim}TAB completion: commands + built-ins + flags.${$.reset}`);
  console.log('');
}

// ── Tokeniser ───────────────────────────────────────────────────────────

/**
 * Tokenize a REPL input into argv. Strips the literal `commander` prefix
 * if present (so users can type `commander run "x"` from muscle memory).
 * Quoted strings are preserved verbatim — `run "fix this"` becomes
 * `["run", "fix this"]`.
 */
function tokenize(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith('commander ')) {
    return tokenize(trimmed.slice('commander '.length));
  }
  // Very small shell-ish tokeniser: splits on whitespace, but preserves
  // double-quoted strings as a single token (no escape handling — REPL
  // is rarely asked to do shell-level escaping).
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function startRepl(dispatch: Dispatcher, options?: StartReplOptions): Promise<void> {
  const profilePath = options?.profilePath ? resolveProfilePath(options.profilePath) : undefined;

  if (profilePath) {
    profileLog(profilePath, `# commander REPL transcript — started at ${new Date().toISOString()}`);
  }

  printBanner(options?.envLoadResult);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: REPL_PROMPT,
    terminal: true,
    completer: tabCompleter,
  });

  loadHistory(rl);

  // Continue-prompt for `\` line-continuation (simple multi-line story).
  let pending = '';

  const ask = () => rl.prompt();

  rl.on('line', async (raw) => {
    const input = raw ?? '';
    if (pending) {
      pending += '\n' + input;
      if (!input.endsWith('\\')) {
        const full = pending.replace(/\\\n$/, '');
        pending = '';
        await handleLine(full);
      } else {
        process.stdout.write('      …\n');
      }
      return;
    }
    if (input.endsWith('\\')) {
      pending = input;
      process.stdout.write('      …\n');
      return;
    }
    await handleLine(input);
  });

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      ask();
      return;
    }

    // Write to profile transcript (before dispatch so input is recorded even on crash).
    if (profilePath) {
      const ts = new Date().toISOString();
      profileLog(profilePath, `[${ts}] > ${trimmed}`);
    }

    saveHistoryLine(trimmed);

    // Built-ins
    if (trimmed === ':help' || trimmed === 'help') {
      console.log('');
      console.log(`  ${$.bold}Built-ins${$.reset}`);
      for (const [name, desc] of Object.entries(REPL_BUILTINS)) {
        console.log(`    ${$.cyan}${name.padEnd(10)}${$.reset}  ${$.dim}${desc}${$.reset}`);
      }
      console.log(`  ${$.dim}TAB completions:${$.reset} commands, flags, built-ins`);
      console.log(
        `  ${$.dim}Transcript:${$.reset} ${profilePath ? $.cyan + profilePath + $.reset : $.dim + 'off (use --profile)' + $.reset}`,
      );
      console.log('');
      ask();
      return;
    }
    if (trimmed === ':exit' || trimmed === 'exit' || trimmed === 'quit') {
      rl.close();
      return;
    }
    if (trimmed === ':clear' || trimmed === 'clear') {
      process.stdout.write('\x1b[2J\x1b[H');
      ask();
      return;
    }

    const args = tokenize(trimmed);
    if (args.length === 0) {
      ask();
      return;
    }

    try {
      await dispatch(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${$.red}${$.bold}ERROR${$.reset} ${msg}`);
    }
    // Spacer + new prompt after any output, so subsequent input reads cleanly.
    console.log('');
    ask();
  }

  // SIGINT inside the REPL clears the current line and re-prompts — the
  // user is in a session, not a single execution. Exit semantics belong
  // to :exit / Ctrl-D.
  rl.on('SIGINT', () => {
    rl.write('\n');
    ask();
  });

  rl.on('close', () => {
    if (profilePath) {
      profileLog(profilePath, `# commander REPL transcript — ended at ${new Date().toISOString()}`);
      console.log(`  ${$.dim}Transcript saved: ${profilePath}${$.reset}`);
    }
    console.log(`  ${$.dim}Bye.${$.reset}\n`);
    process.exit(0);
  });

  ask();
}
