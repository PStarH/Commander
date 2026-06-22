'use strict';

// Custom markdownlint rule — Commander Documentation Policy
// Rule ID: cc-no-competitor-bash
// Scope: README*.md only (the rule self-skips non-README files via a `params.name`
//   filename check; per AGENTS.md § "Documentation Policy — competitor citations"
//   engineering citations in design docs (RFCs, optimization plans, research notes)
//   are KEEP and intentionally not policed here).
// What it catches: a competitor brand name followed (within the same line) by a
// "bashful" word that would have been a customer-facing bashing posture.
//   `(LangGraph|CrewAI|AutoGen|LangChain|Claude Code|Cline|Aider)\s+(fails|broken|terrible|useless|sucks|crush|beat|碾压)`
// Per AGENTS.md § "Documentation Policy — competitor citations", enemy-product
// degradation in customer-facing copy is a policy violation (SCRUB-on-sight).
// Engineering citations of competitor design patterns (e.g. "LangGraph thread_id
// pattern") are KEEP and must not script-mediate out via this rule.

module.exports = {
  names: ['cc-no-competitor-bash'],
  description: 'Reject competitor-bashing patterns in *.md per AGENTS.md Documentation Policy',
  tags: ['custom', 'commander-doc-policy'],
  function: function Rule(params, onError) {
    const fname = params.name || '';
    const isReadme = /^README[^/]*\.md$/i.test(fname);
    if (!isReadme) return;
    const re = /(LangGraph|CrewAI|AutoGen|LangChain|Claude Code|Cline|Aider)\s+(fails|broken|terrible|useless|sucks|crush|beat|碾压)/i;
    params.lines.forEach(function (line, idx) {
      const m = line.match(re);
      if (!m) return;
      onError({
        lineNumber: idx + 1,
        detail:
          'Competitor name "' + m[1] + '" is followed by bashful term "' + m[2] + '". ' +
          'AGENTS.md Documentation Policy: SCRUB on customer-facing copy. ' +
          'Engineering citations of competitor design patterns remain OK.',
        context: line.replace(/^\s+/, '').slice(0, 160),
      });
    });
  },
};
