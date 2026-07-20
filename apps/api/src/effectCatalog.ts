/**
 * Gateway-authoritative effect catalog for localOnly claims (L3-03b-http).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface EffectCatalogDocument {
  version: string;
  tools: string[];
  connectors: string[];
  contentHash: string;
  /** HMAC-SHA256 over contentHash (hex). Required for worker trust when secret configured. */
  signature?: string;
}

/** Tools/connectors that must never be admitted as localOnly (broker bypass). */
export const NEVER_LOCAL_ONLY_TOOLS = new Set([
  'http.post',
  'http.get',
  'http.request',
  'shell_execute',
  'shell.exec',
  'git_push',
  'webhook.dispatch',
]);

export const NEVER_LOCAL_ONLY_CONNECTORS = new Set(['http', 'webhook', 'smtp']);

export function defaultEffectCatalogDocument(
  env: NodeJS.ProcessEnv = process.env,
): EffectCatalogDocument {
  const tools = parseList(env.COMMANDER_EFFECT_CATALOG_TOOLS) ?? ['echo'];
  const connectors = parseList(env.COMMANDER_EFFECT_CATALOG_CONNECTORS) ?? ['memory'];
  return buildEffectCatalogDocument({ version: 'v0', tools, connectors }, env);
}

export function buildEffectCatalogDocument(
  input: {
    version: string;
    tools: string[];
    connectors: string[];
  },
  env: NodeJS.ProcessEnv = process.env,
): EffectCatalogDocument {
  const tools = [...new Set(input.tools.map((t) => t.trim()).filter(Boolean))]
    .filter((t) => !NEVER_LOCAL_ONLY_TOOLS.has(t))
    .sort();
  const connectors = [...new Set(input.connectors.map((c) => c.trim()).filter(Boolean))]
    .filter((c) => !NEVER_LOCAL_ONLY_CONNECTORS.has(c))
    .sort();
  const canonical = JSON.stringify({ version: input.version, tools, connectors });
  const contentHash = createHash('sha256').update(canonical).digest('hex');
  const doc: EffectCatalogDocument = { version: input.version, tools, connectors, contentHash };
  const secret = env.COMMANDER_EFFECT_CATALOG_HMAC_SECRET?.trim();
  if (secret) {
    doc.signature = signCatalogContentHash(contentHash, secret);
  }
  return doc;
}

export function signCatalogContentHash(contentHash: string, secret: string): string {
  return createHmac('sha256', secret).update(contentHash).digest('hex');
}

export function verifyCatalogSignature(
  doc: Pick<EffectCatalogDocument, 'contentHash' | 'signature'>,
  secret: string,
): boolean {
  if (!doc.signature || typeof doc.signature !== 'string') return false;
  const expected = signCatalogContentHash(doc.contentHash, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(doc.signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isCatalogLocalOnlyTool(catalog: EffectCatalogDocument, toolName: string): boolean {
  if (NEVER_LOCAL_ONLY_TOOLS.has(toolName)) return false;
  return catalog.tools.includes(toolName);
}

export function isCatalogLocalOnlyConnector(
  catalog: EffectCatalogDocument,
  connectorName: string,
): boolean {
  if (NEVER_LOCAL_ONLY_CONNECTORS.has(connectorName)) return false;
  return catalog.connectors.includes(connectorName);
}

/**
 * Reject forged localOnly claims at Gateway admit time.
 * Returns an error code or null when OK.
 */
export function validateStepsAgainstEffectCatalog(
  steps: ReadonlyArray<{ kind: string; input?: Record<string, unknown> }>,
  catalog: EffectCatalogDocument,
): { code: string; message: string } | null {
  for (const step of steps) {
    const input = step.input ?? {};
    if (input.localOnly !== true) continue;
    if (step.kind === 'tool') {
      const toolName = typeof input.toolName === 'string' ? input.toolName : '';
      if (!toolName || !isCatalogLocalOnlyTool(catalog, toolName)) {
        return {
          code: 'LOCALONLY_NOT_IN_CATALOG',
          message: `Tool localOnly claim rejected: '${toolName || '(missing)'}' is not in Gateway effect-catalog.`,
        };
      }
    }
    if (step.kind === 'connector') {
      const connectorName =
        typeof input.connectorName === 'string'
          ? input.connectorName
          : typeof input.name === 'string'
            ? input.name
            : '';
      if (!connectorName || !isCatalogLocalOnlyConnector(catalog, connectorName)) {
        return {
          code: 'LOCALONLY_NOT_IN_CATALOG',
          message: `Connector localOnly claim rejected: '${connectorName || '(missing)'}' is not in Gateway effect-catalog.`,
        };
      }
      if (input.connection != null) {
        return {
          code: 'LOCALONLY_CONNECTION_FORBIDDEN',
          message: 'Connector localOnly with connection is forbidden at Gateway admit.',
        };
      }
    }
  }
  return null;
}

function parseList(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
