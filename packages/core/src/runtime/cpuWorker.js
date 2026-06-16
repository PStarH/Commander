const { parentPort } = require('worker_threads');

const HANDLERS = {
  compact_score_messages: (input) => scoreMessages(input),
  compact_build_summary: (input) => buildStructuredSummary(input),
  compact_select_topk: (input) => selectTopK(input),
  compact_estimate_tokens_batch: (input) => estimateTokensBatch(input),
};

parentPort.on('message', ({ id, type, input }) => {
  try {
    const handler = HANDLERS[type];
    if (!handler) throw new Error(`Unknown task type: ${type}`);
    const result = handler(input);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});

function estimateTokensBatch({ texts }) {
  const CJK_RE = /[一-鿿㐀-䶿]/g;
  return texts.map((text) => {
    const cjkCount = (text.match(CJK_RE) ?? []).length;
    return Math.ceil((text.length - cjkCount) / 4 + cjkCount / 1.5);
  });
}

function scoreMessages({ messages, importanceConfig, failureFingerprints }) {
  const RE_QUESTION = /\?|please|do|write|create|fix|implement|analyze/i;
  const RE_DECISION = /I will|I'll|going to|plan to|the answer|in conclusion|therefore/i;
  const RE_ERROR = /error|fail|exception|cannot|unable/i;

  const fpSet = new Set(failureFingerprints || []);

  return messages.map((msg, index) => {
    let score = 0.5;
    const total = messages.length;

    if (msg.role === 'system') return { index, importance: 1.0 };

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 20) score += (importanceConfig?.userInstructionBonus ?? 0.3);
      if (RE_QUESTION.test(content)) score += 0.1;
    }

    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (RE_DECISION.test(content)) score += (importanceConfig?.decisionBonus ?? 0.3);
      if (msg.tool_calls && msg.tool_calls.length > 0) score += 0.1;
      if (content.length > 500) score += 0.15;
      if (content.length > 1000) score += 0.1;
    }

    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (RE_ERROR.test(content)) score += (importanceConfig?.errorBonus ?? 0.4);
      if (content.length > 1000) score += 0.1;
    }

    const recencyFactor = index / Math.max(total - 1, 1);
    score += recencyFactor * (importanceConfig?.recencyBonus ?? 0.2);

    if (typeof msg.content === 'string' && msg.content.startsWith('__COMPACTED__')) {
      score += (importanceConfig?.compactedPenalty ?? -0.2);
    }

    const fingerprint = makeFingerprint(msg);
    if (fingerprint && fpSet.has(fingerprint)) {
      score = Math.max(0, score - 0.35);
    }

    return { index, importance: Math.max(0, Math.min(1, score)) };
  });
}

function makeFingerprint(msg) {
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (content.length > 10) {
    const normalized = content.replace(/\s+/g, ' ').trim().slice(0, 400);
    return `${normalized.length}:${normalized}`;
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const args = tc.function?.arguments ?? '';
      if (args.length > 10) {
        const normalized = args.replace(/\s+/g, ' ').trim().slice(0, 400);
        return `${normalized.length}:${normalized}`;
      }
    }
  }
  return null;
}

function buildStructuredSummary({ turns, verbosity }) {
  const maxDecisions = verbosity === 'aggressive' ? 1 : verbosity === 'detail' ? 5 : 3;
  const maxFindings = verbosity === 'aggressive' ? 1 : verbosity === 'detail' ? 5 : 3;
  const maxErrors = verbosity === 'aggressive' ? 2 : verbosity === 'detail' ? 5 : 3;
  const maxFiles = verbosity === 'aggressive' ? 3 : verbosity === 'detail' ? 10 : 8;

  const RE_HAS_DIGIT = /\d/;
  const RE_FINDING = /result|found|output|answer|total|sum|count/i;
  const DECISION_PATTERNS = [
    /(?:^|\n)(?:I will|Let me|Going to|Plan to|Need to|I'll|I'm going to) .{10,100}/i,
    /(?:The answer is|The result is|In conclusion|Therefore|Thus|So)[,:]? .{10,100}/i,
    /(?:Found|Discovered|Confirmed|Determined|Calculated) that .{10,100}/i,
  ];

  const toolCalls = new Set();
  const errors = [];
  const decisions = [];
  const files = [];
  const keyFindings = [];
  let userGoals = '';

  for (const turn of turns) {
    for (const msg of turn) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text.length > 20 && text.length < 500) userGoals = text.slice(0, 200);
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCalls.add(tc.function?.name ?? 'unknown');
          try {
            const args = JSON.parse(tc.function?.arguments ?? '{}');
            if (args.path) files.push(args.path);
            if (args.file_path) files.push(args.file_path);
          } catch {}
        }
      }
      if (msg.role === 'tool') {
        const c = typeof msg.content === 'string' ? msg.content : '';
        if (c.startsWith('error:') || c.startsWith('tool_error') || c.startsWith('ERROR')) {
          errors.push(c.split('\n')[0].slice(0, 120));
        } else {
          const lines = c.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 20 && trimmed.length < 150) {
              if (RE_HAS_DIGIT.test(trimmed) || RE_FINDING.test(trimmed)) {
                keyFindings.push(trimmed.slice(0, 100));
                break;
              }
            }
          }
        }
      }
      if (msg.role === 'assistant' && !msg.tool_calls) {
        const text = typeof msg.content === 'string' ? msg.content : '';
        for (const pattern of DECISION_PATTERNS) {
          const match = text.match(pattern);
          if (match) {
            decisions.push(match[0].replace(/\n/g, ' ').trim().slice(0, 120));
            if (decisions.length >= maxDecisions) break;
          }
        }
      }
    }
  }

  const parts = ['## Progress'];
  if (userGoals) parts.push(`Goal: ${userGoals}`);
  if (toolCalls.size > 0) parts.push(`Tools: ${[...toolCalls].join(', ')}`);
  if (files.length > 0) parts.push(`Files: ${[...new Set(files)].slice(0, maxFiles).join(', ')}`);
  if (decisions.length > 0) parts.push(`\n## Key Decisions\n${decisions.slice(0, maxDecisions).join('\n')}`);
  if (keyFindings.length > 0) parts.push(`\n## Findings\n${keyFindings.slice(0, maxFindings).join('\n')}`);
  if (errors.length > 0) parts.push(`\n## Issues\n${errors.slice(0, maxErrors).join('\n')}`);

  return parts.join('\n') || `${turns.length} turn(s) compacted`;
}

function selectTopK({ scored, budget }) {
  const minHeap = [];
  let totalCost = 0;

  for (let i = 0; i < scored.length; i++) {
    const item = scored[i];
    if (totalCost + item.costImpact <= budget) {
      minHeap.push({ costImpact: item.costImpact, idx: i });
      totalCost += item.costImpact;
      bubbleUp(minHeap, minHeap.length - 1);
    } else if (minHeap.length > 0 && item.costImpact > minHeap[0].costImpact) {
      totalCost -= minHeap[0].costImpact;
      minHeap[0] = { costImpact: item.costImpact, idx: i };
      totalCost += item.costImpact;
      bubbleDown(minHeap, 0);
    }
  }

  const keepSet = new Set(minHeap.map(h => h.idx));
  const result = scored.filter((_, i) => keepSet.has(i));
  result.sort((a, b) => b.costImpact - a.costImpact);
  return result;
}

function bubbleUp(heap, i) {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].costImpact <= heap[i].costImpact) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function bubbleDown(heap, i) {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && heap[left].costImpact < heap[smallest].costImpact) smallest = left;
    if (right < n && heap[right].costImpact < heap[smallest].costImpact) smallest = right;
    if (smallest === i) break;
    [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
    i = smallest;
  }
}
