import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ExternalCommanderInvocation {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ExternalCommanderInvocationResult {
  gatewayPayload: unknown;
  agentPid?: number;
  discoveredTools?: string[];
  transport?: string;
  model?: string;
  openaiRequestOrTraceId?: string;
}

export interface OpenAIAgentsMcpFetchOptions {
  invoke?: (input: ExternalCommanderInvocation) => Promise<ExternalCommanderInvocationResult>;
  gatewayUrl?: string;
  apiKey?: string;
  tenantId?: string;
  timeoutMs?: number;
  consumerCommand?: string;
  consumerArgs?: readonly string[];
  mcpCommand?: string;
  mcpArgs?: readonly string[];
  cwd?: string;
  evidenceLogFile?: string;
  liveProposal?: {
    apiKey: string;
    model: string;
    modelApi: 'responses' | 'chat_completions';
    modelBaseUrl?: string;
  };
}

interface TrackedAction {
  idempotencyKey: string;
  state?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyRecord(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('MCP_GATEWAY_BODY_INVALID');
  try {
    const parsed = JSON.parse(init.body) as unknown;
    if (!isRecord(parsed)) throw new Error('MCP_GATEWAY_BODY_INVALID');
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'MCP_GATEWAY_BODY_INVALID') throw error;
    throw new Error('MCP_GATEWAY_BODY_INVALID');
  }
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('MCP_GATEWAY_PATH_INVALID');
  }
}

function responseStatus(toolName: string): number {
  return [
    'commander_action_propose',
    'commander_action_reconcile',
    'commander_action_compensation_request',
    'commander_action_compensation_approve',
  ].includes(toolName)
    ? 202
    : 200;
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(object[key]))
      .join(',') +
    '}'
  );
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

const SAFE_CONSUMER_ERROR_CODES = [
  'MCP_TOOL_NOT_DISCOVERED',
  'MCP_TOOL_RESULT_JSON_INVALID',
  'AGENT_FINAL_OUTPUT_INVALID',
  'OPENAI_AGENTS_MCP_CONSUMER_OUTPUT_INVALID',
  'LIVE_MODEL_REQUIRED',
] as const;

function safeConsumerFailureCode(stderr: string): string | undefined {
  return SAFE_CONSUMER_ERROR_CODES.find((code) => stderr.includes(code));
}

function sanitizedConsumerStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n')
    .slice(-1_600)
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function createProcessInvoker(
  options: OpenAIAgentsMcpFetchOptions,
): (input: ExternalCommanderInvocation) => Promise<ExternalCommanderInvocationResult> {
  const root = options.cwd ?? resolve(import.meta.dirname, '..');
  const consumerCommand = options.consumerCommand ?? process.execPath;
  const consumerArgs = options.consumerArgs ?? [
    '--import',
    'tsx',
    resolve(root, 'integrations', 'openai-agents-mcp', 'src', 'cli.ts'),
  ];
  const mcpCommand = options.mcpCommand ?? process.execPath;
  const mcpArgs = options.mcpArgs ?? [resolve(root, 'packages', 'mcp-server', 'dist', 'cli.js')];
  const gatewayUrl = nonEmptyString(options.gatewayUrl, 'MCP_GATEWAY_URL_REQUIRED');
  const apiKey = nonEmptyString(options.apiKey, 'MCP_GATEWAY_API_KEY_REQUIRED');
  const tenantId = nonEmptyString(options.tenantId, 'MCP_GATEWAY_TENANT_ID_REQUIRED');
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async (input) =>
    new Promise((resolvePromise, reject) => {
      const liveProposal =
        input.toolName === 'commander_action_propose' ? options.liveProposal : undefined;
      const child = spawn(consumerCommand, [...consumerArgs], {
        cwd: root,
        env: {
          ...scrubbedEnvironment(),
          ...(liveProposal ? { OPENAI_API_KEY: liveProposal.apiKey } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        settled = true;
        reject(new Error('OPENAI_AGENTS_MCP_CONSUMER_TIMEOUT'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 2_048) stderr += chunk;
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const failureCode = safeConsumerFailureCode(stderr);
          const detail = sanitizedConsumerStderr(stderr);
          const invocationContext = JSON.stringify({
            toolName: input.toolName,
            ...(typeof input.args.runId === 'string' ? { runId: input.args.runId } : {}),
            ...(typeof input.args.authorizationId === 'string'
              ? { authorizationId: input.args.authorizationId }
              : {}),
          });
          reject(
            new Error(
              [
                failureCode
                  ? 'OPENAI_AGENTS_MCP_CONSUMER_FAILED:' + failureCode
                  : 'OPENAI_AGENTS_MCP_CONSUMER_FAILED',
                `invocation=${invocationContext}`,
                detail ? `stderr=${detail}` : '',
              ]
                .filter(Boolean)
                .join(':'),
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!isRecord(parsed) || !('gatewayPayload' in parsed)) {
            throw new Error('OPENAI_AGENTS_MCP_CONSUMER_OUTPUT_INVALID');
          }
          resolvePromise({
            gatewayPayload: parsed.gatewayPayload,
            ...(typeof parsed.agentPid === 'number' ? { agentPid: parsed.agentPid } : {}),
            ...(Array.isArray(parsed.discoveredTools) &&
            parsed.discoveredTools.every((tool) => typeof tool === 'string')
              ? { discoveredTools: parsed.discoveredTools }
              : {}),
            ...(typeof parsed.transport === 'string' ? { transport: parsed.transport } : {}),
            ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
            ...(typeof parsed.openaiRequestOrTraceId === 'string'
              ? { openaiRequestOrTraceId: parsed.openaiRequestOrTraceId }
              : {}),
          });
        } catch (error) {
          reject(
            error instanceof Error && error.message === 'OPENAI_AGENTS_MCP_CONSUMER_OUTPUT_INVALID'
              ? error
              : new Error('OPENAI_AGENTS_MCP_CONSUMER_OUTPUT_INVALID'),
          );
        }
      });
      child.stdin.end(
        JSON.stringify({
          mode: liveProposal ? 'live' : 'deterministic',
          toolName: input.toolName,
          args: input.args,
          ...(liveProposal
            ? {
                model: liveProposal.model,
                modelApi: liveProposal.modelApi,
                ...(liveProposal.modelBaseUrl ? { modelBaseUrl: liveProposal.modelBaseUrl } : {}),
              }
            : {}),
          mcpCommand,
          mcpArgs,
          mcpCwd: root,
          mcpEnv: {
            COMMANDER_PROFILE: 'enterprise',
            COMMANDER_ACTION_GATEWAY_URL: gatewayUrl,
            COMMANDER_API_KEY: apiKey,
            COMMANDER_TENANT_ID: tenantId,
          },
          timeoutMs,
        }),
      );
    });
}

export function createOpenAIAgentsMcpFetch(
  options: OpenAIAgentsMcpFetchOptions,
): typeof globalThis.fetch {
  const invoke = options.invoke ?? createProcessInvoker(options);
  const tracked = new Map<string, TrackedAction>();

  async function recordEvidence(
    invocation: ExternalCommanderInvocation,
    result: ExternalCommanderInvocationResult,
  ): Promise<void> {
    if (!options.evidenceLogFile) return;
    const payload = isRecord(result.gatewayPayload) ? result.gatewayPayload : undefined;
    const action = payload && isRecord(payload.action) ? payload.action : undefined;
    const receipt = payload && isRecord(payload.receipt) ? payload.receipt : undefined;
    const scope = receipt && isRecord(receipt.scope) ? receipt.scope : undefined;
    const verification =
      payload && isRecord(payload.verification) ? payload.verification : undefined;
    const outcome = {
      actionId:
        typeof action?.runId === 'string'
          ? action.runId
          : typeof scope?.runId === 'string'
            ? scope.runId
            : undefined,
      state: typeof action?.state === 'string' ? action.state : undefined,
      receiptHash: receipt ? sha256(receipt) : undefined,
      receiptDisposition:
        receipt && typeof receipt.terminalDisposition === 'string'
          ? receipt.terminalDisposition
          : undefined,
      receiptVerified: verification?.ok === true,
    };
    const liveProposal =
      invocation.toolName === 'commander_action_propose' && options.liveProposal !== undefined;
    const record = liveProposal
      ? {
          timestamp: new Date().toISOString(),
          model: result.model,
          openaiRequestOrTraceId: result.openaiRequestOrTraceId,
          ...outcome,
        }
      : {
          timestamp: new Date().toISOString(),
          toolName: invocation.toolName,
          transport: result.transport,
          agentPid: result.agentPid,
          discoveredTools: result.discoveredTools,
          ...outcome,
        };
    await appendFile(resolve(options.evidenceLogFile), JSON.stringify(record) + '\n', 'utf8');
  }

  function idempotencyKey(
    headers: HeadersInit | undefined,
    runId: string,
    operation: string,
  ): string {
    const explicit = new Headers(headers).get('idempotency-key');
    if (explicit) return explicit;
    const original = tracked.get(runId)?.idempotencyKey;
    if (!original) throw new Error('MCP_IDEMPOTENCY_KEY_REQUIRED');
    return original + ':' + operation;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const path = url.pathname;
    let invocation: ExternalCommanderInvocation;

    if (method === 'POST' && path === '/v1/actions') {
      if ([...tracked.values()].some((action) => action.state === 'COMPLETION_UNKNOWN')) {
        throw new Error('MCP_PROPOSE_DURING_COMPLETION_UNKNOWN_FORBIDDEN');
      }
      const body = bodyRecord(init);
      nonEmptyString(body.idempotencyKey, 'MCP_IDEMPOTENCY_KEY_REQUIRED');
      invocation = { toolName: 'commander_action_propose', args: body };
    } else {
      const compensationApproval = path.match(
        /^\/v1\/actions\/([^/]+)\/compensations\/([^/]+)\/approve$/,
      );
      const compensationRequest = path.match(/^\/v1\/actions\/([^/]+)\/compensations$/);
      const actionOperation = path.match(/^\/v1\/actions\/([^/]+)\/(approve|reconcile|evidence)$/);
      const actionGet = path.match(/^\/v1\/actions\/([^/]+)$/);

      if (method === 'POST' && compensationApproval) {
        const runId = decoded(compensationApproval[1]!);
        const authorizationId = decoded(compensationApproval[2]!);
        invocation = {
          toolName: 'commander_action_compensation_approve',
          args: {
            runId,
            authorizationId,
            idempotencyKey: idempotencyKey(
              init?.headers,
              runId,
              'compensation-approve:' + encodeURIComponent(authorizationId),
            ),
            ...bodyRecord(init),
          },
        };
      } else if (method === 'POST' && compensationRequest) {
        const runId = decoded(compensationRequest[1]!);
        invocation = {
          toolName: 'commander_action_compensation_request',
          args: {
            runId,
            idempotencyKey: idempotencyKey(init?.headers, runId, 'compensation-request'),
            ...bodyRecord(init),
          },
        };
      } else if (actionOperation) {
        const runId = decoded(actionOperation[1]!);
        const operation = actionOperation[2]!;
        if (method === 'POST' && operation === 'approve') {
          invocation = {
            toolName: 'commander_action_approve',
            args: {
              runId,
              idempotencyKey: idempotencyKey(init?.headers, runId, 'approve'),
              ...bodyRecord(init),
            },
          };
        } else if (method === 'POST' && operation === 'reconcile') {
          bodyRecord(init);
          invocation = {
            toolName: 'commander_action_reconcile',
            args: {
              runId,
              idempotencyKey: idempotencyKey(init?.headers, runId, 'reconcile'),
            },
          };
        } else if (method === 'GET' && operation === 'evidence') {
          invocation = { toolName: 'commander_action_evidence', args: { runId } };
        } else {
          throw new Error('MCP_GATEWAY_ROUTE_UNSUPPORTED');
        }
      } else if (method === 'GET' && actionGet) {
        invocation = {
          toolName: 'commander_action_get',
          args: { runId: decoded(actionGet[1]!) },
        };
      } else {
        throw new Error('MCP_GATEWAY_ROUTE_UNSUPPORTED');
      }
    }

    const result = await invoke(invocation);
    await recordEvidence(invocation, result);
    if (invocation.toolName === 'commander_action_propose') {
      if (!isRecord(result.gatewayPayload) || !isRecord(result.gatewayPayload.action)) {
        throw new Error('MCP_PROPOSAL_RESULT_INVALID');
      }
      const runId = nonEmptyString(
        result.gatewayPayload.action.runId,
        'MCP_PROPOSAL_RUN_ID_REQUIRED',
      );
      tracked.set(runId, {
        idempotencyKey: nonEmptyString(
          invocation.args.idempotencyKey,
          'MCP_IDEMPOTENCY_KEY_REQUIRED',
        ),
        state:
          typeof result.gatewayPayload.action.state === 'string'
            ? result.gatewayPayload.action.state
            : undefined,
      });
    }
    if (invocation.toolName === 'commander_action_get' && isRecord(result.gatewayPayload)) {
      const runId = nonEmptyString(invocation.args.runId, 'MCP_RUN_ID_REQUIRED');
      const action = isRecord(result.gatewayPayload.action)
        ? result.gatewayPayload.action
        : undefined;
      const current = tracked.get(runId);
      if (current && typeof action?.state === 'string') current.state = action.state;
    }
    return jsonResponse(result.gatewayPayload, responseStatus(invocation.toolName));
  };
}
