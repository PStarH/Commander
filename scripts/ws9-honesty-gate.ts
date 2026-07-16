#!/usr/bin/env tsx
/**
 * ws9-honesty-gate.ts — WS9 §9.3 anti-overclaim gate.
 *
 * Scans ENTERPRISE_READINESS.md, README* files, docs/, and WS9 compliance
 * report JSONs for overclaims forbidden by WS9 §9.3 of
 * `spec/ws9-tenant-livefire-compliance.md`:
 *
 *   1. evidenceLevel mismatch — a claim marked `evidenceLevel=simulated` or
 *      `evidenceLevel=ci-worm-sim` that fills a ✅ (verified/passed) slot in
 *      `ENTERPRISE_READINESS.md`. Only `evidenceLevel=live` may fill a ✅ slot.
 *   2. tamperProof/compliant hardcoding — a JSON compliance report that
 *      asserts `"tamperProof": true` or `"compliant": true` without a live
 *      `verify()` result (`verifyResult.ok=true` AND `evidenceLevel="live"`).
 *   3. multi-tenant claims without a WS9 live baseline — occurrences of
 *      "multi-tenant"/"multi-tenancy" in `ENTERPRISE_READINESS.md` that claim
 *      ✅/verified without referencing `docs/baselines/ws9/`. Reported as WARN
 *      (the ENTERPRISE_READINESS.md matrix update is Phase 3 work, per §8).
 *
 * Exit codes:
 *   0  PASS (no FAIL violations; warnings may be present)
 *   1  FAIL (one or more FAIL violations)
 *   2  error (unreadable file, invalid argument, etc.)
 *
 * Run: tsx scripts/ws9-honesty-gate.ts [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

// ─── Types ─────────────────────────────────────────────────────────────

interface HonestyViolation {
  rule: string;
  file: string;
  line: number;
  column: number;
  severity: 'FAIL';
  match: string;
  context: string;
  reason: string;
}

interface HonestyWarning {
  rule: string;
  file: string;
  line: number;
  column: number;
  severity: 'WARN';
  match: string;
  context: string;
  reason: string;
  suggestion: string;
}

interface HonestyGateResult {
  verdict: 'PASS' | 'FAIL';
  scannedFiles: string[];
  violations: HonestyViolation[];
  warnings: HonestyWarning[];
  scannedAt: string;
}

// ─── Constants ─────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '..');
const ENTERPRISE_READINESS_PATH = join(PROJECT_ROOT, 'ENTERPRISE_READINESS.md');
const DOCS_DIR = join(PROJECT_ROOT, 'docs');
const WS9_BASELINE_DIR = join(DOCS_DIR, 'baselines', 'ws9');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
]);

const CHECK_MARK = '✅';

// ─── Patterns ──────────────────────────────────────────────────────────

// Literal evidenceLevel marker with a non-live value. Covers
// `evidenceLevel=simulated`, `evidenceLevel: "simulated"`,
// `evidenceLevel='ci-worm-sim'`, etc.
const EVIDENCE_LEVEL_NON_LIVE = /evidenceLevel\s*[=:]\s*['"]?(simulated|ci-worm-sim)['"]?/i;

// Word-boundary "simulated" / "ci-worm-sim" used as an evidence descriptor.
// The `(?<![-])` lookbehind excludes CLI flags like `--simulated` /
// `-simulated` (which are execution modes, not evidence-level claims).
const SIMULATED_WORD = /(?<![-])\b(simulated|ci-worm-sim)\b/i;

// Item IDs used in ENTERPRISE_READINESS.md tables
// (SOC2-N, TEN-N, DATA-N, OBS-N, SLO-N, Pn-N, BENCH-CAP-N, AUDIT-X, KEYPATH-X).
const ITEM_ID = /(?:SOC2-|TEN-|DATA-|OBS-|SLO-|P[012]-|BENCH-CAP-|AUDIT-|KEYPATH-)[A-Z0-9-]+/g;

// "multi-tenant" / "multi-tenancy" not preceded by '@' (excludes the
// `@multi-tenancy` owner tag in the readiness table).
const MULTI_TENANT = /(?<!@)\b(multi-tenant|multi-tenancy)\b/i;

const WS9_BASELINE_REF = /docs\/baselines\/ws9\//;

// ─── File helpers ─────────────────────────────────────────────────────

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function walkFiles(dir: string, ext: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkFiles(full, ext, out);
    } else if (st.isFile() && entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function collectMarkdownFiles(): string[] {
  const files: string[] = [];
  if (existsSync(ENTERPRISE_READINESS_PATH)) files.push(ENTERPRISE_READINESS_PATH);
  // README*.md in project root (README.md, README-zh.md, README-ja.md, ...).
  try {
    for (const entry of readdirSync(PROJECT_ROOT)) {
      if (/^README.*\.md$/i.test(entry)) {
        files.push(join(PROJECT_ROOT, entry));
      }
    }
  } catch {
    // ignore unreadable root
  }
  // docs/**/*.md
  for (const f of walkFiles(DOCS_DIR, '.md')) {
    if (!files.includes(f)) files.push(f);
  }
  return files;
}

function collectWs9JsonFiles(): string[] {
  // Any .json file under docs/baselines/ws9/ (includes compliance-evidence/).
  return walkFiles(WS9_BASELINE_DIR, '.json');
}

interface TextMatch {
  line: number;
  column: number;
  match: string;
  context: string;
}

function findLineMatches(
  text: string,
  regex: RegExp,
): TextMatch[] {
  const results: TextMatch[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      results.push({
        line: i + 1,
        column: m.index + 1,
        match: m[0],
        context: line.trim().slice(0, 200),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return results;
}

// ─── Rule 1: evidenceLevel mismatch in ✅ slots ───────────────────────

const RULE_1 = 'evidence-level-mismatch';

/**
 * Rule 1: any claim marked `evidenceLevel=simulated` / `evidenceLevel=ci-worm-sim`
 * (or textually described as simulated evidence) that fills a ✅ slot in
 * ENTERPRISE_READINESS.md is a FAIL. Only `evidenceLevel=live` may fill ✅.
 *
 * Detection has two arms:
 *  (a) Direct: a ✅-marked line that itself carries an `evidenceLevel` non-live
 *      marker (any scanned markdown) or the word "simulated"/"ci-worm-sim"
 *      (ENTERPRISE_READINESS.md only, to avoid false positives on docs that
 *      honestly discuss simulated testing).
 *  (b) Cross-reference (ENTERPRISE_READINESS.md only): an honesty note / prose
 *      that describes an item's evidence as "simulated" and references the
 *      item ID. If that item's table row is marked ✅, it is an overclaim.
 */
function checkEvidenceLevelMismatch(markdownFiles: string[]): HonestyViolation[] {
  const violations: HonestyViolation[] = [];
  for (const file of markdownFiles) {
    const text = readText(file);
    if (!text) continue;
    const lines = text.split('\n');
    const isEnterpriseReadiness = file === ENTERPRISE_READINESS_PATH;

    // (a) Direct: ✅-marked lines that carry a non-live evidence marker.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.includes(CHECK_MARK)) continue;

      const marker = EVIDENCE_LEVEL_NON_LIVE.exec(line);
      if (marker) {
        violations.push({
          rule: RULE_1,
          file,
          line: i + 1,
          column: (marker.index ?? 0) + 1,
          severity: 'FAIL',
          match: marker[0],
          context: line.trim().slice(0, 200),
          reason: `✅ slot carries non-live evidence marker "${marker[0]}"; only evidenceLevel=live may fill a ✅ slot`,
        });
        continue;
      }

      // Loose-keyword check is ENTERPRISE_READINESS.md-only to avoid noisy
      // false positives on docs that legitimately describe simulated testing.
      if (isEnterpriseReadiness) {
        const kw = SIMULATED_WORD.exec(line);
        if (kw) {
          violations.push({
            rule: RULE_1,
            file,
            line: i + 1,
            column: (kw.index ?? 0) + 1,
            severity: 'FAIL',
            match: kw[0],
            context: line.trim().slice(0, 200),
            reason: `✅ slot describes evidence as "${kw[0]}"; simulated/ci-worm-sim evidence may not fill a ✅ slot (downgrade to 🟡 or upgrade with evidenceLevel=live)`,
          });
        }
      }
    }

    // (b) Cross-reference: simulated-claimed item IDs whose ✅ rows are overclaims.
    if (isEnterpriseReadiness) {
      const simulatedItems = collectSimulatedItemClaims(lines);
      if (simulatedItems.size > 0) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.startsWith('|')) continue; // table row
          if (!line.includes(CHECK_MARK)) continue;
          const idsInRow = line.match(ITEM_ID);
          if (!idsInRow) continue;
          for (const id of idsInRow) {
            const claim = simulatedItems.get(id);
            if (claim) {
              violations.push({
                rule: RULE_1,
                file,
                line: i + 1,
                column: 1,
                severity: 'FAIL',
                match: id,
                context: line.trim().slice(0, 200),
                reason: `✅ slot for ${id} is described as simulated at line ${claim.line} ("${claim.match}"); simulated evidence may not fill a ✅ slot (downgrade to 🟡 or supply evidenceLevel=live)`,
              });
            }
          }
        }
      }
    }
  }
  return violations;
}

/**
 * Build a map of item-id → {line, match} for prose/blockquote lines that
 * explicitly frame an item's evidence as "simulated" / "ci-worm-sim".
 *
 * Requires an evidence-descriptor context (honesty / evidence / SOC / proof /
 * harness / predicate / fuzz / InMemory / not-a-substitute / verify) in the
 * ±2 line window so that unrelated "simulated load" mentions do not fire.
 */
function collectSimulatedItemClaims(
  lines: string[],
): Map<string, { line: number; match: string }> {
  const out = new Map<string, { line: number; match: string }>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Use the lookbehind-aware pattern so CLI flags like `--simulated` do not
    // register as evidence-level claims.
    const isSimulatedClaim =
      SIMULATED_WORD.test(line) || EVIDENCE_LEVEL_NON_LIVE.test(line);
    if (!isSimulatedClaim) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    const isEvidenceContext =
      /honesty|evidence|soc|proof|harness|predicate|fuzz|InMemory|not\s+a\s+substitute|verify/i.test(
        window,
      );
    if (!isEvidenceContext) continue;
    const ids = window.match(ITEM_ID);
    if (!ids) continue;
    const matchText = line.trim().slice(0, 120);
    for (const id of ids) {
      if (!out.has(id)) out.set(id, { line: i + 1, match: matchText });
    }
  }
  return out;
}

// ─── Rule 2: tamperProof/compliant hardcoding in JSON ──────────────────

const RULE_2_TAMPERPROOF = 'tamperproof-hardcoded';
const RULE_2_COMPLIANT = 'compliant-hardcoded';

/**
 * Rule 2: any JSON compliance report that asserts `"tamperProof": true` or
 * `"compliant": true` where the value is NOT derived from a live `verify()`
 * result (i.e., the JSON does not contain a `verifyResult` field with
 * `ok: true` AND `evidenceLevel: "live"`) is a FAIL.
 *
 * A reporter may not self-declare tamper-proof / compliant status (KC-5,
 * WS8 §36, WS9 §7).
 */
function checkTamperProofHardcoding(jsonFiles: string[]): HonestyViolation[] {
  const violations: HonestyViolation[] = [];
  for (const file of jsonFiles) {
    const text = readText(file);
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Malformed JSON is out of scope for this gate (the baseline schema
      // validator handles structural validity). Skip silently.
      continue;
    }
    const derivedFromLiveVerify = jsonContainsLiveVerify(parsed);
    if (derivedFromLiveVerify) continue;

    for (const m of findLineMatches(text, /"tamperProof"\s*:\s*true\b/)) {
      violations.push({
        rule: RULE_2_TAMPERPROOF,
        file,
        line: m.line,
        column: m.column,
        severity: 'FAIL',
        match: '"tamperProof": true',
        context: m.context,
        reason:
          '"tamperProof": true is not derived from a live verify() result (verifyResult.ok=true AND evidenceLevel="live"); a compliance report may not self-declare tamper-proof (KC-5, WS9 §7)',
      });
    }
    for (const m of findLineMatches(text, /"compliant"\s*:\s*true\b/)) {
      violations.push({
        rule: RULE_2_COMPLIANT,
        file,
        line: m.line,
        column: m.column,
        severity: 'FAIL',
        match: '"compliant": true',
        context: m.context,
        reason:
          '"compliant": true is not derived from a live verify() result (verifyResult.ok=true AND evidenceLevel="live"); a reporter may not declare itself compliant (WS8 §36, WS9 §7)',
      });
    }
  }
  return violations;
}

/**
 * Recursively determine whether the parsed JSON contains a `verifyResult`
 * object with `ok: true` AND `evidenceLevel: "live"` (the live-verify
 * derivation required by §9.3 for tamperProof/compliant claims).
 */
function jsonContainsLiveVerify(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const vr = obj.verifyResult;
  if (vr !== null && typeof vr === 'object') {
    const v = vr as Record<string, unknown>;
    if (v.ok === true && v.evidenceLevel === 'live') return true;
  }
  // Accept a top-level evidenceLevel="live" paired with verifyResult.ok=true.
  if (
    obj.evidenceLevel === 'live' &&
    vr !== null &&
    typeof vr === 'object' &&
    (vr as Record<string, unknown>).ok === true
  ) {
    return true;
  }
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child !== null && typeof child === 'object') {
      if (jsonContainsLiveVerify(child)) return true;
    }
  }
  return false;
}

// ─── Rule 3: multi-tenant claims without WS9 live baseline ─────────────

const RULE_3 = 'multi-tenant-without-live-baseline';

/**
 * Rule 3: any occurrence of "multi-tenant" / "multi-tenancy" in
 * ENTERPRISE_READINESS.md that claims ✅ or "verified" without referencing a
 * WS9 live baseline path (`docs/baselines/ws9/`) is downgraded to Alpha.
 * Reported as WARN — the ENTERPRISE_READINESS.md update is Phase 3 work (§8).
 */
function checkMultiTenantClaims(): HonestyWarning[] {
  const warnings: HonestyWarning[] = [];
  const text = readText(ENTERPRISE_READINESS_PATH);
  if (!text) return warnings;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = MULTI_TENANT.exec(line);
    if (!m) continue;
    const claimsVerified =
      line.includes(CHECK_MARK) || /\b(verified|passed|complete)\b/i.test(line);
    if (!claimsVerified) continue;
    if (WS9_BASELINE_REF.test(line)) continue;
    warnings.push({
      rule: RULE_3,
      file: ENTERPRISE_READINESS_PATH,
      line: i + 1,
      column: (m.index ?? 0) + 1,
      severity: 'WARN',
      match: m[0],
      context: line.trim().slice(0, 200),
      reason:
        'multi-tenant claim marked ✅/verified without a docs/baselines/ws9/ live baseline reference',
      suggestion:
        'Downgrade to "Alpha" status, or add a docs/baselines/ws9/ live baseline pointer (Phase 3 ENTERPRISE_READINESS.md update, §8)',
    });
  }
  return warnings;
}

// ─── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: tsx scripts/ws9-honesty-gate.ts [--json]');
    console.log('  --json   machine-readable HonestyGateResult output');
    console.log('Exit codes: 0 PASS, 1 FAIL, 2 error');
    process.exit(0);
  }

  let markdownFiles: string[];
  let jsonFiles: string[];
  try {
    markdownFiles = collectMarkdownFiles();
    jsonFiles = collectWs9JsonFiles();
  } catch (err) {
    console.error(`ERROR collecting scan targets: ${(err as Error).message}`);
    process.exit(2);
  }

  const scannedFiles = [...markdownFiles, ...jsonFiles].sort();

  let violations: HonestyViolation[];
  let warnings: HonestyWarning[];
  try {
    violations = [
      ...checkEvidenceLevelMismatch(markdownFiles),
      ...checkTamperProofHardcoding(jsonFiles),
    ];
    warnings = checkMultiTenantClaims();
  } catch (err) {
    console.error(`ERROR running honesty rules: ${(err as Error).message}`);
    process.exit(2);
  }

  const result: HonestyGateResult = {
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    scannedFiles: scannedFiles.map((f) => relative(PROJECT_ROOT, f)),
    violations,
    warnings,
    scannedAt: new Date().toISOString(),
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  process.exit(violations.length === 0 ? 0 : 1);
}

function printHuman(result: HonestyGateResult): void {
  console.log(`\nWS9 §9.3 Honesty Gate`);
  console.log(`=====================`);
  console.log(`Scanned files: ${result.scannedFiles.length}`);
  console.log(`Violations (FAIL): ${result.violations.length}`);
  console.log(`Warnings (WARN): ${result.warnings.length}`);
  console.log(`Verdict: ${result.verdict}`);
  console.log(`Scanned at: ${result.scannedAt}\n`);

  if (result.violations.length > 0) {
    console.log('── FAIL Violations ──────────────────────────────');
    for (const v of result.violations) {
      const where = `${relative(PROJECT_ROOT, v.file)}:${v.line}:${v.column}`;
      console.log(`  [${v.rule}] ${where}`);
      console.log(`    match: ${v.match}`);
      console.log(`    reason: ${v.reason}`);
      console.log(`    context: ${v.context}`);
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('── Warnings (Phase 3 ENTERPRISE_READINESS.md work) ──');
    for (const w of result.warnings) {
      const where = `${relative(PROJECT_ROOT, w.file)}:${w.line}:${w.column}`;
      console.log(`  [${w.rule}] ${where}`);
      console.log(`    match: ${w.match}`);
      console.log(`    reason: ${w.reason}`);
      console.log(`    suggestion: ${w.suggestion}`);
    }
    console.log('');
  }

  if (result.verdict === 'PASS') {
    console.log('✓ No overclaim violations found.');
    if (result.warnings.length > 0) {
      console.log(
        `  ${result.warnings.length} warning(s) — see above (Phase 3 work).`,
      );
    }
  } else {
    console.log('✗ Overclaim violations present — see above.');
  }
}

main();
