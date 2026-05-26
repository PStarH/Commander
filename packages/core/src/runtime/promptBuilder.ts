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
    .slice(0, 40);
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
    ctx.availableTools.map(name => {
      const tool = tools.get(name);
      return tool ? `- ${tool.definition.name}: ${tool.definition.description}` : `- ${name}`;
    }).join('\n'),
    examplesSection,
    '## Governance',
    govProfile,
    '',
    '## Token Budget (self-aware)',
    `- Total budget: ${ctx.tokenBudget} tokens`,
    `- Model: ${routing.modelId} (tier: ${routing.tier})`,
    '- Be concise. Every token costs money.',
    '- Return structured output when possible (JSON, tool calls) instead of verbose prose.',
    '',
    '## Constraints',
    `- Maximum ${config.maxStepsPerRun} steps`,
    '- Prioritize accuracy over completeness when budget is constrained.',
    '',
    '## Tool Calling Instructions',
    '- Do NOT make assumptions about what values to plug into function arguments.',
    '  If a tool argument value is ambiguous or not clearly specified, ask for clarification.',
    '- Call one tool at a time unless the calls are clearly independent.',
    '- Wait for tool results before making follow-up tool calls that depend on them.',
    '- When a tool returns a validation error, correct your arguments and retry.',
    '- Provide all required arguments. Do not omit required fields.',
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
  ].join('\n');
}
