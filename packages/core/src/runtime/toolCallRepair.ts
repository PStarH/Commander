/**
 * Tool Call Argument Repair — Multi-Strategy Malformed Argument Recovery
 *
 * LLMs sometimes emit malformed JSON: trailing commas, markdown fences,
 * single quotes, text-wrapped JSON, or even XML-like tool call formats.
 * This module applies conservative repair strategies to recover parseable
 * arguments before validation and execution.
 *
 * Design principles (from Hermes):
 * - Never invent data — only fix clearly fixable structural issues
 * - Record all repairs for observability
 * - Stop at first successful parse
 */

// ============================================================================
// Types
// ============================================================================

export interface RepairResult {
  args: Record<string, unknown>;
  repairs: string[];
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Attempt to repair malformed tool call arguments.
 * Applies multiple strategies in order, stopping at first success.
 * Conservative: returns original input unchanged if nothing works.
 */
export function repairToolCallArguments(
  rawArgs: unknown,
  _toolName: string,
): RepairResult {
  // Strategy 1: Already an object (Anthropic returns parsed objects)
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return { args: rawArgs as Record<string, unknown>, repairs: [] };
  }

  if (typeof rawArgs !== 'string') {
    return { args: {}, repairs: ['non-string non-object input, returned empty'] };
  }

  const raw = rawArgs;

  // Strategy 2: Direct JSON.parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed, repairs: [] };
    }
  } catch { /* continue to repair strategies */ }

  // Strategy 3: Common-fix parse
  const fixed = applyCommonFixes(raw);
  if (fixed !== raw) {
    try {
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, repairs: describeFixes(raw, fixed) };
      }
    } catch { /* continue */ }
  }

  // Strategy 4: Regex extraction — find first {...} block
  const extracted = extractJsonObject(raw);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, repairs: ['extracted JSON object from surrounding text'] };
      }
    } catch { /* continue */ }
  }

  // Strategy 5: XML-like tool call format (generalized MiMo pattern)
  const xmlParsed = parseXmlLikeToolCall(raw);
  if (xmlParsed) {
    return { args: xmlParsed, repairs: ['parsed XML-like tool call format'] };
  }

  // All strategies failed — return empty args, let validation handle it
  return { args: {}, repairs: ['all repair strategies failed'] };
}

// ============================================================================
// Strategy 3: Common-Fix Parse
// ============================================================================

function applyCommonFixes(s: string): string {
  let result = s;

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  result = result.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  // Strip leading non-JSON text — find first { or [
  const firstBrace = result.indexOf('{');
  const firstBracket = result.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else if (firstBrace >= 0) start = firstBrace;
  else if (firstBracket >= 0) start = firstBracket;

  if (start > 0) {
    result = result.slice(start);
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  // Remove single-line comments (only at line start)
  result = result.replace(/^\s*\/\/.*$/gm, '');

  // Remove block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');

  // Replace single quotes with double quotes (conservative)
  if (!result.includes('"') || result.replace(/[^"]/g, '').length % 2 !== 0) {
    const singleQuoteCount = (result.match(/'/g) || []).length;
    if (singleQuoteCount >= 2 && singleQuoteCount % 2 === 0) {
      result = result.replace(/'/g, '"');
    }
  }

  return result.trim();
}

function describeFixes(original: string, _fixed: string): string[] {
  const fixes: string[] = [];
  if (original.includes('```')) fixes.push('stripped markdown code fences');
  if (/,\s*[}\]]/.test(original)) fixes.push('removed trailing comma');
  if (/\/\//.test(original) || /\/\*/.test(original)) fixes.push('removed comments');
  if (original.includes("'") && !original.includes('"')) fixes.push('replaced single quotes');
  if (fixes.length === 0) fixes.push('applied common fixes');
  return fixes;
}

// ============================================================================
// Strategy 4: Regex Extraction
// ============================================================================

function extractJsonObject(s: string): string | null {
  const braceStart = s.indexOf('{');
  if (braceStart >= 0) {
    const block = extractBalancedBlock(s, braceStart, '{', '}');
    if (block) return block;
  }

  const bracketStart = s.indexOf('[');
  if (bracketStart >= 0) {
    const block = extractBalancedBlock(s, bracketStart, '[', ']');
    if (block) return block;
  }

  return null;
}

function extractBalancedBlock(s: string, start: number, openChar: string, closeChar: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;

    if (depth === 0 && i > start) {
      return s.slice(start, i + 1);
    }
  }

  return null;
}

// ============================================================================
// Strategy 5: XML-Like Tool Call Format (generalized MiMo pattern)
// ============================================================================

/**
 * Parse XML-like tool call format used by some models.
 */
function parseXmlLikeToolCall(s: string): Record<string, unknown> | null {
  const funcMatch = s.match(/<function[=_]([^>]+)>/);
  if (!funcMatch) return null;

  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
  let paramMatch;

  while ((paramMatch = paramRegex.exec(s)) !== null) {
    const key = paramMatch[1].trim();
    let value: unknown = paramMatch[2].trim();

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^-?\d+(\.\d+)?$/.test(value as string)) value = Number(value);

    args[key] = value;
  }

  return Object.keys(args).length > 0 ? args : null;
}
