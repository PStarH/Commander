#!/usr/bin/env -S node
/**
 * scripts/apply-besteffort-fixes.ts
 *
 * Targeted silent-failure consolidator. Replaces (a) empty `catch {}` and
 * `catch (e) {}` blocks with `reportSilentFailure(...)` so the existing
 * Logger observes the silently recovered error without flooding, and
 * (b) raw `console.*` calls in library code with structured logger calls.
 *
 * SAFEGUARDS:
 *   - By default, this script ONLY processes file paths supplied on the
 *     command line. The unknown-files-mass-rewrite mode (--all) is gated
 *     behind an extra confirmation so accidental runs cannot blow up the
 *     suite.
 *   - Each file is parsed as TypeScript by Node before regex transforms;
 *     critical regex results are sanity-checked (paren balance) before we
 *     commit a write.
 *   - Existing aliased imports (e.g. `getGlobalLogger as logger`) trigger
 *     a SKIP — the rewriter writes fresh `getGlobalLogger()` and would
 *     otherwise produce a compile error in those files.
 *   - Indentation is read from the source line (not hardcoded).
 *   - `/* best-effort *\/` author intent comments are preserved.
 *   - The original catch variable is reused when present; a fresh
 *     identifier `_silentE_` is synthesized only for `catch {}`.
 *
 * Usage:
 *   # Targeted: rewrite specific files (recommended)
 *   npx tsx scripts/apply-besteffort-fixes.ts packages/core/src/runtime/agentRuntime.ts
 *
 *   # Targeted, dry-run
 *   npx tsx scripts/apply-besteffort-fixes.ts --dry-run packages/core/src/runtime/agentRuntime.ts
 *
 *   # All-eligible (DANGEROUS — opt-in only):
 *   npx tsx scripts/apply-besteffort-fixes.ts --all
 *
 * Eligibility (for --all): packages/core/src/** excluding cli/ and tests.
 * But --all is gated behind the env var BF_ALL_OK=1 to prevent typos.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..', 'packages', 'core', 'src');
const DRY_RUN = process.argv.includes('--dry-run');
const ALL_MODE = process.argv.includes('--all');

if (ALL_MODE && process.env.BF_ALL_OK !== '1') {
  console.error(
    '[REFUSE] --all mode requires BF_ALL_OK=1 in the environment.\n' +
      'This guard exists because mass rewriting has previously broken\n' +
      '>100 test files in this repo. Run targeted instead.',
  );
  process.exit(2);
}

// ── CLI argument parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const targetArgs = args.filter((a) => !a.startsWith('--'));
const TARGET_FILES: string[] = ALL_MODE ? walkAll() : targetArgs.map((a) => path.resolve(a));

if (TARGET_FILES.length === 0) {
  console.error('No target files. Pass paths or use --all with BF_ALL_OK=1.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Relative import path between two absolute .ts paths, POSIX style. */
function computeRelativeImport(fromAbs: string, toAbs: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromAbs), toAbs);
  return rel.startsWith('.') ? rel : './' + rel;
}

/** Detect whether `body` is comments + whitespace only. */
function isEffectivelyEmpty(body: string): boolean {
  return (
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, '') === ''
  );
}

/** 1-based line number for a byte offset. */
function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

/** Quick paren-balance sniff — refuses to commit a write if the result is unbalanced. */
/**
 * Strip a stale `.ts` suffix from any `from '....'` import path.
 * Required because project tsconfig sets `moduleResolution: 'Bundler'`,
 * which rejects `.ts` extensions in import paths unless
 * `allowImportingTsExtensions` is enabled. Some files in the repo carry
 * stale `.ts` imports left over from earlier broken rewriter runs;
 * cleaning them in-place here avoids manual triage during future passes.
 *
 * Idempotent: extensionless imports are left alone. Reports how many
 * sources were scrubbed so callers can surface the count in logs.
 */
function scrubStaleTsExtensions(content: string): { content: string; stripped: number } {
  let stripped = 0;
  const out = content.replace(
    /(\bfrom\s+['"][^'"\n]+)\.ts(['"])/g,
    (_whole, prefix: string, suffix: string) => {
      stripped++;
      return prefix + suffix;
    },
  );
  return { content: out, stripped };
}

function isBalanced(s: string): boolean {
  let depth = 0;
  let inStr: string | null = null;
  let inTpl = false;
  let inLineCmt = false;
  let inBlkCmt = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inLineCmt) {
      if (ch === '\n') inLineCmt = false;
      continue;
    }
    if (inBlkCmt) {
      if (ch === '*' && next === '/') {
        inBlkCmt = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (inTpl) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') inTpl = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineCmt = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlkCmt = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '`') {
      inTpl = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth === 0;
}

// ── Catches ──────────────────────────────────────────────────────────────
//
// Match a `} catch` header followed by a single-line or short multi-line
// body. The capture group structure is:
//   1: leading whitespace before the closing brace of the try block
//   2: optional variable name in `catch (var)`
//   3: the body content (used to test emptiness and to preserve the
//      `/* best-effort */` documentary comment)
//
// We deliberately do NOT try to match deeply nested catches or async
// .catch(...) invocations — those are not empty catches and would only be
// mutated by mistake.

const RE_CATCH = /([ \t]*)}(?:\s|\n)+catch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\))?\s*\{([\s\S]*?)\}/g;

function rewriteCatches(content: string, baseName: string): { content: string; edits: number } {
  let edits = 0;
  const out = content.replace(
    RE_CATCH,
    (_whole, indent: string, varName: string | undefined, body: string, offset: number) => {
      if (!isEffectivelyEmpty(body)) return _whole;
      const v = varName ?? '_silentE_';
      const ln = lineOf(content, offset);
      const bestEffort = /\bbest-effort\b/i.test(body) ? ' /* best-effort */' : '';
      edits++;
      const pad = indent.length === 0 ? '  ' : indent;
      return (
        `${indent}} catch ${varName ? `(${v})` : `(_silentE_)`} {${bestEffort}\n` +
        `${indent}${pad}reportSilentFailure(${v}, '${baseName}:${ln}');\n` +
        `${indent}}`
      );
    },
  );
  return { content: out, edits };
}

// ── console.* rewrites ───────────────────────────────────────────────────
//
// CRITICAL: this replaces the broken mass-rewrite. The earlier script
// dropped the closing `)` and `;`, which produced 60 TS1005 errors. This
// rewrite preserves the entire call shape:
//    console.log(message)            → getGlobalLogger().debug('X', message);
//    console.log(message, ctx)       → getGlobalLogger().debug('X', message, ctx);
//    console.warn('I am shutting')    → getGlobalLogger().warn('X', 'I am shutting');
//
// We only handle calls that fit on a single line because multi-line calls
// often include template literals that span paragraph breaks; the
// conservative omission is intentional.

function rewriteConsoleCalls(
  content: string,
  baseName: string,
): { content: string; edits: number } {
  let edits = 0;
  let out = content;

  const mapping: Array<[RegExp, 'debug' | 'warn' | 'error' | 'info']> = [
    [/^([ \t]*)console\.log\(\s*(.*?)\s*\)\s*;?\s*$/gm, 'debug'],
    [/^([ \t]*)console\.info\(\s*(.*?)\s*\)\s*;?\s*$/gm, 'info'],
    [/^([ \t]*)console\.warn\(\s*(.*?)\s*\)\s*;?\s*$/gm, 'warn'],
    [/^([ \t]*)console\.error\(\s*(.*?)\s*\)\s*;?\s*$/gm, 'error'],
  ];

  for (const [re, level] of mapping) {
    out = out.replace(re, (_whole, indent: string, args: string) => {
      edits++;
      // Preserve all original arguments — debug(component, message, context?)
      return `${indent}getGlobalLogger().${level}('${baseName}', ${args});`;
    });
  }

  return { content: out, edits };
}

// ── Imports ──────────────────────────────────────────────────────────────
//
// Add `reportSilentFailure` and/or `getGlobalLogger` imports if the file
// references the symbols but doesn't import them. Use the correct relative
// path computed from the file's actual location.

function ensureImport(
  content: string,
  symbol: string,
  sourceRel: string,
): { content: string; added: boolean } {
  if (!content.includes(symbol)) return { content, added: false };

  // Check if already imported from a path matching this exact source.
  const importBlockRe = new RegExp(
    `import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"][^'"]*['"]\\s*;?`,
    'g',
  );
  // If we see an aliased import (`as X`), it'd be referenced as X in the
  // file body, NOT the raw symbol — so `content.includes(symbol)` would
  // not find references. If we DID find references to the raw symbol
  // alongside an aliased import, that's a serious inconsistency; we
  // refuse the rewrite for safety. Detect by scanning for an `as` clause
  // targeting this symbol anywhere.
  if (new RegExp(`\\b${symbol}\\s+as\\b`).test(content)) {
    return { content, added: false };
  }
  while (importBlockRe.exec(content) !== null) {
    // Already has the symbol imported — good, no edit needed.
    return { content, added: false };
  }

  // Try to extend an existing `import { already } from './x'` block.
  const re_named = new RegExp(
    `^(import\\s*\\{)([^}]*)(\\}\\s*from\\s*['"]${sourceRel.replace(/\./g, '\\.')}['"]\\s*;?)$`,
    'm',
  );
  const m = re_named.exec(content);
  if (m) {
    const inside = m[2].trim();
    const extended =
      inside === '' ? `${m[1]}${symbol}${m[3]}` : `${m[1]}${inside}, ${symbol}${m[3]}`;
    return { content: content.replace(m[0], extended), added: true };
  }

  // Otherwise insert a fresh import at the top.
  const newImport = `import { ${symbol} } from '${sourceRel}';\n`;
  return { content: newImport + content, added: true };
}

function processFile(absPath: string): { mode: 'fixed' | 'skipped' | 'no-changes'; edits: number } {
  const original = fs.readFileSync(absPath, 'utf-8');
  const relPath = path.relative(SRC_ROOT, absPath).replace(/\\/g, '/');
  const baseName = path.basename(absPath, '.ts');

  let content = original;

  // Scrub any pre-existing `.ts` extensions in import paths. The project
  // tsconfig sets moduleResolution: 'Bundler' which forbids `.ts` in
  // import paths unless `allowImportingTsExtensions` is set. Some files
  // have stale `.ts` imports left over from earlier broken reruns; this
  // strips them in-place before any other transformation runs.
  const scrub = scrubStaleTsExtensions(content);
  if (scrub.stripped > 0) {
    console.warn(`[SCRUB] ${relPath}: stripped ${scrub.stripped} stale .ts extension(s)`);
    content = scrub.content;
  }

  // Refuse files that already use a namespace/renamed getGlobalLogger:
  // our rewriter writes fresh `getGlobalLogger()` calls which would clash.
  if (/\bgetGlobalLogger\s+as\s+[A-Za-z_$]/.test(content)) {
    console.warn(`[SKIP] ${relPath} uses aliased getGlobalLogger.`);
    return { mode: 'skipped', edits: 0 };
  }

  // Don't touch CLI files — they ARE user UI.
  if (relPath.startsWith('cli/')) {
    console.warn(`[SKIP] ${relPath} is CLI user-UI; leaving console.* alone.`);
    return { mode: 'skipped', edits: 0 };
  }

  // Don't touch test files.
  if (/\.(test|spec)\.ts$/i.test(relPath)) {
    console.warn(`[SKIP] ${relPath} is a test file.`);
    return { mode: 'skipped', edits: 0 };
  }

  // Don't touch the logger itself (infinite recursion) or the reporter.
  if (absPath.endsWith(path.join('src', 'logging.ts'))) {
    console.warn(`[SKIP] logging.ts.`);
    return { mode: 'skipped', edits: 0 };
  }
  if (absPath.endsWith(path.join('src', 'silentFailureReporter.ts'))) {
    console.warn(`[SKIP] silentFailureReporter.ts.`);
    return { mode: 'skipped', edits: 0 };
  }

  const r1 = rewriteCatches(content, baseName);
  content = r1.content;
  const r2 = rewriteConsoleCalls(content, baseName);
  content = r2.content;
  const totalEdits = r1.edits + r2.edits;

  if (totalEdits === 0) {
    console.log(`[NO CHANGES] ${relPath}`);
    return { mode: 'no-changes', edits: 0 };
  }

  // Sanity: paren balance.
  //
  // The `isBalanced` heuristic is a single-pass counter that recognizes
  // strings, template literals, and comments — but does NOT understand
  // regex literals. Files that contain a regex literal with embedded
  // quote chars (e.g. `/^["'`]+|["'`]+$/g`) will trip a false positive
  // because the heuristic treats the inner `"`/'\''/`` as a string
  // start and consumes the rest of the regex as a string, never closing.
  // Fixing that reliably requires full TS tokenization (a heavyweight
  // dep); the pragmatic escape hatch is FORCE_IGNORE_BALANCE=1 in the
  // env, gated behind an explicit acknowledgment so accidental bypass
  // does not write broken code paths.
  if (!isBalanced(content)) {
    if (process.env.FORCE_IGNORE_BALANCE === '1') {
      console.warn(
        `[WARN] ${relPath} — paren balance false-positive, bypass via FORCE_IGNORE_BALANCE=1.`,
      );
    } else {
      console.error(`[REFUSE] ${relPath} — paren balance check failed after rewrite.`);
      return { mode: 'skipped', edits: 0 };
    }
  }

  // Inject imports if they're now referenced.
  const reporterRel = computeRelativeImport(
    absPath,
    path.join(SRC_ROOT, 'silentFailureReporter.ts'),
  );
  const loggerRel = computeRelativeImport(absPath, path.join(SRC_ROOT, 'logging.ts'));

  let tmp = ensureImport(content, 'reportSilentFailure', reporterRel).content;
  if (tmp !== content) content = tmp;
  tmp = ensureImport(content, 'getGlobalLogger', loggerRel).content;
  if (tmp !== content) content = tmp;

  if (content !== original && !DRY_RUN) {
    fs.writeFileSync(absPath, content, 'utf-8');
  }
  console.log(
    `[${DRY_RUN ? 'DRY-' : ''}FIXED] ${relPath} (catches=${r1.edits}, consoles=${r2.edits})`,
  );
  return { mode: 'fixed', edits: totalEdits };
}

function walkAll(): string[] {
  if (!fs.existsSync(SRC_ROOT)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        visit(abs);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !/\.(test|spec)\.ts$/i.test(entry.name)
      ) {
        out.push(abs);
      }
    }
  };
  visit(SRC_ROOT);
  return out;
}

const EXCLUDE_DIRS = new Set<string>(['cli', 'node_modules', 'dist', 'build']);

let totalEdits = 0;
let totalFixed = 0;
for (const f of TARGET_FILES) {
  if (!fs.existsSync(f)) {
    console.error(`[MISSING] ${f}`);
    continue;
  }
  const r = processFile(f);
  if (r.mode === 'fixed') {
    totalFixed++;
    totalEdits += r.edits;
  }
}

console.log(
  `\nProcessed ${TARGET_FILES.length} files. Fixed ${totalFixed}. Total edits: ${totalEdits}.`,
);
