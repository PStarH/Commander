import type { AgentExecutionContext, RoutingDecision, Tool, ToolDefinition, AgentRuntimeConfig } from './types';
import type { TokenGovernor } from './tokenGovernor';

/**
 * Build system prompt with budget-aware verbosity.
 *
 * KV-cache strategy: the prompt is split into a STABLE PREFIX (cacheable
 * across calls) and a DYNAMIC SUFFIX (varies per call). Anthropic, OpenAI,
 * and other providers cache the system prompt based on content identity
 * (byte-for-byte match of the prefix). Manus (2025) reports that
 * cache-hit rate is the #1 cost metric; this layout maximizes it.
 */
export function buildSystemPrompt(
  ctx: AgentExecutionContext,
  routing: RoutingDecision,
  config: AgentRuntimeConfig,
  tools: Map<string, Tool>,
  governor: TokenGovernor,
  registrySummary?: string,
  activeToolNames?: string[],
): string {
  const budgetState = governor.getState();
  const isLowBudget = budgetState.phase === 'tight' || budgetState.phase === 'critical';

  if (isLowBudget) {
    return [
      `Agent ${ctx.agentId} | Project ${ctx.projectId}`,
      ctx.missionId ? `Mission: ${ctx.missionId}` : '',
      `Budget: ${ctx.tokenBudget}t | Model: ${routing.modelId}`,
      `Tools: ${ctx.availableTools.join(', ')}`,
      `Steps: max ${config.maxStepsPerRun}`,
      'Be terse. JSON/tool calls preferred over prose. Prioritize accuracy.',
    ].filter(Boolean).join('\n');
  }

  const governanceProfile = ctx.contextData.governanceProfile;
  const prefix = buildStableSystemPrefix(config, tools, governanceProfile, registrySummary, activeToolNames);
  const suffix = buildDynamicContext(ctx, routing, config);

  return [prefix, suffix].filter(Boolean).join('\n\n');
}

/**
 * Build the cache-stable system-prompt prefix. Returned string is
 * byte-identical across calls that share the same tool set, governance
 * profile, and runtime config — making it eligible for provider-level
 * prompt caching.
 *
 * Do not add fields that vary per call (agent ID, goal, budget, model).
 */
export function buildStableSystemPrefix(
  config: AgentRuntimeConfig,
  tools: Map<string, Tool>,
  governanceProfile: unknown,
  registrySummary?: string,
  activeToolNames?: string[],
): string {
  const sortedTools = sortToolsForCache(activeToolNames ?? [...tools.keys()], tools);
  const toolBlock = sortedTools.length > 0
    ? sortedTools.map(name => {
        const t = tools.get(name);
        return t ? `- ${t.definition.name}: ${t.definition.description}` : `- ${name}`;
      }).join('\n')
    : '(no tools registered)';

  const examplesBlock = buildExamplesBlock(sortedTools, tools);
  const governanceBlock = stableStringify(governanceProfile) ?? 'No governance constraints.';

  const sections: string[] = [
    'You are an agent in the Commander multi-agent system.',
    '',
    '## Preamble: Think Before Acting',
    '- Before calling any tool, reason in 1\u20132 sentences of plain text about what you are about to do and why.',
    '',
    '## Available Tools',
    toolBlock,
    examplesBlock,
    registrySummary ? registrySummary : '',
    '## Governance',
    governanceBlock,
    '',
    '## Constraints',
    `- Max ${config.maxStepsPerRun} steps per run. Prioritize accuracy when budget is constrained.`,
    '',
    '## Tool Calling Rules',
    '- All required arguments must be provided. Do NOT guess values — ask if ambiguous.',
    '- Independent tools may be called in parallel; dependent calls must be sequential.',
    '- On validation error: correct arguments and retry.',
    '',
    '## Pre-yield checklist',
    '- Goal coverage: have all sub-goals of the task been addressed?',
    '- Artifact propagation: did the relevant tool results get carried into the next step?',
    '- Evidence: are the claims in the summary backed by tool output, not asserted from prior knowledge?',
    '',
    '## Output Format',
    '- Prefer structured output (JSON, tool calls) over verbose prose.',
    '- Match output verbosity to the task: short answers for simple questions, structured detail for complex work.',
    '- Include all relevant details, examples, and code blocks. Do NOT truncate prematurely.',
  ];

  return sections.filter(s => s !== '').join('\n');
}

/** Per-call dynamic context. Appended after the stable prefix. */
export function buildDynamicContext(
  ctx: AgentExecutionContext,
  routing: RoutingDecision,
  config: AgentRuntimeConfig,
): string {
  const lines: string[] = [
    '## Run Context',
    `- Agent: ${ctx.agentId}`,
    `- Project: ${ctx.projectId}`,
  ];
  if (ctx.missionId) lines.push(`- Mission: ${ctx.missionId}`);
  lines.push(
    `- Budget: ${ctx.tokenBudget} tokens`,
    `- Model: ${routing.modelId} (tier: ${routing.tier})`,
    `- Max steps: ${config.maxStepsPerRun}`,
  );
  if (isComplexTask(ctx.goal)) {
    lines.push(
      '',
      '## Multi-File Refactoring Workflow',
      '- Enumerate: list every file you expect to touch before editing.',
      '- Read all first: load each file completely before making changes.',
      '- Cross-file verification: after editing, verify downstream consumers still compile and pass tests.',
    );
  }
  return lines.join('\n');
}

/**
 * Cache key for the stable system-prompt prefix. Two calls with the same
 * key produce the same prefix; the provider cache will hit.
 */
export function computePrefixCacheKey(
  config: AgentRuntimeConfig,
  tools: Map<string, Tool>,
  governanceProfile: unknown,
  registrySummary?: string,
  activeToolNames?: string[],
): string {
  const sortedTools = sortToolsForCache(activeToolNames ?? [...tools.keys()], tools);
  const toolFingerprint = sortedTools.map(name => {
    const t = tools.get(name);
    return t ? `${t.definition.name}|${t.definition.description}` : name;
  });
  const input = JSON.stringify({
    toolDefs: toolFingerprint,
    governance: stableStringify(governanceProfile) ?? 'none',
    registrySummary: registrySummary ?? '',
    maxSteps: config.maxStepsPerRun,
  });
  return sha256Hex(input);
}

/**
 * Build cache-aware user prompt.
 * Variable content goes LAST for maximum cache hit ratio on preceding system block.
 */
export function buildCacheAwareUserPrompt(
  ctx: AgentExecutionContext,
  routing: RoutingDecision,
  governor: TokenGovernor,
): string {
  const budgetState = governor.getState();
  const formatDecision = governor.shouldApply('response_format');

  let formatHint = 'Respond concisely. Use tools when appropriate.';
  if (formatDecision.apply) {
    if (formatDecision.intensity > 0.7) {
      formatHint = 'RESPOND IN SHORTEST FORM POSSIBLE. JSON preferred. No preamble.';
    } else if (formatDecision.intensity > 0.3) {
      formatHint = 'Be brief. Use JSON/tool calls. Skip explanations unless asked.';
    }
  }

  return [
    `## Task (budget: ~${budgetState.remainingTokens}t)`,
    '',
    ctx.goal,
    '',
    formatHint,
  ].filter(Boolean).join('\n');
}

/**
 * Detect whether a task is complex enough to warrant comprehensive output.
 * Complex tasks: analysis, audit, research, multi-file, refactor, design, implementation.
 * Simple tasks: factual lookup, single question, short command.
 */
export function isComplexTask(goal: string): boolean {
  const complexPatterns = [
    /\b(analyze|analysis|audit|review|refactor|redesign|implement|architect|design)\b/i,
    /\b(research|investigate|compare|evaluate|assess|profiler?)\b/i,
    /\b(multi[- ]?(?:file|module|step|layer))\b/i,
    /\b(comprehensive|detailed|thorough|complete)\b/i,
    /\b(security|performance|integration)\b.*\b(audit|test|profile|review)\b/i,
    /\b(cross[- ]?module|end[- ]?to[- ]?end)\b/i,
    /\b(write|create|generate|produce)\b.*\b(report|document|plan|strategy|guide)\b/i,
  ];
  if (goal.length > 200) return true;
  return complexPatterns.some(p => p.test(goal));
}

// ── internal helpers ──

function sortToolsForCache(names: string[], tools: Map<string, Tool>): string[] {
  return [...new Set(names)].sort((a, b) => {
    const da = tools.get(a)?.definition.description ?? '';
    const db = tools.get(b)?.definition.description ?? '';
    if (da !== db) return da.localeCompare(db);
    return a.localeCompare(b);
  });
}

function buildExamplesBlock(sortedTools: string[], tools: Map<string, Tool>): string {
  const examples = sortedTools
    .map(name => tools.get(name))
    .filter((t): t is Tool => !!t)
    .flatMap(t => (t.definition.examples ?? []))
    .slice(0, 8);
  if (examples.length === 0) return '';
  const body = examples.map(ex => {
    const args = Object.entries(ex.arguments)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
      .join(', ');
    return `${ex.name}(${args})`;
  }).join('\n');
  return `\n## Tool Usage Examples\n${body}`;
}

function stableStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return '{' + body + '}';
}

let cryptoModule: typeof import('crypto') | null = null;
function sha256Hex(input: string): string {
  if (!cryptoModule) cryptoModule = require('crypto') as typeof import('crypto');
  return cryptoModule.createHash('sha256').update(input).digest('hex');
}
