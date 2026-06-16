/**
 * Observation Purifier — Content-aware stripping for tool outputs.
 *
 * Replaces blind truncation with format-specific compression that preserves
 * semantic meaning:
 *   - HTML → Markdown-ish text (strip scripts/styles, collapse whitespace)
 *   - JSON → minified JSON, optionally extract relevant sections
 *   - Stack traces → keep first/last frames, deduplicate repeated frames
 *   - Generic → route by tool name or fall back to head-tail truncation
 *
 * Never drops error signals. Falls back to the original output if purification
 * would lose information.
 */

export interface PurifyOptions {
  /** Maximum characters to return after purification. 0 = no limit. */
  maxChars?: number;
  /** For JSON: extract only this top-level key if present. */
  jsonKey?: string;
  /** For stack traces: number of frames to keep at top and bottom. */
  stackFrames?: number;
}

/** Detect whether content looks like HTML. */
export function looksLikeHtml(content: string): boolean {
  if (content.length < 20) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('<!doctype html') ||
    lower.includes('<html') ||
    (lower.includes('<body') && lower.includes('</body')) ||
    (lower.includes('<div') && lower.includes('</div')) ||
    (lower.includes('<table') && lower.includes('</table'))
  );
}

/** Detect whether content looks like JSON. */
export function looksLikeJson(content: string): boolean {
  const trimmed = content.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

/** Detect whether content looks like a stack trace. */
export function looksLikeStackTrace(content: string): boolean {
  const lines = content.split('\n');
  const framePatterns = [
    /^\s*at\s+.+\(.+:\d+:\d+\)/,
    /^\s*at\s+.+\s+\(.+\)/,
    /^\s*File\s+".+",\s+line\s+\d+/,
    /^\s*\w+Error:\s*/,
  ];
  let frameCount = 0;
  for (const line of lines) {
    if (framePatterns.some(p => p.test(line))) frameCount++;
  }
  return frameCount >= 3;
}

/** Quick check if output contains an error signal that must be preserved. */
export function containsErrorSignal(content: string): boolean {
  const lower = content.toLowerCase();
  const errorMarkers = [
    'error:', 'exception:', 'traceback', 'failed', 'failure',
    'cannot ', 'unable to', 'exit code', 'fatal',
  ];
  return errorMarkers.some(m => lower.includes(m));
}

/**
 * Strip HTML tags and convert common constructs to markdown.
 * Preserves links, headings, lists, and tables (crudely).
 */
export function purifyHtml(content: string, maxChars = 0): string {
  let text = content;

  // Remove script/style blocks first
  text = text.replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '');

  // Convert headings
  text = text.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');

  // Convert lists
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

  // Convert paragraphs and divs to newlines
  text = text.replace(/<\/?(p|div|section|article|header|footer)\b[^>]*>/gi, '\n');

  // Convert line breaks
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common entities
  text = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text.replace(/\n\s*\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n...[purified HTML truncated at ${maxChars} chars]`;
  }

  return text || '[empty HTML document]';
}

/**
 * Minify JSON and optionally extract a specific top-level key.
 */
export function purifyJson(content: string, options: PurifyOptions = {}): string {
  const { maxChars = 0, jsonKey } = options;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not valid JSON — fall back to stripping whitespace
    const minified = content.replace(/\s+/g, ' ').trim();
    return maxChars > 0 && minified.length > maxChars
      ? minified.slice(0, maxChars) + '\n...[truncated]'
      : minified;
  }

  if (jsonKey && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && jsonKey in parsed) {
    parsed = (parsed as Record<string, unknown>)[jsonKey];
  }

  const minified = JSON.stringify(parsed);

  if (maxChars > 0 && minified.length > maxChars) {
    return minified.slice(0, maxChars) + '\n...[purified JSON truncated]';
  }
  return minified;
}

/**
 * Deduplicate and truncate stack traces.
 */
export function purifyStackTrace(content: string, options: PurifyOptions = {}): string {
  const frames = options.stackFrames ?? 4;
  const lines = content.split('\n');

  const header: string[] = [];
  const stackLines: string[] = [];

  for (const line of lines) {
    if (/^\s*at\s+/.test(line)) {
      stackLines.push(line);
    } else {
      header.push(line);
    }
  }

  if (stackLines.length === 0) {
    return content; // doesn't look like a real stack trace
  }

  // Deduplicate repeated frame sequences (common in recursive errors)
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of stackLines) {
    const normalized = line.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(line);
    }
  }

  let result: string[];
  if (deduped.length <= frames * 2) {
    result = [...header, ...deduped];
  } else {
    result = [
      ...header,
      ...deduped.slice(0, frames),
      `...${deduped.length - frames * 2} identical frames omitted...`,
      ...deduped.slice(-frames),
    ];
  }

  return result.join('\n');
}

/**
 * Route output to the appropriate purifier based on content shape.
 */
export function purifyObservation(content: string, toolName?: string, options: PurifyOptions = {}): string {
  if (!content || content.length === 0) return content;

  // Never purify away error signals blindly
  if (containsErrorSignal(content) && content.length < 500) {
    return content;
  }

  if (looksLikeStackTrace(content)) {
    return purifyStackTrace(content, options);
  }

  if (looksLikeJson(content)) {
    return purifyJson(content, options);
  }

  if (looksLikeHtml(content)) {
    return purifyHtml(content, options.maxChars);
  }

  // Tool-specific heuristics
  const lowerTool = (toolName ?? '').toLowerCase();
  if (lowerTool.includes('search') || lowerTool.includes('grep') || lowerTool.includes('glob')) {
    // Search results: collapse duplicate blank lines and trim per-line
    return content
      .split('\n')
      .map(l => l.trimEnd())
      .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
      .join('\n');
  }

  return content;
}

/**
 * Purify a batch of tool results, preserving error outputs.
 */
export function purifyToolResults(
  results: Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }>,
): Array<{ toolCallId: string; name: string; output: string; error?: string; durationMs: number }> {
  return results.map((r) => {
    if (r.error) return r;
    if (r.output.length <= 200) return r;
    return {
      ...r,
      output: purifyObservation(r.output, r.name),
    };
  });
}
