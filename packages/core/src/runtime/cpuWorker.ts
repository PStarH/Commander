/**
 * CPU Worker — runs inside a worker_thread for offloaded tasks.
 *
 * This file is intentionally self-contained (no relative TypeScript imports) so
 * it can be loaded by Node's worker_threads even when the parent is executed
 * under tsx. The only dependency is the built-in `worker_threads` module.
 */
import { parentPort } from 'worker_threads';

interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface WorkerRequest {
  id: string;
  type: string;
  input: unknown;
}

interface ImportanceConfig {
  userInstructionBonus: number;
  decisionBonus: number;
  errorBonus: number;
  recencyBonus: number;
  compactedPenalty: number;
}

if (!parentPort) {
  throw new Error('cpuWorker.ts must be run inside a worker_thread');
}

const COMPACTED_MARKER = '__COMPACTED__';
const RE_QUESTION_INSTRUCTION = /\b(how|what|why|when|where|who|which|can you|please|explain|implement|fix|create|write|refactor|test|verify)\b/i;
const RE_DECISION_PATTERN = /\b(decided|decision|conclusion|agreed|opted|chosen|selected|will use|going with)\b/i;
const RE_ERROR_CONTENT = /\b(error|exception|fail|failed|timeout|crash|invalid|cannot|unable|ERR_|Traceback)\b/i;

function isCompacted(msg: LLMMessage): boolean {
  return typeof msg.content === 'string' && msg.content.startsWith(COMPACTED_MARKER);
}

function scoreMessageImportance(
  msg: LLMMessage,
  index: number,
  total: number,
  importanceConfig: ImportanceConfig,
): number {
  let score = 0.5;

  if (msg.role === 'system') return 1.0;

  if (msg.role === 'user') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 20) score += importanceConfig.userInstructionBonus;
    if (RE_QUESTION_INSTRUCTION.test(content)) score += 0.1;
  }

  if (msg.role === 'assistant') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (RE_DECISION_PATTERN.test(content)) score += importanceConfig.decisionBonus;
    if (msg.tool_calls && msg.tool_calls.length > 0) score += 0.1;
    const contentLength = content.length;
    if (contentLength > 500) score += 0.15;
    if (contentLength > 1000) score += 0.1;
  }

  if (msg.role === 'tool') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (RE_ERROR_CONTENT.test(content)) score += importanceConfig.errorBonus;
    if (content.length > 1000) score += 0.1;
  }

  const recencyFactor = index / Math.max(total - 1, 1);
  score += recencyFactor * importanceConfig.recencyBonus;

  if (isCompacted(msg)) score += importanceConfig.compactedPenalty;

  return Math.max(0, Math.min(1, score));
}

function buildHeuristicSummary(turns: LLMMessage[][][], verbosity: string): string {
  const totalTurns = turns.length;
  let totalMessages = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  const snippets: string[] = [];

  for (const turn of turns) {
    for (const msg of turn.flat()) {
      totalMessages++;
      if (msg.role === 'user') userCount++;
      else if (msg.role === 'assistant') assistantCount++;
      else if (msg.role === 'tool') toolCount++;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 0 && snippets.length < 3) {
        snippets.push(content.slice(0, 120));
      }
    }
  }

  const detailLevel = verbosity === 'high' ? 'detailed' : verbosity === 'low' ? 'brief' : 'moderate';
  return [
    `[${detailLevel} summary] Compacted ${totalTurns} turn(s) / ${totalMessages} message(s)`,
    `Speakers: ${userCount} user, ${assistantCount} assistant, ${toolCount} tool.`,
    snippets.length ? `Key snippets: ${snippets.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

parentPort.on('message', (msg: WorkerRequest) => {
  const { id, type, input } = msg;
  try {
    let result: unknown;
    switch (type) {
      case 'compact_score_messages': {
        const { messages, importanceConfig } = input as {
          messages: LLMMessage[];
          importanceConfig: ImportanceConfig;
        };
        result = messages
          .map((m, index) => ({
            index,
            importance: scoreMessageImportance(m, index, messages.length, importanceConfig),
          }))
          .filter((s) => s.importance > 0.6 && !isCompacted(messages[s.index]))
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 5);
        break;
      }
      case 'compact_build_summary': {
        const { turns, verbosity } = input as {
          turns: LLMMessage[][][];
          verbosity: string;
        };
        result = buildHeuristicSummary(turns, verbosity);
        break;
      }
      default:
        throw new Error(`Unknown worker task type: ${type}`);
    }
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
