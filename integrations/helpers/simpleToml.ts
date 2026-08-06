/**
 * Minimal TOML-subset parser for the committed Codex MCP config
 * (integrations/codex/config.toml).
 *
 * Supports exactly the subset of TOML used by the Codex config file:
 *   - `#` comments (full-line and trailing, outside of strings)
 *   - `[section.subsection]` table headers
 *   - `key = "value"` string values
 *   - `key = [ "a", "b" ]` arrays of strings
 *   - `key = { K = "v" }` inline tables of string values
 *
 * Returns a nested object. Not a general-purpose TOML implementation — it
 * intentionally rejects nothing, but only these constructs are meaningful.
 */
export function parseSimpleToml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current = root;

  for (const rawLine of input.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const path = line.slice(1, -1).trim().split('.');
      current = root;
      for (const segment of path) {
        const existing = current[segment];
        if (existing === undefined || existing === null) {
          const next: Record<string, unknown> = {};
          current[segment] = next;
          current = next;
        } else if (typeof existing === 'object' && !Array.isArray(existing)) {
          current = existing as Record<string, unknown>;
        } else {
          throw new Error(`Cannot create table ${segment}: existing value is not a table`);
        }
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) throw new Error(`Expected "key = value", got: ${line}`);
    const key = line.slice(0, eq).trim();
    current[key] = parseValue(line.slice(eq + 1).trim());
  }

  return root;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inString = !inString;
    else if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new Error(`Malformed string: ${raw}`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error(`Malformed array: ${raw}`);
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseValue(item.trim()));
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new Error(`Malformed inline table: ${raw}`);
    const inner = value.slice(1, -1).trim();
    const result: Record<string, unknown> = {};
    if (!inner) return result;
    for (const pair of splitTopLevel(inner)) {
      const eq = pair.indexOf('=');
      if (eq === -1) throw new Error(`Malformed inline table entry: ${pair}`);
      result[pair.slice(0, eq).trim()] = parseValue(pair.slice(eq + 1).trim());
    }
    return result;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (value !== '' && Number.isFinite(num)) return num;
  return value;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') inString = !inString;
    else if (!inString) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(input.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}
