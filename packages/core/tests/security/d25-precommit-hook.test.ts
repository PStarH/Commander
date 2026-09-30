/**
 * Audit #6 hardening — pre-commit d25 plaintext API-key gate parity tests.
 *
 * Mirrors the existing `packages/core/tests/security/d25-api-key-grep.test.ts`
 * fixture matrix in vitest form so we catch the case where the pre-commit
 * gate in `scripts/precommitHook.ts` and the CI vitest gate in
 * `tests/security/d25-api-key-grep.test.ts` drift apart.
 *
 * Why duplicate instead of import: `scripts/precommitHook.ts` is a
 * side-effectful script that pipes argv through git, so the regex set
 * and the scanner function are most safely proxied through this local
 * mirror that re-acquires the same constants. If the production regex
 * set changes, this test MUST be updated alongside it; the
 * `MIRROR_DATE` constant records the duplication window.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Mirror the production regex set from `scripts/precommitHook.ts`. If you
// touch one, touch the other: the parity case below reads the production
// source and fails when the two lists drift.
const MIRROR_DATE = '2026-09-18';

const PRODUCTION_PRECOMMIT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../../scripts/precommitHook.ts', import.meta.url)),
  'utf8',
);

interface D25PatternDef {
  readonly id: string;
  readonly prefix: string;
  readonly regex: RegExp;
  readonly exampleEnvVar: string;
}

const D25_PATTERNS: readonly D25PatternDef[] = [
  {
    id: 'openai-sk',
    prefix: 'sk-',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    exampleEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic-sk-ant',
    prefix: 'sk-ant-',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    exampleEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'github-gh',
    prefix: 'gh*_',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
    exampleEnvVar: 'GITHUB_TOKEN',
  },
  {
    id: 'aws-access-key',
    prefix: '(A|S)KIA',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    exampleEnvVar: 'AWS_ACCESS_KEY_ID',
  },
  {
    id: 'slack-xox',
    prefix: 'xox*-',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{16,}/g,
    exampleEnvVar: 'SLACK_BOT_TOKEN',
  },
  {
    id: 'mimo-tp',
    prefix: 'tp-',
    regex: /\btp-[a-z0-9]{20,}/g,
    exampleEnvVar: 'MIMO_API_KEY',
  },
  {
    id: 'huggingface-hf',
    prefix: 'hf_',
    regex: /\bhf_[A-Za-z0-9]{20,}/g,
    exampleEnvVar: 'HUGGINGFACE_TOKEN',
  },
  {
    id: 'google-aiza',
    prefix: 'AIza',
    regex: /\bAIza[0-9A-Za-z_-]{30,}/g,
    exampleEnvVar: 'GOOGLE_API_KEY',
  },
  {
    id: 'stripe-live',
    prefix: 'sk_live_',
    regex: /\bsk_live_[A-Za-z0-9]{16,}/g,
    exampleEnvVar: 'STRIPE_SECRET_KEY',
  },
];

function scan(
  content: string,
): { file: string; line: number; matched: string; patternId: string }[] {
  const hits: { file: string; line: number; matched: string; patternId: string }[] = [];
  for (const def of D25_PATTERNS) {
    def.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.regex.exec(content)) !== null) {
      const before = content.slice(0, m.index);
      const lineNumber = before.split('\n').length;
      const trimmed = before
        .slice(before.lastIndexOf('\n') + 1)
        .trim()
        .toLowerCase();
      // Production skip semantics (mirrored from d25-api-key-grep.test.ts):
      // any line that starts with a comment marker is treated as a comment
      // and excluded from the scan. This handles fixture and tutorial
      // references like `// example: sk-...` and `// fake token: ghp_...`.
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }
      hits.push({
        file: 'mirror.ts',
        line: lineNumber,
        matched: m[0].slice(0, 32) + (m[0].length > 32 ? '…' : ''),
        patternId: def.id,
      });
    }
  }
  return hits;
}

describe('Audit #6 — d25 precommit regex parity', () => {
  it('mirrors the production pre-commit pattern set exactly', () => {
    const production = [...PRODUCTION_PRECOMMIT_SOURCE.matchAll(/id:\s*'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(production.length).toBeGreaterThan(0);
    expect(production).toEqual(D25_PATTERNS.map((def) => def.id));
    for (const def of D25_PATTERNS) {
      expect(PRODUCTION_PRECOMMIT_SOURCE).toContain(def.regex.source);
    }
    expect(MIRROR_DATE).toBe('2026-09-18');
  });

  // ── Positive fixtures: each pattern MUST match its canonical prefix. ──
  const POSITIVES: ReadonlyArray<[string, string]> = [
    ['openai-sk', 'sk-proj-abcdef0123456789abcdef0123456789'],
    ['openai-sk', 'sk-abcdef0123456789abcdef0123456789'],
    ['anthropic-sk-ant', 'sk-ant-abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghp_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'gho_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghu_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghs_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghr_abcdef0123456789abcdef0123456789'],
    ['aws-access-key', 'AKIA0123456789ABCDEF'],
    ['aws-access-key', 'ASIA0123456789ABCDEF'],
    ['slack-xox', 'xox' + 'b-' + 'TEST-FIXTURE-NOT-A-REAL-SLACK-TOKEN-0123456'],
    ['mimo-tp', 'tp-' + 'abcdefghij0123456789'],
    ['huggingface-hf', 'hf_' + 'abcdefghij0123456789abcdef'],
    ['google-aiza', 'AIza' + 'SyDabcdefghij0123456789abcdefghij0'],
    ['stripe-live', 'sk_live_' + 'abcdefghij0123456789'],
  ];
  for (const [patternId, fixture] of POSITIVES) {
    it(`POSITIVE: ${patternId} matches`, () => {
      expect(scan(fixture).some((h) => h.patternId === patternId)).toBe(true);
    });
  }

  // ── Negative fixtures: env-var references + comments MUST be skipped. ──
  const NEGATIVES: ReadonlyArray<[string, string]> = [
    ['process-OPENAI_API_KEY', 'console.log(process.env.OPENAI_API_KEY);'],
    ['process-ANTHROPIC_API_KEY', "process.env.ANTHROPIC_API_KEY || ''"],
    ['comment-fake', '// sk-1234567890abcdef1234567890abcdef12 is fake'],
    ['comment-mock', '// sk-ant-abcdef0123456789abcdef0123456789 mocked api'],
    ['comment-example', '// xoxb-abcdef0123456789abcdef0123456789 example token'],
  ];
  for (const [label, source] of NEGATIVES) {
    it(`NEGATIVE: ${label} does not trip the gate`, () => {
      expect(scan(source).length).toBe(0);
    });
  }

  // ── End-to-end: a TS file with a hard-coded embed-style secret MUST trip. ──
  it('trip: hardcoded sk-proj literal in source → 1 hit file:line', () => {
    const source = [
      '/**',
      ' * Test fixture — ignore the line below.',
      ' */',
      "const KEY = 'sk-proj-abcdef0123456789abcdef0123456789';",
      'export default KEY;',
    ].join('\n');
    const hits = scan(source);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.patternId).toBe('openai-sk');
  });

  it('trip: hardcoded AKIA literal in source → 1 hit', () => {
    const source = "const AWS_ACCESS_KEY_ID = 'AKIA0123456789ABCDEF';";
    const hits = scan(source);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.patternId).toBe('aws-access-key');
  });

  it('trip: hardcoded ghp_ literal → matched but no leak in matched field', () => {
    const source = "const GHO_TOKEN = 'ghp_abcdef0123456789abcdef0123456789';";
    const hits = scan(source);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.patternId).toBe('github-gh');
    // truncated to 32 chars per production gate
    expect(hits[0]!.matched.length).toBeLessThanOrEqual(33);
  });
});
