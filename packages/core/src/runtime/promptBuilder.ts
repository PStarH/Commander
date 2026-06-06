import type { AgentExecutionContext, RoutingDecision, Tool, ToolDefinition, AgentRuntimeConfig } from './types';
import type { TokenGovernor } from './tokenGovernor';

/**
 * Build system prompt with budget-aware verbosity.
 * Stable content goes FIRST for maximum LLM provider cache hits.
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

  const govProfile = ctx.contextData.governanceProfile
    ? JSON.stringify(ctx.contextData.governanceProfile)
    : 'No governance constraints.';

  const toolExamples = ctx.availableTools
    .map(name => tools.get(name))
    .filter((t): t is Tool => !!t)
    .flatMap(t => (t.definition.examples ?? []))
    .slice(0, 8);
  const examplesSection = toolExamples.length > 0
    ? '\n## Tool Usage Examples\n' +
      toolExamples.map(ex => {
        const args = Object.entries(ex.arguments)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
          .join(', ');
        return `${ex.name}(${args})`;
      }).join('\n') + '\n'
    : '';

  const parts: string[] = [
    `You are agent ${ctx.agentId} on project ${ctx.projectId}.`,
    ctx.missionId ? `Mission: ${ctx.missionId}` : '',
    '',
    '## Available Tools',
    // Only list active (Tier 1) tools here; Tier 2 tools are in registrySummary below
    (activeToolNames ?? ctx.availableTools).map(name => {
      const tool = tools.get(name);
      return tool ? `- ${tool.definition.name}: ${tool.definition.description}` : `- ${name}`;
    }).join('\n'),
    examplesSection,
    // Tier 2: Registry summary (tools available on request)
    registrySummary ? registrySummary : '',
    '## Governance',
    govProfile,
    '',
    '## Token Budget (self-aware)',
    `- Total budget: ${ctx.tokenBudget} tokens`,
    `- Model: ${routing.modelId} (tier: ${routing.tier})`,
    isComplexTask(ctx.goal)
      ? '- This is a complex task. Prioritize completeness and thoroughness. Provide detailed output with examples, analysis, and actionable content. Use your token budget wisely — quality over minimalism.'
      : '- Be concise. Every token costs money.',
    '- Return structured output when possible (JSON, tool calls) instead of verbose prose.',
    '',
    '## Constraints',
    `- Max ${config.maxStepsPerRun} steps. Prioritize accuracy when budget is constrained.`,
    '',
    '## Tool Calling Rules',
    '- All required arguments must be provided. Do NOT guess values — ask if ambiguous.',
    '- Independent tools may be called in parallel; dependent calls must be sequential.',
    '- On validation error: correct arguments and retry.',
    '',
    '## Output Format',
    isComplexTask(ctx.goal)
      ? '- Provide comprehensive, well-structured output. Use markdown with headers/code blocks. Include all relevant details. Do NOT truncate prematurely.'
      : [
          '- When you have enough information to answer, provide your FINAL answer in this exact format:',
          '  FINAL ANSWER: <concise answer>',
          '- The answer should be as short as possible (a number, a name, a word, a phrase).',
          '- Once you provide FINAL ANSWER, stop — do not continue reasoning.',
        ].join('\n'),
  ];

  return parts.filter(Boolean).join('\n');
}

/**
 * Build cache-aware user prompt.
 * Variable content goes LAST for maximum cache hit ratio on preceding system block.
 * Includes remaining budget context and governor-driven response format hints.
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
    '',
    // Adaptive output guidance based on task complexity
    isComplexTask(ctx.goal)
      ? '## Output Quality\nThis is a complex task requiring comprehensive output. Provide detailed, thorough results with full explanations, code examples, and analysis. Do NOT truncate or summarize prematurely. Aim for completeness over brevity.'
      : '',
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
  // Tasks with longer descriptions are generally more complex
  if (goal.length > 200) return true;
  return complexPatterns.some(p => p.test(goal));
}
