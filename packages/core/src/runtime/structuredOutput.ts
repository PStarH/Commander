/**
 * Structured Output Parsing Utilities
 *
 * Provides reliable extraction of JSON/structured data from LLM responses,
 * supporting multiple output formats (JSON blocks, XML tags, YAML, markdown code blocks).
 */

/**
 * Attempt to parse structured output from an LLM response.
 * Tries multiple extraction strategies in order of likelihood.
 */
export function parseStructuredOutput<T = unknown>(
  content: string,
  fallback?: T,
): { success: true; data: T } | { success: false; data: T | undefined; raw: string } {
  // Strategy 1: Extract JSON from markdown code block
  const jsonBlock = extractJsonBlock(content);
  if (jsonBlock !== null) {
    try {
      return { success: true, data: JSON.parse(jsonBlock) as T };
    } catch { /* continue to next strategy */ }
  }

  // Strategy 2: Extract JSON from raw response (strip leading/trailing non-JSON)
  const rawJson = extractRawJson(content);
  if (rawJson !== null) {
    try {
      return { success: true, data: JSON.parse(rawJson) as T };
    } catch { /* continue to next strategy */ }
  }

  // Strategy 3: Extract JSON from `<output_json>...</output_json>` tags
  const taggedJson = extractTaggedContent(content, 'output_json');
  if (taggedJson !== null) {
    try {
      return { success: true, data: JSON.parse(taggedJson) as T };
    } catch { /* continue to next strategy */ }
  }

  // Strategy 4: Extract XML-like structured content
  const xmlData = tryExtractXmlFields(content);
  if (xmlData !== null) {
    return { success: true, data: xmlData as T };
  }

  // Strategy 5: Try YAML-ish key: value pairs (simple flat objects)
  const yamlData = tryExtractYamlFields(content);
  if (yamlData !== null) {
    return { success: true, data: yamlData as T };
  }

  // All strategies failed
  return {
    success: false,
    data: fallback,
    raw: content.trim(),
  };
}

/**
 * Validate that parsed structured output matches expected schema.
 */
export function validateStructuredOutput<T>(
  result: { success: true; data: T } | { success: false; data: T | undefined; raw: string },
  requiredKeys: (keyof T)[],
): result is { success: true; data: T } {
  if (!result.success) return false;
  return requiredKeys.every(key => key in (result.data as Record<string, unknown>));
}

/**
 * Extract JSON from markdown code fences: ```json ... ```
 */
function extractJsonBlock(content: string): string | null {
  // Try ```json ... ``` first
  const jsonFence = content.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonFence) return jsonFence[1].trim();

  // Try ``` ... ``` and hope it's JSON
  const anyFence = content.match(/```\s*([\s\S]*?)\n```/);
  if (anyFence) {
    const trimmed = anyFence[1].trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  }

  return null;
}

/**
 * Extract JSON by finding the first { ... } or [ ... ] block.
 */
function extractRawJson(content: string): string | null {
  const trimmed = content.trim();

  // Find balanced braces
  if (trimmed.startsWith('{')) {
    const end = findBalancedEnd(trimmed, '{', '}');
    if (end !== -1) return trimmed.slice(0, end + 1);
  }

  if (trimmed.startsWith('[')) {
    const end = findBalancedEnd(trimmed, '[', ']');
    if (end !== -1) return trimmed.slice(0, end + 1);
  }

  // Try to find JSON object anywhere in the content
  const braceIdx = trimmed.indexOf('{');
  if (braceIdx !== -1) {
    const fromBrace = trimmed.slice(braceIdx);
    const end = findBalancedEnd(fromBrace, '{', '}');
    if (end !== -1) return fromBrace.slice(0, end + 1);
  }

  return null;
}

/**
 * Extract content between custom tags like <tag>...</tag>.
 */
function extractTaggedContent(content: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i');
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * Try to extract structured data from simple XML/HTML-like fields.
 * e.g., <name>John</name><age>30</age>
 */
function tryExtractXmlFields(content: string): Record<string, string> | null {
  const fields: Record<string, string> = {};
  const regex = /<(\w+)>([^<]*)<\/(\w+)>/g;
  let match;
  let found = false;

  while ((match = regex.exec(content)) !== null) {
    if (match[1] === match[3]) {
      fields[match[1]] = match[2].trim();
      found = true;
    }
  }

  return found ? fields : null;
}

/**
 * Try to extract key: value pairs from content.
 */
function tryExtractYamlFields(content: string): Record<string, string> | null {
  const lines = content.split('\n');
  const fields: Record<string, string> = {};
  let found = false;

  for (const line of lines) {
    const match = line.match(/^\s*(\w[\w\s]*?)\s*:\s*(.+?)\s*$/);
    if (match) {
      fields[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
      found = true;
    }
  }

  return found && Object.keys(fields).length > 0 ? fields : null;
}

/**
 * Find the index of the matching closing bracket for an opening bracket.
 * Returns -1 if no balanced close is found.
 */
function findBalancedEnd(str: string, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let stringChar = '';

  // Track string literals to avoid counting brackets inside strings
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inString) {
      if (ch === stringChar && str[i - 1] !== '\\') {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  // If string was never closed, try returning end of content as fallback
  // This handles single-line JSON-like content
  if (inString) {
    const nonSpace = str.replace(/\s/g, '');
    if (nonSpace.startsWith('{') && nonSpace.endsWith('}')) return str.length - 1;
  }

  return -1;
}