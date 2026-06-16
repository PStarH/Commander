/**
 * SOP (Standard Operating Procedure) Template Export
 *
 * Takes a successful multi-agent execution trace and extracts a structured
 * template that can be reused as few-shot context for future runs.
 *
 * The SOP template captures:
 *   - Task decomposition: how the original goal was split into sub-tasks
 *   - Tool call chains: which tools were called in what order, with what args
 *   - Agent handoffs: how sub-agents were delegated and results synthesized
 *   - Key decisions: critical branching points and their reasoning
 *   - I/O contracts: input/output schemas for each phase
 *
 * Output: structured JSON + Markdown template suitable for few-shot injection.
 */

import type { ExecutionTrace, TraceEvent, AgentExecutionResult, AgentExecutionStep } from './types';

// ============================================================================
// Types
// ============================================================================

export interface SOPPhase {
  /** Phase name (e.g. 'analysis', 'implementation', 'verification') */
  name: string;
  /** Phase description */
  description: string;
  /** Tools used during this phase */
  toolsUsed: string[];
  /** Key decisions made */
  decisions: SOPDecision[];
  /** Outcome of this phase */
  outcome: string;
  /** Agent role that executed this phase */
  agentRole?: string;
}

export interface SOPDecision {
  description: string;
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
}

export interface SOPTemplate {
  /** SOP schema version */
  schemaVersion: number;
  /** Original goal that produced this SOP */
  goal: string;
  /** When the original execution ran */
  executedAt: string;
  /** Source execution run ID */
  sourceRunId: string;
  /** Number of steps in the original run */
  totalSteps: number;
  /** Total tokens consumed */
  totalTokens: number;
  /** Total duration in ms */
  totalDurationMs: number;
  /** Model used */
  modelUsed: string;
  /** Topology used (if multi-agent) */
  topology?: string;
  /** Phases of execution */
  phases: SOPPhase[];
  /** Full tool call chain (chronological) */
  toolCallChain: SOPToolCall[];
  /** Index of key files read/written */
  files: SOPFileAccess[];
  /** Summary of what this SOP accomplishes */
  summary: string;
  /** Tags for retrieval */
  tags: string[];
}

export interface SOPToolCall {
  stepNumber: number;
  toolName: string;
  phase: string;
  args: Record<string, unknown>;
  resultSnippet: string;
  durationMs: number;
  hadError: boolean;
}

export interface SOPFileAccess {
  path: string;
  action: 'read' | 'write' | 'edit';
  summary: string;
}

// ============================================================================
// Default Categories
// ============================================================================

const PHASE_CATEGORIES: Array<{ name: string; keywords: string[] }> = [
  { name: 'Understanding', keywords: ['read', 'search', 'list', 'glob', 'find'] },
  { name: 'Analysis', keywords: ['grep', 'ripgrep', 'code_search', 'examine', 'inspect'] },
  { name: 'Planning', keywords: ['plan', 'think', 'brainstorm', 'deliberate'] },
  { name: 'Implementation', keywords: ['write', 'edit', 'replace', 'create', 'patch', 'apply'] },
  { name: 'Verification', keywords: ['test', 'lint', 'typecheck', 'check', 'verify', 'validate'] },
  { name: 'Execution', keywords: ['run', 'execute', 'shell', 'bash', 'command'] },
  { name: 'Research', keywords: ['web_search', 'web_fetch', 'browser', 'fetch'] },
  { name: 'Synthesis', keywords: ['summarize', 'report', 'synthesize', 'combine'] },
];

function classifyPhase(toolNames: string[]): string {
  for (const cat of PHASE_CATEGORIES) {
    if (toolNames.some(t => cat.keywords.some(k => t.includes(k)))) {
      return cat.name;
    }
  }
  return 'General';
}

// ============================================================================
// Export Core
// ============================================================================

/**
 * Generate an SOP template from an execution trace.
 * Returns null if the trace has insufficient data.
 */
export function exportSOPFromTrace(trace: ExecutionTrace): SOPTemplate | null {
  if (!trace || !trace.events || trace.events.length < 3) {
    return null;
  }

  // Extract tool calls from trace events
  const toolCalls = extractToolCalls(trace);
  const decisions = extractDecisions(trace);
  const files = extractFileAccess(trace);

  // Group tool calls into phases
  const phases = buildPhases(toolCalls, decisions, trace);

  // Build the full tool call chain
  const toolCallChain: SOPToolCall[] = toolCalls.map(evt => ({
    stepNumber: evt.stepNumber,
    toolName: evt.toolName,
    phase: classifyPhase([evt.toolName]),
    args: evt.args,
    resultSnippet: truncate(evt.output || '', 200),
    durationMs: evt.durationMs,
    hadError: !!evt.error,
  }));

  // Generate summary
  const summary = buildSummary(trace, phases, toolCalls.length, files);

  // Generate tags
  const tags = buildTags(trace, toolCalls);

  return {
    schemaVersion: 1,
    goal: extractGoal(trace),
    executedAt: trace.startedAt,
    sourceRunId: trace.runId,
    totalSteps: trace.events.length,
    totalTokens: trace.summary.totalTokens,
    totalDurationMs: trace.summary.totalDurationMs,
    modelUsed: trace.summary.modelUsed,
    topology: extractTopology(trace),
    phases,
    toolCallChain,
    files,
    summary,
    tags,
  };
}

/**
 * Generate an SOP template from an AgentExecutionResult (runtime output).
 */
export function exportSOPFromResult(result: AgentExecutionResult): SOPTemplate | null {
  if (!result || !result.steps || result.steps.length < 2) {
    return null;
  }

  const steps = result.steps;
  const toolCalls = steps
    .filter(s => s.type === 'tool_call' && s.toolCall)
    .map(s => ({
      toolName: s.toolCall!.name,
      args: s.toolCall!.arguments,
      output: s.toolResult?.output || '',
      error: s.toolResult?.error,
      durationMs: s.durationMs || 0,
      stepNumber: s.stepNumber,
    }));

  const fileAccess: SOPFileAccess[] = [];
  for (const s of steps) {
    if (s.type === 'tool_call' && s.toolCall) {
      const name = s.toolCall.name;
      if (name === 'file_write' || name === 'write_file') {
        fileAccess.push({ path: String(s.toolCall.arguments.path || ''), action: 'write', summary: 'wrote file' });
      } else if (name === 'file_edit' || name === 'edit_file' || name === 'str_replace') {
        fileAccess.push({ path: String(s.toolCall.arguments.path || ''), action: 'edit', summary: 'edited file' });
      } else if (name === 'file_read' || name === 'read_file') {
        fileAccess.push({ path: String(s.toolCall.arguments.path || ''), action: 'read', summary: 'read file' });
      }
    }
  }

  const toolNames = toolCalls.map(t => t.toolName);
  const phases: SOPPhase[] = [];
  if (toolCalls.length > 0) {
    phases.push({
      name: classifyPhase(toolNames),
      description: `Executed ${toolCalls.length} tool calls across ${steps.length} steps`,
      toolsUsed: [...new Set(toolNames)],
      decisions: toolCalls.map(t => ({
        description: `Called ${t.toolName}`,
        toolName: t.toolName,
        inputSummary: truncate(JSON.stringify(t.args), 100),
        outputSummary: truncate(t.output || t.error || '', 100),
      })),
      outcome: result.status === 'success' ? 'Completed successfully' : `Completed with status: ${result.status}`,
      agentRole: 'agent',
    });
  }

  const tags = [...new Set([...toolNames, result.status, 'sop-export'].filter(Boolean))] as string[];

  return {
    schemaVersion: 1,
    goal: result.summary || 'Untitled execution',
    executedAt: result.steps[0]?.timestamp || new Date().toISOString(),
    sourceRunId: result.runId,
    totalSteps: steps.length,
    totalTokens: result.totalTokenUsage?.totalTokens || 0,
    totalDurationMs: result.totalDurationMs,
    modelUsed: '',
    phases,
    toolCallChain: toolCalls.map(t => ({
      stepNumber: t.stepNumber,
      toolName: t.toolName,
      phase: classifyPhase([t.toolName]),
      args: t.args,
      resultSnippet: truncate(t.output || t.error || '', 200),
      durationMs: t.durationMs,
      hadError: !!t.error,
    })),
    files: fileAccess,
    summary: `SOP for "${result.summary?.slice(0, 80)}" — ${steps.length} steps, ${result.totalDurationMs}ms`,
    tags,
  };
}

/**
 * Format an SOP template as a markdown string suitable for few-shot injection.
 */
export function formatSOPAsMarkdown(sop: SOPTemplate): string {
  const lines: string[] = [];

  lines.push(`# SOP: ${sop.goal.slice(0, 80)}`);
  lines.push('');
  lines.push(`- **Source Run**: \`${sop.sourceRunId}\``);
  lines.push(`- **Executed**: ${sop.executedAt}`);
  lines.push(`- **Steps**: ${sop.totalSteps} | **Tokens**: ${sop.totalTokens} | **Duration**: ${sop.totalDurationMs}ms`);
  if (sop.modelUsed) lines.push(`- **Model**: ${sop.modelUsed}`);
  if (sop.topology) lines.push(`- **Topology**: ${sop.topology}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(sop.summary);
  lines.push('');

  if (sop.phases.length > 0) {
    lines.push('## Phases');
    lines.push('');
    for (const phase of sop.phases) {
      lines.push(`### ${phase.name}`);
      lines.push(`> ${phase.description}`);
      lines.push('');
      lines.push(`**Tools**: ${phase.toolsUsed.join(', ')}`);
      lines.push('');
      lines.push(`**Outcome**: ${phase.outcome}`);
      lines.push('');
      if (phase.decisions.length > 0) {
        lines.push('Key decisions:');
        for (const d of phase.decisions.slice(0, 5)) {
          lines.push(`- ${d.description}`);
          if (d.inputSummary) lines.push(`  - Input: \`${d.inputSummary}\``);
          if (d.outputSummary) lines.push(`  - Output: \`${d.outputSummary}\``);
        }
        lines.push('');
      }
    }
  }

  if (sop.toolCallChain.length > 0) {
    lines.push('## Tool Call Chain');
    lines.push('');
    lines.push('| # | Tool | Phase | Args | Duration |');
    lines.push('|---|------|-------|------|----------|');
    for (const tc of sop.toolCallChain.slice(0, 30)) {
      const argsStr = truncate(JSON.stringify(tc.args), 60);
      lines.push(`| ${tc.stepNumber} | ${tc.toolName} | ${tc.phase} | \`${argsStr}\` | ${tc.durationMs}ms |`);
    }
    if (sop.toolCallChain.length > 30) {
      lines.push(`| ... | (${sop.toolCallChain.length - 30} more calls) | ... | ... | ... |`);
    }
    lines.push('');
  }

  if (sop.files.length > 0) {
    lines.push('## Files Accessed');
    lines.push('');
    for (const f of sop.files) {
      lines.push(`- ${f.action.toUpperCase()}: \`${f.path}\` — ${f.summary}`);
    }
    lines.push('');
  }

  lines.push('## Tags');
  lines.push(`\`${sop.tags.join('`, `')}\``);

  return lines.join('\n');
}

/**
 * Format an SOP template as a structured JSON object (for reuse in memory/context).
 */
export function formatSOPAsContext(sop: SOPTemplate): Record<string, unknown> {
  return {
    type: 'sop_template',
    schemaVersion: sop.schemaVersion,
    goal: sop.goal,
    summary: sop.summary,
    phases: sop.phases.map(p => ({
      name: p.name,
      tools: p.toolsUsed,
      outcome: p.outcome,
    })),
    toolCallPattern: sop.toolCallChain.map(tc => `${tc.toolName}(${truncate(JSON.stringify(tc.args), 80)})`),
    files: sop.files.map(f => `${f.action}:${f.path}`),
    tags: sop.tags,
    modelUsed: sop.modelUsed,
    topology: sop.topology,
    totalDurationMs: sop.totalDurationMs,
    totalTokens: sop.totalTokens,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

interface ExtractedToolCall {
  stepNumber: number;
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  error?: string;
  durationMs: number;
  phase: string;
}

function extractToolCalls(trace: ExecutionTrace): ExtractedToolCall[] {
  const result: ExtractedToolCall[] = [];
  let stepNum = 0;

  for (const evt of trace.events) {
    if (evt.type === 'tool_execution') {
      stepNum++;
      const toolName = evt.data.toolCallId || extractToolName(evt) || 'unknown';
      const args = (evt.data.input as Record<string, unknown>) || {};
      const output = (evt.data.output as string) || '';
      const error = evt.data.error;

      result.push({
        stepNumber: stepNum,
        toolName,
        args,
        output,
        error,
        durationMs: evt.durationMs,
        phase: classifyPhase([toolName]),
      });
    }
  }

  return result;
}

function extractToolName(evt: TraceEvent): string | null {
  // Tool name is stored in toolCallId by recordToolExecution
  if (evt.data.toolCallId) return evt.data.toolCallId;
  // Fallback: try to extract from input if available
  const input = evt.data.input;
  if (input && typeof input === 'object' && 'tool' in (input as Record<string, unknown>)) {
    return (input as Record<string, unknown>).tool as string;
  }
  return null;
}

function extractDecisions(trace: ExecutionTrace): SOPDecision[] {
  const decisions: SOPDecision[] = [];
  for (const evt of trace.events) {
    if (evt.type === 'decision') {
      decisions.push({
        description: (evt.data.output as string) || 'Decision made',
        toolName: evt.data.toolCallId,
        inputSummary: truncate(JSON.stringify(evt.data.input), 100),
        outputSummary: truncate(JSON.stringify(evt.data.output), 100),
      });
    }
  }
  return decisions;
}

function extractFileAccess(trace: ExecutionTrace): SOPFileAccess[] {
  const files: SOPFileAccess[] = [];
  const seen = new Set<string>();

  for (const evt of trace.events) {
    if (evt.type !== 'tool_execution') continue;
    // Tool name is stored in toolCallId by recordToolExecution
    const toolName = evt.data.toolCallId || extractToolName(evt) || 'unknown';
    const input = evt.data.input as Record<string, unknown> | undefined;
    const path = input?.path as string | undefined;
    if (!path || seen.has(path)) continue;

    let action: SOPFileAccess['action'] = 'read';
    if (['file_write', 'write_file', 'file_edit', 'edit_file', 'str_replace', 'patch'].includes(toolName)) {
      action = 'write';
    } else if (['file_read', 'read_file'].includes(toolName)) {
      action = 'read';
    }

    seen.add(path);
    files.push({
      path,
      action,
      summary: `${action} by ${toolName}`,
    });
  }

  return files;
}

function buildPhases(
  toolCalls: ExtractedToolCall[],
  decisions: SOPDecision[],
  trace: ExecutionTrace,
): SOPPhase[] {
  if (toolCalls.length === 0) return [];

  // Simple phase detection: group consecutive tool calls by category
  const phases: SOPPhase[] = [];
  let currentTools: string[] = [];
  let currentDecisions: SOPDecision[] = [];
  let currentCategory = '';
  let decisionIdx = 0;

  for (const tc of toolCalls) {
    const category = classifyPhase([tc.toolName]);

    // Assign decisions that fall within this phase's step range
    while (decisionIdx < decisions.length && decisions[decisionIdx]) {
      if (currentCategory && category !== currentCategory) break;
      currentDecisions.push(decisions[decisionIdx]);
      decisionIdx++;
    }

    if (category !== currentCategory && currentTools.length > 0) {
      phases.push({
        name: currentCategory,
        description: `Phase with ${currentTools.length} tool calls`,
        toolsUsed: [...new Set(currentTools)],
        decisions: [...currentDecisions],
        outcome: 'Completed',
      });
      currentTools = [];
      currentDecisions = [];
    }
    currentCategory = category;
    currentTools.push(tc.toolName);
  }

  // Assign remaining decisions to the last phase
  while (decisionIdx < decisions.length) {
    currentDecisions.push(decisions[decisionIdx]);
    decisionIdx++;
  }

  // Add the last phase
  if (currentTools.length > 0) {
    phases.push({
      name: currentCategory,
      description: `Phase with ${currentTools.length} tool calls`,
      toolsUsed: [...new Set(currentTools)],
      decisions: [...currentDecisions],
      outcome: 'Completed',
      agentRole: trace.subAgentRole || 'agent',
    });
  }

  return phases;
}

function buildSummary(
  trace: ExecutionTrace,
  phases: SOPPhase[],
  toolCallCount: number,
  files: SOPFileAccess[],
): string {
  const phaseNames = phases.map(p => p.name).join(' → ');
  const fileSummary = files.length > 0
    ? ` (${files.filter(f => f.action === 'write').length} writes, ${files.filter(f => f.action === 'read').length} reads)`
    : '';
  const errorCount = trace.summary.errors || 0;
  const errorNote = errorCount > 0 ? ` with ${errorCount} error(s)` : '';
  return [
    `Multi-step execution across ${phases.length} phase(s): ${phaseNames}.`,
    `${toolCallCount} tool calls${fileSummary}, ${trace.summary.totalTokens} tokens consumed in ${trace.summary.totalDurationMs}ms${errorNote}.`,
    `Status: ${trace.completedAt ? 'Completed' : 'Incomplete'}.`,
  ].join(' ');
}

function buildTags(trace: ExecutionTrace, toolCalls: ExtractedToolCall[]): string[] {
  const tags: string[] = ['sop', 'export'];

  // Add tool-based tags
  const uniqueTools = [...new Set(toolCalls.map(t => t.toolName))];
  tags.push(...uniqueTools.slice(0, 5));

  // Add model tag
  if (trace.summary.modelUsed) {
    tags.push(`model:${trace.summary.modelUsed}`);
  }

  // Add agent role tags
  if (trace.subAgentRole) {
    tags.push(`role:${trace.subAgentRole}`);
  }
  if (trace.missionId) {
    tags.push(`mission:${trace.missionId}`);
  }

  return tags;
}

function extractGoal(trace: ExecutionTrace): string {
  // Goal is best-effort from events
  return trace.missionId || `Execution ${trace.runId}`;
}

function extractTopology(trace: ExecutionTrace): string | undefined {
  return trace.subAgentRole ? 'hierarchical' : undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
