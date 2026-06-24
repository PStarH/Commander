'use strict';

// Commander Documentation Policy Linter (standalone Node.js wrapper).
//
// Why this exists: `markdownlint-cli2`'s `customRules` JSON config field does not
// actually load user-supplied rule modules in v0.18.1 in this repo (verified by
// diagnostic: all five documented config paths -- relative, ./ -prefixed, glob,
// absolute, directory -- produced zero custom-rule hits, while standard MD-* rules
// fired normally). Rather than fight the loader, this script requires the same
// rule modules directly via Node's require() and invokes each rule's
// `function(params, onError)` with a markdownlint-shaped params object. The rule
// files themselves remain the single source of truth, so a future migration back
// to markdownlint-cli2 (when the loader is fixed) requires ZERO changes to the
// regex or rule bodies.
//
// Output format is the same path:line:col <rule-id> <detail> line shape that
// markdownlint-cli2 emits, so the workflow's grep-based hit counting still works.
//
// Exits:
//   0  no violations found
//   1  one or more violations (CI failure)
//   2  module-load or runtime error (workflow should fail loudly, no silent miss)

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const RULE_DIR = path.join(REPO_ROOT, 'scripts', 'markdownlint-rules');
const RULES = [
  { id: 'cc-no-competitor-bash', mod: 'cc-no-competitor-bash.js' },
  { id: 'cc-readme-superlative-quote', mod: 'cc-readme-superlative-quote.js' },
];

// Recursively walk the repo for README*.md at any depth.
// Hard-coded skip set for vendored/build directories -- extend if needed.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.pnpm-store']);

function findReadmes(root) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.error('[lint-docs] WARN: cannot read dir', dir, '--', e.message);
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile() && /^README[^/]*\.md$/i.test(ent.name)) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push(rel);
      }
    }
  }
  walk(root);
  return out;
}

// Load each rule. Module-load errors MUST cause exit(2) rather than silent miss --
// recovering from the markdownlint-cli2 silent-miss bug is the entire reason this
// wrapper exists.
function loadRules() {
  const loaded = [];
  for (const r of RULES) {
    try {
      const p = path.join(RULE_DIR, r.mod);
      delete require.cache[require.resolve(p)];
      const m = require(p);
      if (!m || !Array.isArray(m.names) || typeof m.function !== 'function') {
        throw new Error('rule module missing `names` array or `function` property');
      }
      loaded.push({ id: r.id, names: m.names, fn: m.function, description: m.description || '' });
    } catch (e) {
      console.error('[lint-docs] FATAL: failed to load rule', r.id, '--', e.message);
      console.error(
        '  stack:',
        String(e.stack || '')
          .split('\n')
          .slice(0, 6)
          .join('\n'),
      );
      process.exit(2);
    }
  }
  return loaded;
}

function lint(readmes, rules) {
  let violations = 0;
  for (const rel of readmes) {
    const abs = path.join(REPO_ROOT, rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch (e) {
      console.error('[lint-docs] FATAL: cannot read', rel, '--', e.message);
      process.exit(2);
    }
    const lines = content.split('\n');
    const params = { name: path.basename(rel), lines };
    for (const r of rules) {
      const findings = [];
      try {
        r.fn(params, function onError(err) {
          findings.push({
            lineNumber: err.lineNumber || 0,
            detail: (err.detail || r.description || '(no detail)').toString(),
            context: (err.context || '').toString().slice(0, 160),
          });
        });
      } catch (e) {
        console.error('[lint-docs] WARN: rule', r.id, 'threw on', rel, '--', e.message);
        continue;
      }
      for (const f of findings) {
        console.log(rel + ':' + f.lineNumber + ':1 ' + r.id + ' ' + f.detail);
        violations++;
      }
    }
  }
  return violations;
}

(function main() {
  const readmes = findReadmes(REPO_ROOT);
  if (readmes.length === 0) {
    console.log('[lint-docs] no README*.md files found; nothing to lint');
    process.exit(0);
  }
  const rules = loadRules();
  const violations = lint(readmes, rules);
  console.log('');
  console.log('Total files linted: ' + readmes.length + ', violations: ' + violations);
  process.exit(violations > 0 ? 1 : 0);
})();
