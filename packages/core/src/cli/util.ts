import { detectProvider, getEffectiveModel } from '../config/commanderConfig';
import { t } from './i18n';

// ============================================================================
// Theme system — configurable color schemes
// ============================================================================

export interface Theme {
  name: string;
  reset: string;
  bold: string;
  dim: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  gray: string;
  bgBlue: string;
  bgGreen: string;
  bgRed: string;
  bgYellow: string;
  bgGray: string;
}

/** Dark theme (default) — full color, works on dark terminals */
const DARK_THEME: Theme = {
  name: 'dark',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGray: '\x1b[100m',
};

/** Light theme — optimized for light backgrounds */
const LIGHT_THEME: Theme = {
  name: 'light',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGray: '\x1b[100m',
};

/** Minimal theme — no colors, just formatting (for accessibility / piping) */
const MINIMAL_THEME: Theme = {
  name: 'minimal',
  reset: '',
  bold: '',
  dim: '',
  red: '',
  green: '',
  yellow: '',
  blue: '',
  magenta: '',
  cyan: '',
  gray: '',
  bgBlue: '',
  bgGreen: '',
  bgRed: '',
  bgYellow: '',
  bgGray: '',
};

const THEMES: Record<string, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  minimal: MINIMAL_THEME,
};

/** Current theme — mutable, defaults to dark */
let currentTheme: Theme = DARK_THEME;

/** Check NO_COLOR env var (https://no-color.org/) */
function shouldDisableColor(): boolean {
  return !!process.env.NO_COLOR || process.env.TERM === 'dumb';
}

/**
 * Set the active theme by name.
 * Respects NO_COLOR env var — if set, forces minimal theme.
 */
export function setTheme(name: string) {
  if (shouldDisableColor()) {
    currentTheme = MINIMAL_THEME;
    return;
  }
  const theme = THEMES[name];
  if (theme) {
    currentTheme = theme;
  }
}

/** Get current theme name */
export function getThemeName(): string {
  return currentTheme.name;
}

/** List available theme names */
export function listThemes(): string[] {
  return Object.keys(THEMES);
}

// Initialize theme from env on load
if (shouldDisableColor()) {
  currentTheme = MINIMAL_THEME;
}

/**
 * ANSI styling — theme-aware color codes.
 *
 * Usage: $.red, $.green, $.bold, etc.
 * Supports NO_COLOR env var and theme switching via setTheme().
 */
export const $: Theme = new Proxy(DARK_THEME, {
  get(target, prop: string) {
    return currentTheme[prop as keyof Theme] ?? target[prop as keyof Theme];
  },
});

export function section(title: string) {
  console.log(`\n  ${$.bold}${$.blue}┃ ${title}${$.reset}`);
}

export function kv(key: string, value: string, valColor = '') {
  console.log(`  ${$.dim}${key}${$.reset} ${valColor}${value}${$.reset}`);
}

export function bullet(text: string, color = '') {
  console.log(`  ${color}•${$.reset} ${text}`);
}

export function cmdHeader(task: string) {
  const provider = detectProvider();
  const model = getEffectiveModel();
  const providerTag = provider ? `${provider.type} · ${model}` : 'no provider';
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Commander${$.reset} ${$.dim}multi-agent orchestration${$.reset}  ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.dim}${providerTag}${$.reset}${' '.repeat(Math.max(0, 36 - providerTag.length))} ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`  ${$.dim}Task:${$.reset} ${task.length > 70 ? task.slice(0, 70) + '...' : task}\n`);
}

export function startSpinner(label: string): () => void {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const start = Date.now();
  const timer = setInterval(() => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r  ${$.cyan}${frames[i]}${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}`,
    );
    i = (i + 1) % frames.length;
  }, 80);
  timer.unref();
  return () => {
    clearInterval(timer);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(`\r  ${$.green}✓${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}\n`);
  };
}

/**
 * Start a spinner that can fail (show error instead of success).
 * Returns { done, fail } — call done() on success or fail(msg) on error.
 */
export function startSpinnerWithFailure(label: string): {
  done: () => void;
  fail: (msg?: string) => void;
} {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const start = Date.now();
  let cleared = false;
  const timer = setInterval(() => {
    if (cleared) return;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `\r  ${$.cyan}${frames[i]}${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}`,
    );
    i = (i + 1) % frames.length;
  }, 80);
  timer.unref();

  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearInterval(timer);
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
  };

  return {
    done: () => {
      clear();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`  ${$.green}✓${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}\n`);
    },
    fail: (msg?: string) => {
      clear();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`  ${$.red}✗${$.reset} ${label} ${$.dim}${elapsed}s${$.reset}`);
      if (msg) process.stdout.write(` ${$.red}${msg}${$.reset}`);
      process.stdout.write('\n');
    },
  };
}

/**
 * Render a progress bar.
 * @param current - Current progress value
 * @param total - Total value
 * @param width - Bar width in characters (default: 30)
 * @param label - Optional label to show after the bar
 */
export function progressBar(current: number, total: number, width = 30, label?: string) {
  const pct = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(width * pct);
  const empty = width - filled;
  const bar = `${$.green}${'█'.repeat(filled)}${$.dim}${'░'.repeat(empty)}${$.reset}`;
  const pctStr = `${(pct * 100).toFixed(0)}%`.padStart(4);
  const labelStr = label ? ` ${$.dim}${label}${$.reset}` : '';
  process.stdout.write(`\r  ${bar} ${pctStr} ${$.dim}${current}/${total}${$.reset}${labelStr}`);
  if (current >= total) process.stdout.write('\n');
}

/**
 * Multi-step progress indicator.
 * Shows a checklist with current step highlighted.
 */
export class StepProgress {
  private steps: string[];
  private current: number;
  private start: number;

  constructor(steps: string[]) {
    this.steps = steps;
    this.current = 0;
    this.start = Date.now();
  }

  /** Start the next step (marks previous as done). */
  next(label?: string) {
    if (this.current > 0) {
      // Mark previous as done
      process.stdout.write(`\r  ${$.green}✓${$.reset} ${this.steps[this.current - 1]}\n`);
    }
    if (this.current < this.steps.length) {
      const stepLabel = label || this.steps[this.current];
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼'];
      process.stdout.write(
        `  ${$.cyan}${frames[this.current % frames.length]}${$.reset} ${stepLabel}`,
      );
    }
    this.current++;
  }

  /** Complete all steps and print summary. */
  done() {
    if (this.current > 0 && this.current <= this.steps.length) {
      process.stdout.write(`\r  ${$.green}✓${$.reset} ${this.steps[this.current - 1]}\n`);
    }
    // Mark remaining as skipped
    for (let i = this.current; i < this.steps.length; i++) {
      process.stdout.write(`  ${$.dim}○ ${this.steps[i]} (skipped)${$.reset}\n`);
    }
    const elapsed = ((Date.now() - this.start) / 1000).toFixed(1);
    process.stdout.write(`  ${$.dim}Completed in ${elapsed}s${$.reset}\n`);
  }
}

// ============================================================================
// Flag parsing — shared across commands
// ============================================================================

export interface ParsedArgs {
  /** Positional arguments (non-flag tokens) */
  positional: string[];
  /** Flags extracted from --key=value and --key forms */
  flags: Record<string, string>;
}

/**
 * Parse CLI arguments into positional args and flags.
 * Handles --key=value, --key (sets "true"), and plain positional tokens.
 */
export function parseFlags(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const eqIdx = arg.indexOf('=');
      const key = arg.slice(2, eqIdx);
      const value = arg.slice(eqIdx + 1);
      flags[key] = value;
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = 'true';
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/**
 * Onboarding banner shown to every new user the first time they run a task
 * without an API key configured. Lists the 18 supported providers with
 * locale-aware descriptions via the i18n dictionary.
 */
export function onboardingMessage() {
  console.log(`\n  ${$.bold}${$.blue}╭────────────────────────────────────────────╮${$.reset}`);
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}${t('onboarding.welcome')}${$.reset}                  ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(`  ${$.bold}${$.blue}╰────────────────────────────────────────────╯${$.reset}`);
  console.log(`\n  ${t('onboarding.env.vars')}\n`);
  // Each entry: [env var name (literal, never translated), i18n key suffix for description]
  const vars: ReadonlyArray<readonly [string, string]> = [
    ['OPENAI_API_KEY', 'openai'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['GOOGLE_API_KEY', 'google'],
    ['OPENROUTER_API_KEY', 'openrouter'],
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['ZHIPU_API_KEY', 'glm'],
    ['MIMO_API_KEY', 'mimo'],
    ['XIAOMI_API_KEY', 'xiaomi'],
    ['OLLAMA_HOST', 'ollama'],
    ['VLLM_BASE_URL', 'vllm'],
    ['CO_API_KEY', 'cohere'],
    ['MISTRAL_API_KEY', 'mistral'],
    ['GROQ_API_KEY', 'groq'],
    ['TOGETHER_API_KEY', 'together'],
    ['PERPLEXITY_API_KEY', 'perplexity'],
    ['FIREWORKS_API_KEY', 'fireworks'],
    ['REPLICATE_API_TOKEN', 'replicate'],
    ['AWS_ACCESS_KEY_ID', 'aws_bedrock'],
  ];
  for (const [envVar, i18nKey] of vars) {
    const desc = t(`onboarding.env_vars.${i18nKey}`);
    console.log(`    ${$.cyan}${envVar.padEnd(22)}${$.reset} ${$.dim}${desc}${$.reset}`);
  }
  console.log(`\n  ${$.dim}${t('onboarding.example')}${$.reset}`);
  console.log(`    ${$.gray}${t('onboarding.example.cmd')}${$.reset}`);
  console.log(`    ${$.gray}${t('onboarding.example.run')}${$.reset}\n`);
}

// ============================================================================
// Error helpers — consistent, actionable error messages
// ============================================================================

/**
 * Print a fatal error with context and exit.
 * Shows the error message, optional suggestion, and a help pointer.
 */
/**
 * Print a fatal error with locale-aware banner, exit.
 * The "ERROR" prefix and the doctor footprint are translated via t().
 */
export function fatalError(message: string, suggestion?: string): never {
  console.error(`\n  ${$.red}${$.bold}${t('error.fatal')}${$.reset} ${message}`);
  if (suggestion) {
    console.error(`  ${$.dim}→ ${suggestion}${$.reset}`);
  }
  console.error(`  ${$.dim}${t('error.run.doctor')}${$.reset}\n`);
  process.exit(1);
}

/**
 * Print a warning (non-fatal).
 */
export function warn(message: string, suggestion?: string) {
  console.log(`  ${$.yellow}⚠${$.reset} ${message}`);
  if (suggestion) {
    console.log(`  ${$.dim}→ ${suggestion}${$.reset}`);
  }
}

// ============================================================================
// Config — Multi-Provider Support
// ============================================================================
