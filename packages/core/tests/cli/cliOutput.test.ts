/**
 * CLI output snapshot tests — verify formatting utilities produce stable output.
 *
 * These tests capture console output from formatting functions and compare
 * against stored snapshots, catching accidental UI regressions.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// `$` (and the helpers that embed it) is computed once at module load from
// `NO_COLOR` / `TERM=dumb`. In a NO_COLOR or dumb-terminal shell the palette is
// empty, so the ANSI assertions below failed for an environment reason rather
// than a UI regression — a suite that only passed on the author's terminal.
// Neutralise those variables, then import the module so the palette is built
// with colour enabled. The names stay module-scoped, so every case is unchanged.
type CliUtil = typeof import('../../src/cli/util');
let $: CliUtil['$'];
let section: CliUtil['section'];
let kv: CliUtil['kv'];
let bullet: CliUtil['bullet'];
let onboardingMessage: CliUtil['onboardingMessage'];

before(async () => {
  delete process.env.NO_COLOR;
  if (!process.env.TERM || process.env.TERM === 'dumb') process.env.TERM = 'xterm-256color';
  const util: CliUtil = await import('../../src/cli/util');
  ({ $, section, kv, bullet, onboardingMessage } = util);
});

// Capture console.log output
let output: string[];
let originalLog: typeof console.log;

function captureOutput(): void {
  output = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
}

function getOutput(): string {
  return output.join('\n');
}

function restoreOutput(): void {
  console.log = originalLog;
}

// Strip ANSI codes for stable snapshots
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('CLI Output Formatting', () => {
  beforeEach(() => {
    captureOutput();
  });

  afterEach(() => {
    restoreOutput();
  });

  // ── section() ─────────────────────────────────────────────────────────────

  describe('section', () => {
    it('renders section header with blue bold formatting', () => {
      section('TEST SECTION');
      const raw = getOutput();
      const clean = stripAnsi(raw);

      assert.ok(clean.includes('TEST SECTION'), 'Should contain section title');
      assert.ok(raw.includes($.bold), 'Should have bold formatting');
      assert.ok(raw.includes($.blue), 'Should have blue color');
      assert.ok(raw.includes('┃'), 'Should have section divider character');
    });

    it('renders different section titles', () => {
      section('PLAN');
      section('RESULTS');
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('PLAN'));
      assert.ok(clean.includes('RESULTS'));
    });
  });

  // ── kv() ──────────────────────────────────────────────────────────────────

  describe('kv', () => {
    it('renders key-value pair', () => {
      kv('Agents', '3');
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('Agents'), 'Should contain key');
      assert.ok(clean.includes('3'), 'Should contain value');
    });

    it('applies value color when provided', () => {
      kv('Status', 'success', $.green);
      const raw = getOutput();

      assert.ok(raw.includes($.green), 'Should have green color on value');
      assert.ok(raw.includes($.dim), 'Should have dim key formatting');
    });

    it('renders without color when not provided', () => {
      kv('Plain', 'value');
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('Plain'));
      assert.ok(clean.includes('value'));
    });
  });

  // ── bullet() ──────────────────────────────────────────────────────────────

  describe('bullet', () => {
    it('renders bullet point', () => {
      bullet('First item');
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('•'), 'Should have bullet character');
      assert.ok(clean.includes('First item'), 'Should contain text');
    });

    it('applies color when provided', () => {
      bullet('Colored item', $.cyan);
      const raw = getOutput();

      assert.ok(raw.includes($.cyan), 'Should have cyan color');
    });
  });

  // ── onboardingMessage() ───────────────────────────────────────────────────

  describe('onboardingMessage', () => {
    it('renders welcome box', () => {
      onboardingMessage();
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('Welcome to Commander'), 'Should have welcome message');
      assert.ok(clean.includes('╭'), 'Should have box top corner');
      assert.ok(clean.includes('╰'), 'Should have box bottom corner');
    });

    it('lists all provider environment variables', () => {
      onboardingMessage();
      const clean = stripAnsi(getOutput());

      const expectedVars = [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GOOGLE_API_KEY',
        'OPENROUTER_API_KEY',
        'DEEPSEEK_API_KEY',
        'ZHIPU_API_KEY',
        'MIMO_API_KEY',
        'XIAOMI_API_KEY',
        'OLLAMA_HOST',
        'VLLM_BASE_URL',
      ];
      for (const v of expectedVars) {
        assert.ok(clean.includes(v), `Should list ${v}`);
      }
    });

    it('includes usage example', () => {
      onboardingMessage();
      const clean = stripAnsi(getOutput());

      assert.ok(clean.includes('export OPENAI_API_KEY'), 'Should show key export example');
      assert.ok(clean.includes('commander'), 'Should show commander command example');
    });
  });

  // ── ANSI escape codes ─────────────────────────────────────────────────────

  describe('ANSI codes', () => {
    it('exports all expected color codes', () => {
      assert.strictEqual($.reset, '\x1b[0m');
      assert.strictEqual($.bold, '\x1b[1m');
      assert.strictEqual($.dim, '\x1b[2m');
      assert.strictEqual($.red, '\x1b[31m');
      assert.strictEqual($.green, '\x1b[32m');
      assert.strictEqual($.yellow, '\x1b[33m');
      assert.strictEqual($.blue, '\x1b[34m');
      assert.strictEqual($.magenta, '\x1b[35m');
      assert.strictEqual($.cyan, '\x1b[36m');
      assert.strictEqual($.gray, '\x1b[90m');
    });

    it('exports background color codes', () => {
      assert.strictEqual($.bgBlue, '\x1b[44m');
      assert.strictEqual($.bgGreen, '\x1b[42m');
      assert.strictEqual($.bgRed, '\x1b[41m');
      assert.strictEqual($.bgYellow, '\x1b[43m');
      assert.strictEqual($.bgGray, '\x1b[100m');
    });
  });
});
