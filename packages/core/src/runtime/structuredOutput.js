"use strict";
/**
 * Structured Output Parsing Utilities
 *
 * Provides reliable extraction of JSON/structured data from LLM responses,
 * supporting multiple output formats (JSON blocks, XML tags, YAML, markdown code blocks).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseStructuredOutput = parseStructuredOutput;
exports.validateStructuredOutput = validateStructuredOutput;
exports.validateShape = validateShape;
/**
 * Attempt to parse structured output from an LLM response.
 * Tries multiple extraction strategies in order of likelihood.
 */
const logging_1 = require("../logging");
function parseStructuredOutput(input, fallback) {
    // Strategy 0: Provider-native parsed structured output (OpenAI json_schema,
    // Google responseSchema, Anthropic tool_use). Use it directly when available.
    if (typeof input === 'object' && input !== null && input.parsed) {
        return { success: true, data: input.parsed };
    }
    const content = typeof input === 'string' ? input : input.content;
    // Strategy 1: Extract JSON from markdown code block
    const jsonBlock = extractJsonBlock(content);
    if (jsonBlock !== null) {
        try {
            return { success: true, data: JSON.parse(jsonBlock) };
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('StructuredOutput', 'Failed to parse JSON code block', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    // Strategy 2: Extract JSON from raw response (strip leading/trailing non-JSON)
    const rawJson = extractRawJson(content);
    if (rawJson !== null) {
        try {
            return { success: true, data: JSON.parse(rawJson) };
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('StructuredOutput', 'Failed to parse raw JSON', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    // Strategy 3: Extract JSON from `<output_json>...</output_json>` tags
    const taggedJson = extractTaggedContent(content, 'output_json');
    if (taggedJson !== null) {
        try {
            return { success: true, data: JSON.parse(taggedJson) };
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().debug('StructuredOutput', 'Failed to parse tagged JSON', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
    }
    // Strategy 4: Extract XML-like structured content
    const xmlData = tryExtractXmlFields(content);
    if (xmlData !== null) {
        return { success: true, data: xmlData };
    }
    // Strategy 5: Try YAML-ish key: value pairs (simple flat objects)
    const yamlData = tryExtractYamlFields(content);
    if (yamlData !== null) {
        return { success: true, data: yamlData };
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
function validateStructuredOutput(result, requiredKeys) {
    if (!result.success)
        return false;
    return requiredKeys.every((key) => key in result.data);
}
/**
 * Runtime type guard that validates a parsed value matches an expected shape.
 * Use after parseStructuredOutput() to ensure the returned data actually has
 * the expected keys and types — preventing `as T` from masking shape mismatches.
 *
 * @example
 * const parsed = parseStructuredOutput(content);
 * if (parsed.success && validateShape(parsed.data, { name: 'string', age: 'number' })) {
 *   parsed.data.name; // string, safely narrowed
 * }
 */
function validateShape(value, shape) {
    if (typeof value !== 'object' || value === null)
        return false;
    const obj = value;
    for (const [key, expectedType] of Object.entries(shape)) {
        if (!(key in obj))
            return false;
        if (expectedType === 'array') {
            if (!Array.isArray(obj[key]))
                return false;
        }
        else if (typeof obj[key] !== expectedType) {
            return false;
        }
    }
    return true;
}
/**
 * Extract JSON from markdown code fences: ```json ... ```
 */
function extractJsonBlock(content) {
    // Try ```json ... ``` first
    const jsonFence = content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonFence)
        return jsonFence[1].trim();
    // Try ``` ... ``` and hope it's JSON
    const anyFence = content.match(/```\s*([\s\S]*?)\n```/);
    if (anyFence) {
        const trimmed = anyFence[1].trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('['))
            return trimmed;
    }
    return null;
}
/**
 * Extract JSON by finding the first { ... } or [ ... ] block.
 */
function extractRawJson(content) {
    const trimmed = content.trim();
    // Find balanced braces
    if (trimmed.startsWith('{')) {
        const end = findBalancedEnd(trimmed, '{', '}');
        if (end !== -1)
            return trimmed.slice(0, end + 1);
    }
    if (trimmed.startsWith('[')) {
        const end = findBalancedEnd(trimmed, '[', ']');
        if (end !== -1)
            return trimmed.slice(0, end + 1);
    }
    // Try to find JSON object anywhere in the content
    const braceIdx = trimmed.indexOf('{');
    if (braceIdx !== -1) {
        const fromBrace = trimmed.slice(braceIdx);
        const end = findBalancedEnd(fromBrace, '{', '}');
        if (end !== -1)
            return fromBrace.slice(0, end + 1);
    }
    return null;
}
/**
 * Extract content between custom tags like <tag>...</tag>.
 */
function extractTaggedContent(content, tag) {
    const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i');
    const match = content.match(regex);
    return match ? match[1].trim() : null;
}
/**
 * Try to extract structured data from simple XML/HTML-like fields.
 * e.g., <name>John</name><age>30</age>
 */
function tryExtractXmlFields(content) {
    const fields = {};
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
function tryExtractYamlFields(content) {
    const lines = content.split('\n');
    const fields = {};
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
function findBalancedEnd(str, open, close) {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    // Track string literals to avoid counting brackets inside strings
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
            if (ch === stringChar) {
                // Count consecutive backslashes before this quote
                let bs = 0;
                for (let j = i - 1; j >= 0 && str[j] === '\\'; j--)
                    bs++;
                if (bs % 2 === 0)
                    inString = false; // Even backslashes = not escaped
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = true;
            stringChar = ch;
            continue;
        }
        if (ch === open)
            depth++;
        if (ch === close) {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    // If string was never closed, try returning end of content as fallback
    // This handles single-line JSON-like content
    if (inString) {
        const nonSpace = str.replace(/\s/g, '');
        if (nonSpace.startsWith('{') && nonSpace.endsWith('}'))
            return str.length - 1;
    }
    return -1;
}
