/**
 * ansi.ts — Zero-dependency ANSI escape code utilities for terminal rendering.
 *
 * Design decisions:
 * - All functions return strings (no side effects) — compose then write.
 * - Colors use 8-color set for maximum terminal compatibility.
 * - Box drawing uses Unicode ─ │ ╭ ╮ ╰ ╯ characters (not + - | ).
 * - No dependencies on process.stdout — caller controls output.
 */

// Cursor & Screen Control

export const cursorHide = '\x1b[?25l';
export const cursorShow = '\x1b[?25h';
export const clearScreen = '\x1b[2J\x1b[H';
export const clearDown = '\x1b[J';
export const clearLine = '\x1b[2K';
export const cursorSave = '\x1b[s';
export const cursorRestore = '\x1b[u';

export function cursorAt(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorUp(n: number): string {
  return `\x1b[${n}A`;
}

export function cursorDown(n: number): string {
  return `\x1b[${n}B`;
}

export function cursorRight(n: number): string {
  return `\x1b[${n}C`;
}

// 8-Color Palette (ANSI SGR parameters)

export type ColorName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'default';

const FG_CODES: Record<ColorName, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  default: 39,
};

const BG_CODES: Record<ColorName, number> = {
  black: 40,
  red: 41,
  green: 42,
  yellow: 43,
  blue: 44,
  magenta: 45,
  cyan: 46,
  white: 47,
  gray: 100,
  default: 49,
};

export function fg(color: ColorName, text: string): string {
  return `\x1b[${FG_CODES[color]}m${text}\x1b[39m`;
}

export function bg(color: ColorName, text: string): string {
  return `\x1b[${BG_CODES[color]}m${text}\x1b[49m`;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

export function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

export function underline(text: string): string {
  return `\x1b[4m${text}\x1b[24m`;
}

// Box Drawing (Unicode)

export const BOX = {
  H: '─',
  V: '│',
  TL: '╭',
  TR: '╮',
  BL: '╰',
  BR: '╯',
  CROSS: '┼',
  T_DOWN: '┬',
  T_UP: '┴',
  T_RIGHT: '├',
  T_LEFT: '┤',
} as const;

// Progress / Spinner Characters

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

// Terminal Info

export function terminalWidth(): number {
  try { return process.stdout.columns || 80; } catch (err) {
    console.warn('[Catch]', err);
    return 80;
  }
}

export function terminalHeight(): number {
  try { return process.stdout.rows || 24; } catch (err) {
    console.warn('[Catch]', err);
    return 24;
  }
}

// Timing Formatters

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K tok`;
  return `${(n / 1000000).toFixed(2)}M tok`;
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 0.1 ? 3 : 2)}`;
}
