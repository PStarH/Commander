/**
 * Entropy-based Tool Gating
 *
 * Research finding (arXiv 2602.02050): High-quality tool calls reduce model
 * entropy. By detecting when the model is already confident (low entropy),
 * we can skip unnecessary tool calls, achieving 72% reduction in tool calls.
 *
 * The gater analyzes LLM responses for "confidence signals":
 * - Response is self-contained (not asking for more info)
 * - Response contains definitive statements (no hedging)
 * - Model chose NOT to call tools despite having them available
 *
 * These signals indicate the model is confident enough to answer directly.
 */

/**
 * Signals that the model is confident and tools may be unnecessary.
 * Returns true when the response suggests the model can answer directly.
 */
export function isConfidentResponse(response: {
  content: string;
  toolCalls?: Array<{ name: string }>;
  finishReason?: string;
}): boolean {
  if (response.toolCalls && response.toolCalls.length > 0) {
    return false;
  }

  if (response.finishReason !== 'stop') {
    return false;
  }

  return hasLowEntropySignals(response.content);
}

function hasLowEntropySignals(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 20) return false;

  const highEntropyMarkers = [
    'i need more information',
    'i need to search',
    'i need to look up',
    'let me search',
    'let me look',
    'let me check',
    'let me find',
    'i should check',
    'i should look',
    'i should search',
    'i am not sure',
    "i'm not sure",
    'i am not certain',
    "i'm not certain",
    'i do not know',
    "i don't know",
    'not enough information',
    'insufficient data',
    'i would need to',
    'i cannot determine',
    'hard to say',
    'it depends',
    'unsure',
  ];

  const contentLower = trimmed.toLowerCase();

  for (const marker of highEntropyMarkers) {
    if (contentLower.includes(marker)) {
      return false;
    }
  }

  const lowEntropyMarkers = [
    'here is',
    'here are',
    'the answer is',
    'in summary',
    'to summarize',
    'conclusion',
    'finally',
    'i found',
    'the result',
    'based on the',
    'according to',
  ];

  const lowEntropyScore = lowEntropyMarkers.reduce(
    (score, marker) => score + (contentLower.includes(marker) ? 1 : 0),
    0,
  );

  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength =
    sentences.length > 0 ? trimmed.length / sentences.length : trimmed.length;

  // Short sentences suggest uncertainty/fragmentation
  if (avgSentenceLength < 30 && lowEntropyScore < 2) {
    return false;
  }

  return lowEntropyScore >= 1 || avgSentenceLength > 80;
}

/**
 * Estimate if a set of tool calls is worth executing, or if the
 * information gain would be low. Based on tool type and past results.
 */
export function hasInformationGain(
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>,
  recentResults: Array<{ name: string; output: string; error?: string }>,
): boolean {
  if (toolCalls.length === 0) return false;

  for (const tc of toolCalls) {
    const name = tc.name;

    if (
      name === 'shell_execute' ||
      name === 'python_execute' ||
      name === 'file_write' ||
      name === 'file_edit'
    ) {
      return true;
    }

    const recent = recentResults.filter((r) => r.name === name);
    if (recent.length > 0) {
      const lastResult = recent[recent.length - 1];
      if (lastResult.error) {
        return true;
      }
      const lastOutput = lastResult.output;
      if (name === 'web_search' || name === 'browser_search') {
        const currentQuery = JSON.stringify(tc.arguments).toLowerCase();
        for (const r of recent) {
          if (r.output.length > 100 && currentQuery.length > 0) {
            return false;
          }
        }
      }
    }
  }

  return true;
}
