#!/usr/bin/env node
/**
 * Static scan for external I/O bypass outside registered action-adapters.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXED_ACTION_ADAPTER_MANIFESTS } from '../packages/contracts/src/actionAdapters.js';

const ROOT = process.cwd();

const SCAN_ROOTS = [
  'packages/kernel/src',
  'packages/effect-broker/src',
  'packages/worker-plane/src',
  'packages/adapter-ops/src',
  'packages/action-adapters/src',
  'packages/contracts/src',
  'packages/core/src',
  'packages/sdk/src',
  'packages/mcp-server/src',
  'apps/api/src',
];

const EXCLUDE_PATTERNS = [
  /\.test\.ts$/,
  /\.integration\.test\.ts$/,
  /\/__tests__\//,
  /\/fixtures\//,
];

function escapedIdentifier(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHttpOutbound(source: string, moduleName: 'http' | 'https'): boolean {
  const modulePattern = `(?:node:)?${moduleName}`;
  const methods = '(?:get|request)';

  if (
    new RegExp(
      `(?:require|import)\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)\\s*\\.\\s*${methods}\\s*\\(`,
    ).test(source) ||
    new RegExp(
      `\\(\\s*await\\s+import\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)\\s*\\)\\s*\\.\\s*${methods}\\s*\\(`,
    ).test(source)
  ) {
    return true;
  }

  const objectBindings: string[] = [];
  const objectBindingPatterns = [
    new RegExp(
      `import\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['\"]${modulePattern}['\"]`,
      'g',
    ),
    new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['\"]${modulePattern}['\"]`, 'g'),
    new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)`,
      'g',
    ),
    new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)`,
      'g',
    ),
  ];
  for (const pattern of objectBindingPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) objectBindings.push(match[1]);
    }
  }
  if (
    objectBindings.some((name) =>
      new RegExp(`\\b${escapedIdentifier(name)}\\s*\\.\\s*${methods}\\s*\\(`).test(source),
    )
  ) {
    return true;
  }

  const namedBindingPatterns = [
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['\"]${modulePattern}['\"]`, 'g'),
    new RegExp(
      `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)`,
      'g',
    ),
    new RegExp(
      `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(?:await\\s+)?import\\s*\\(\\s*['\"]${modulePattern}['\"]\\s*\\)`,
      'g',
    ),
  ];
  for (const pattern of namedBindingPatterns) {
    for (const match of source.matchAll(pattern)) {
      for (const member of (match[1] ?? '').split(',')) {
        const binding = member.trim().match(/^(get|request)\s*(?:(?:as|:)\s*([A-Za-z_$][\w$]*))?$/);
        const localName = binding?.[2] ?? binding?.[1];
        if (localName && new RegExp(`\\b${escapedIdentifier(localName)}\\s*\\(`).test(source)) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasNetOutbound(source: string): boolean {
  if (
    /import\s*\{[^}]*\b(?:connect|createConnection)\b[^}]*\}\s*from\s*['"](?:node:)?net['"]/.test(
      source,
    ) ||
    /(?:const|let|var)\s*\{[^}]*\b(?:connect|createConnection)\b[^}]*\}\s*=\s*require\s*\(\s*['"](?:node:)?net['"]\s*\)/.test(
      source,
    ) ||
    /require\s*\(\s*['"](?:node:)?net['"]\s*\)\s*\.\s*(?:connect|createConnection)\s*\(/.test(
      source,
    )
  ) {
    return true;
  }

  const bindings = [
    ...source.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?net['"]/g),
    ...source.matchAll(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"](?:node:)?net['"]\s*\)/g,
    ),
  ];
  return bindings.some((match) => {
    const binding = escapedIdentifier(match[1] ?? '');
    return new RegExp(
      `\\b${binding}\\s*\\.\\s*(?:connect|createConnection)\\s*\\(|new\\s+${binding}\\s*\\.\\s*Socket\\s*\\([^)]*\\)\\s*\\.\\s*connect\\s*\\(`,
    ).test(source);
  });
}

function hasChildProcessExecution(source: string): boolean {
  if (
    /import\s*\{[^}]*\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/.test(
      source,
    ) ||
    /(?:const|let|var)\s*\{[^}]*\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b[^}]*\}\s*=\s*require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(
      source,
    )
  ) {
    return true;
  }
  const importsChildProcess =
    /\bfrom\s*['"](?:node:)?child_process['"]/.test(source) ||
    /\brequire\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source) ||
    /\bimport\s*\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source);
  return (
    importsChildProcess &&
    /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/.test(source)
  );
}

interface IoPattern {
  name: string;
  regex: RegExp;
  detect?: (source: string) => boolean;
}

const IO_PATTERNS: IoPattern[] = [
  { name: 'fetch', regex: /\bfetch\s*\(/ },
  { name: 'axios', regex: /\baxios\b/ },
  { name: 'undici', regex: /\bundici\b/ },
  {
    name: 'node:http',
    regex: /\b(?:get|request)\b/,
    detect: (source) => hasHttpOutbound(source, 'http'),
  },
  {
    name: 'node:https',
    regex: /\b(?:get|request)\b/,
    detect: (source) => hasHttpOutbound(source, 'https'),
  },
  {
    name: 'net',
    regex: /\b(?:connect|createConnection)\b/,
    detect: hasNetOutbound,
  },
  { name: 'WebSocket', regex: /\bWebSocket\b|\bnew\s+WebSocket\s*\(/ },
  {
    name: 'child_process',
    regex: /\bchild_process\b/,
    detect: hasChildProcessExecution,
  },
];

interface ExceptionEntry {
  id: string;
  path: string;
  expiresAt: string;
  patterns: string[];
}

interface AllowlistEntry {
  id: string;
  path: string;
  sourceSha256: string;
  owner: string;
  reason: string;
  expiresAt: string;
  patterns: string[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function isExcluded(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(relPath));
}

function walk(dir: string, root: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(root, full).split('\\').join('/');
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, root, files);
    } else if (entry.endsWith('.ts') && !isExcluded(rel)) {
      files.push(full);
    }
  }
  return files;
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validAllowlistMetadata(entry: AllowlistEntry): boolean {
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    SHA256.test(entry.sourceSha256) &&
    typeof entry.owner === 'string' &&
    entry.owner.length > 0 &&
    typeof entry.reason === 'string' &&
    entry.reason.length >= 10 &&
    validIsoDate(entry.expiresAt) &&
    Array.isArray(entry.patterns) &&
    entry.patterns.length > 0 &&
    entry.patterns.every((pattern) => typeof pattern === 'string' && pattern.length > 0),
  );
}

function registeredAdapterPrefixes(): string[] {
  const prefixes = new Set<string>();
  for (const manifest of FIXED_ACTION_ADAPTER_MANIFESTS) {
    if (manifest.adapterId.startsWith('github.'))
      prefixes.add('packages/action-adapters/src/github');
    if (manifest.adapterId.startsWith('servicenow.'))
      prefixes.add('packages/action-adapters/src/servicenow');
  }
  return [...prefixes];
}

function sourceMatchesPattern(source: string, pattern: string): boolean {
  const body = analyzableSource(source);
  if (pattern === 'fetch(') return /\bfetch\s*\(/.test(body);
  return body.includes(pattern);
}

function stripComments(source: string): string {
  const moduleSpecifiers = new Set([
    'http',
    'https',
    'net',
    'child_process',
    'node:http',
    'node:https',
    'node:net',
    'node:child_process',
  ]);
  let output = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      while (index < source.length) {
        const current = source[index];
        const after = source[index + 1];
        if (current === '\r' || current === '\n') output += current;
        else output += ' ';
        index += 1;
        if (current === '*' && after === '/') {
          output += ' ';
          index += 1;
          break;
        }
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let literal = quote;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        literal += current;
        index += 1;
        if (current === '\\' && index < source.length) {
          literal += source[index];
          index += 1;
        } else if (current === quote) {
          break;
        }
      }
      output += moduleSpecifiers.has(literal.slice(1, -1)) ? literal : `${quote}${quote}`;
      continue;
    }
    if (char === '`') {
      output += char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        output += current;
        index += 1;
        if (current === '\\' && index < source.length) {
          output += source[index];
          index += 1;
        } else if (current === '`') {
          break;
        }
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function stripTypeOnlyImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s+type\b/.test(line))
    .join('\n');
}

function analyzableSource(source: string): string {
  return stripTypeOnlyImports(stripComments(source));
}

function detectedIoTypes(source: string): string[] {
  const body = analyzableSource(source);
  return IO_PATTERNS.filter(({ regex, detect }) => (detect ? detect(body) : regex.test(body))).map(
    ({ name }) => name,
  );
}

function allowlistCoversAll(source: string, allow: AllowlistEntry): boolean {
  const detected = detectedIoTypes(source);
  if (detected.length === 0) return false;
  return detected.every((ioName) => {
    const io = IO_PATTERNS.find((p) => p.name === ioName);
    if (!io) return false;
    // Pattern must itself name/target this IO type (not merely co-exist in the file).
    return allow.patterns.some(
      (p) => (p === ioName || io.regex.test(p)) && sourceMatchesPattern(source, p),
    );
  });
}

function exceptionCoversAll(source: string, exception: ExceptionEntry): boolean {
  const detected = detectedIoTypes(source);
  if (detected.length === 0) return false;
  return detected.every((ioName) => {
    const io = IO_PATTERNS.find((p) => p.name === ioName);
    if (!io) return false;
    return exception.patterns.some(
      (p) => (p === ioName || io.regex.test(p)) && sourceMatchesPattern(source, p),
    );
  });
}

export function scanEffectIo(root = ROOT): string[] {
  const errors: string[] = [];
  const exceptionsConfig = loadJson<{ baselineCount: number; exceptions: ExceptionEntry[] }>(
    join(root, 'config/effect-io-exceptions.json'),
  );
  const allowlistConfig = loadJson<{ paths: AllowlistEntry[] }>(
    join(root, 'config/effect-io-allowlist.json'),
  );
  const adapterPrefixes = registeredAdapterPrefixes();
  const today = new Date().toISOString().slice(0, 10);
  const exceptionByPath = new Map(exceptionsConfig.exceptions.map((e) => [e.path, e]));
  const validAllowlist: AllowlistEntry[] = [];

  if (exceptionsConfig.exceptions.length > exceptionsConfig.baselineCount) {
    errors.push(
      `effect-io exception count ${exceptionsConfig.exceptions.length} exceeds baseline ${exceptionsConfig.baselineCount}`,
    );
  }

  for (const ex of exceptionsConfig.exceptions) {
    const sourcePath = join(root, ex.path);
    if (!existsSync(sourcePath)) {
      errors.push(
        `Stale effect-io exception '${ex.id}' (${ex.path}) references a deleted source file`,
      );
    } else if (ex.expiresAt < today) {
      errors.push(`Expired effect-io exception '${ex.id}' (${ex.path})`);
    } else if (detectedIoTypes(readFileSync(sourcePath, 'utf-8')).length === 0) {
      errors.push(
        `Stale effect-io exception '${ex.id}' (${ex.path}) no longer matches its approved I/O`,
      );
    }
  }

  for (const allow of allowlistConfig.paths) {
    const label = allow?.id || allow?.path || '<unknown>';
    if (!validAllowlistMetadata(allow)) {
      errors.push(`Invalid effect-io allowlist '${label}'`);
      continue;
    }
    const sourcePath = join(root, allow.path);
    if (!existsSync(sourcePath)) {
      errors.push(
        `Stale effect-io allowlist '${allow.id}' (${allow.path}) references a deleted source file`,
      );
      continue;
    }
    if (allow.expiresAt < today) {
      errors.push(`Expired effect-io allowlist '${allow.id}' (${allow.path})`);
      continue;
    }
    const source = readFileSync(sourcePath, 'utf-8');
    if (sha256(source) !== allow.sourceSha256) {
      errors.push(`Source drift in effect-io allowlist '${allow.id}' (${allow.path})`);
      continue;
    }
    if (!allowlistCoversAll(source, allow)) {
      errors.push(`Unnecessary or incomplete effect-io allowlist '${allow.id}' (${allow.path})`);
      continue;
    }
    validAllowlist.push(allow);
  }

  const allowlistByPath = new Map(validAllowlist.map((entry) => [entry.path, entry]));

  for (const scanRoot of SCAN_ROOTS) {
    for (const file of walk(join(root, scanRoot), root)) {
      const rel = relative(root, file).split('\\').join('/');
      const source = readFileSync(file, 'utf-8');
      const ioTypes = detectedIoTypes(source);
      if (ioTypes.length === 0) continue;

      if (adapterPrefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        continue;
      }

      const allow = allowlistByPath.get(rel);
      if (allow && allowlistCoversAll(source, allow)) continue;

      const exception = exceptionByPath.get(rel);
      if (exception && exceptionCoversAll(source, exception)) {
        continue;
      }

      errors.push(`New external I/O bypass: ${rel} (${ioTypes.join(', ')})`);
    }
  }

  return errors;
}

function main(): void {
  const errors = scanEffectIo();
  if (errors.length > 0) {
    console.error('[effect:io-guard] FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('[effect:io-guard] PASSED — no new external I/O bypasses.');
}

const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href ||
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main();
}
