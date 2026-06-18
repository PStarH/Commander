import type { BuiltinRegistry, LiteralValue } from './types';

const SECRET_PATTERNS: RegExp[] = [
  /\.env($|\.)/i,
  /\.netrc$/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /id_rsa($|\.|\/)/i,
  /id_ed25519($|\.|\/)/i,
  /\.aws\/credentials/i,
  /\.ssh\//i,
  /\.gnupg\//i,
  /credentials\.json/i,
  /service-account.*\.json/i,
  /\.kube\/config/i,
];

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?previous instructions/i,
  /disregard (the )?system prompt/i,
  /you are now /i,
  /new instructions?:/i,
  /system:\s*[a-z]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /###\s*(system|assistant)\s*:/i,
];

const SHELL_DENY: RegExp[] = [
  /\bsudo\b/i,
  /\bsu\s+-/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bpasswd\b/i,
];

const DESTRUCTIVE_CMDS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/i,
  /\brm\s+-r\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+/i,
];

export const defaultBuiltins: BuiltinRegistry = {
  b_path_matches_secret(args: LiteralValue[]): boolean {
    const path = String(args[0] ?? '');
    return SECRET_PATTERNS.some((re) => re.test(path));
  },
  b_contains_injection_pattern(args: LiteralValue[]): boolean {
    const text = String(args[0] ?? '');
    return INJECTION_PATTERNS.some((re) => re.test(text));
  },
  b_is_destructive_command(args: LiteralValue[]): boolean {
    const cmd = String(args[0] ?? '');
    return DESTRUCTIVE_CMDS.some((re) => re.test(cmd));
  },
  b_is_shell_denied(args: LiteralValue[]): boolean {
    const cmd = String(args[0] ?? '');
    return SHELL_DENY.some((re) => re.test(cmd));
  },
  b_contains_string(args: LiteralValue[]): boolean {
    const haystack = String(args[0] ?? '');
    const needle = String(args[1] ?? '');
    return haystack.includes(needle);
  },
  b_starts_with(args: LiteralValue[]): boolean {
    const s = String(args[0] ?? '');
    const prefix = String(args[1] ?? '');
    return s.startsWith(prefix);
  },
  b_ends_with(args: LiteralValue[]): boolean {
    const s = String(args[0] ?? '');
    const suffix = String(args[1] ?? '');
    return s.endsWith(suffix);
  },
  b_to_lower(args: LiteralValue[]): string {
    return String(args[0] ?? '').toLowerCase();
  },
  b_to_upper(args: LiteralValue[]): string {
    return String(args[0] ?? '').toUpperCase();
  },
  b_length(args: LiteralValue[]): number {
    const v = args[0];
    if (typeof v === 'string') return v.length;
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return 0;
  },
  b_canonical_json(args: LiteralValue[]): string {
    return JSON.stringify(args[0] ?? null);
  },
  b_in_denylist(args: LiteralValue[]): boolean {
    const value = String(args[0] ?? '');
    const list = Array.isArray(args[1]) ? (args[1] as string[]) : [];
    return list.includes(value);
  },
  b_now(args: LiteralValue[]): number {
    return Date.now();
  },
};
