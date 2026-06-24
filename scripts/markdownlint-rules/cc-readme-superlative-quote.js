'use strict';

// Custom markdownlint rule — Commander Documentation Policy
// Rule ID: cc-readme-superlative-quote
// Scope: README*.md only (the rule self-skips non-README files via filename check)
// What it catches: a line starting with `>` (Markdown blockquote / pull-quote)
// inside a README* file that contains a superlative claim.
//   `^>.*(the only|the fastest|#1 in.*benchmark|best-in-class|industry-leading|world-class)`
// Per AGENTS.md § "Documentation Policy — competitor citations", such phrasing
// in customer-facing copy is a policy violation. Use descriptive language
// (e.g. "Real-time streaming is built into the runtime, not bolted on.") instead.

module.exports = {
  names: ['cc-readme-superlative-quote'],
  description:
    'Reject superlative claims in README*.md blockquotes per AGENTS.md Documentation Policy',
  tags: ['custom', 'commander-doc-policy'],
  function: function Rule(params, onError) {
    const fname = params.name || '';
    const isReadme = /^README[^/]*\.md$/i.test(fname);
    if (!isReadme) return;
    const re =
      /^>.*(the only|the fastest|#1 in.*benchmark|best-in-class|industry-leading|world-class)/i;
    params.lines.forEach(function (line, idx) {
      const m = line.match(re);
      if (!m) return;
      onError({
        lineNumber: idx + 1,
        detail:
          'Superlative phrase "' +
          m[1].trim() +
          '" inside a README blockquote. ' +
          'AGENTS.md Documentation Policy: SCRUB. Use descriptive and specific phrasing.',
        context: line.replace(/^\s+/, '').slice(0, 160),
      });
    });
  },
};
