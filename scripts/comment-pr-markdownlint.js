const fs = require('fs');

module.exports = async ({ github, context }) => {
  const lines = fs.readFileSync('/tmp/mdlint.txt', 'utf-8').split('\n');
  const findings = lines
    .filter((l) => /cc-no-competitor-bash|cc-readme-superlative-quote/.test(l))
    .slice(0, 20);
  const findingsText = findings.length
    ? findings.map((l) => '- `' + l + '`').join('\n')
    : '- (see workflow log)';

  const body = [
    '## 📋 Commander Documentation Policy — lint failed',
    '',
    'This PR introduces Markdown that violates the `Documentation Policy — competitor citations` contract in `AGENTS.md`. The custom rules in `scripts/markdownlint-rules/` caught the violation.',
    '',
    '### Findings (first 20)',
    '',
    findingsText,
    '',
    '### Reproduce locally',
    '',
    '```bash',
    'node scripts/lint-docs.js',
    '```',
    '',
    '### The contract',
    '',
    'Engineering citation of non-Commander frameworks **in design docs** is **KEEP** (cite patterns like LangGraph `thread_id`, AutoGen `AssistantAgent` isolation, Temporal workflow determinism freely).',
    '',
    'Customer-facing positioning copy **must not** include: ❌ marks in "Commander vs X" tables; "the only multi-agent framework with X" superlatives; brand-bashing words like `碾压` / `crush` / `唯一` / `业界最强` / `World-class`; or named-brand "X fails / breaks" verbal degradations.',
  ].join('\n');

  await github.rest.issues.createComment({
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    body,
  });
};
