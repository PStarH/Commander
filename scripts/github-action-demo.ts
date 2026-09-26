#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR as descriptor } from '../packages/contracts/src/actionAdapters.js';
import { parseGitHubDestination } from '../packages/action-adapters/src/types.js';

class DemoError extends Error {}
type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DemoError('GATEWAY_RESPONSE_INVALID');
  return value as Json;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value))
    throw new DemoError('GATEWAY_IDENTIFIER_INVALID');
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new DemoError('GATEWAY_BINDING_INVALID');
  return value;
}

function binding(value: unknown) {
  const simulation = object(value);
  return {
    actionDigest: hash(simulation.actionDigest),
    simulationId: identifier(simulation.simulationId),
    policySnapshotId: identifier(simulation.policySnapshotId),
  };
}

function actionSummary(value: unknown): Json {
  const action = object(value);
  const result: Json = { runId: identifier(action.runId), state: identifier(action.state) };
  if (action.effectId !== undefined) result.effectId = identifier(action.effectId);
  if (action.simulation !== undefined) Object.assign(result, binding(action.simulation));
  return result;
}

const phaseOptions: Record<string, string[]> = {
  propose: ['operation-id', 'destination', 'head', 'base', 'title', 'body'],
  status: ['run-id', 'compensation', 'wait-seconds'],
  evidence: ['run-id'],
  approve: ['run-id', 'action-digest', 'simulation-id', 'policy-snapshot-id'],
  'verify-agent-boundary': ['run-id'],
  'request-close': ['run-id'],
  'approve-close': ['run-id', 'authorization-id', 'action-digest', 'policy-snapshot-id'],
};

const usage = `Usage: pnpm exec tsx scripts/github-action-demo.ts <phase> [options]

  propose --operation-id ID --destination github://OWNER/REPO/pulls --head BRANCH --base BRANCH --title TITLE --body BODY
  status --run-id ID [--compensation] [--wait-seconds 0..60]
  evidence --run-id ID
  approve --run-id ID --action-digest HASH --simulation-id ID --policy-snapshot-id ID
  verify-agent-boundary --run-id ID
  request-close --run-id ID
  approve-close --run-id ID --authorization-id ID --action-digest HASH --policy-snapshot-id ID

Required: COMMANDER_GITHUB_DEMO_GATEWAY_URL (HTTPS or localhost HTTP origin), COMMANDER_GITHUB_DEMO_TENANT_ID.
Agent phases: COMMANDER_GITHUB_DEMO_AGENT_TOKEN. Approval phases: COMMANDER_GITHUB_DEMO_APPROVER_TOKEN.
Run approvals in a separate human-controlled process using the exact bindings returned by the proposal or close request.
Reuse the operation ID for the same proposal. Each HTTP request has a 10 second deadline.
A real configured Gateway is required; this CLI does not configure GitHub credentials or create branches.
`;

export async function runGitHubActionDemo(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Json> {
  if (argv.length === 1 && argv[0] === '--help') return { usage };
  const [phase, ...args] = argv;
  if (!phase || !Object.hasOwn(phaseOptions, phase))
    throw new DemoError(
      'PHASE_REQUIRED: propose, status, evidence, approve, verify-agent-boundary, request-close, approve-close',
    );
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.slice(2) ?? '';
    if (!args[i]?.startsWith('--') || !phaseOptions[phase]!.includes(key) || options.has(key))
      throw new DemoError('INVALID_OPTION');
    if (key === 'compensation') options.set(key, 'true');
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('--'))
        throw new DemoError(`MISSING_OPTION: ${key}`);
      options.set(key, value);
    }
  }
  function required(key: string, allowEmpty = false): string {
    const value = options.get(key);
    if (value === undefined || (!allowEmpty && !value.trim()))
      throw new DemoError(`MISSING_OPTION: ${key}`);
    return value;
  }
  function configured(name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new DemoError(`MISSING_CONFIG: ${name}`);
    return value;
  }
  const base = configured('COMMANDER_GITHUB_DEMO_GATEWAY_URL');
  let gateway: URL;
  try {
    gateway = new URL(base);
  } catch {
    throw new DemoError('GATEWAY_URL_INVALID');
  }
  if (
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    gateway.pathname !== '/' ||
    (gateway.protocol !== 'https:' &&
      !(
        gateway.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname)
      ))
  )
    throw new DemoError('GATEWAY_URL_INVALID: HTTPS or localhost HTTP origin required');
  const tenant = configured('COMMANDER_GITHUB_DEMO_TENANT_ID');
  const approver = phase === 'approve' || phase === 'approve-close';
  const token = configured(
    approver ? 'COMMANDER_GITHUB_DEMO_APPROVER_TOKEN' : 'COMMANDER_GITHUB_DEMO_AGENT_TOKEN',
  );

  async function request(path: string, body?: Json, expectDenial = false): Promise<Json> {
    let response: Response;
    let json: Json;
    try {
      response = await fetch(new URL(path, gateway), {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          'x-tenant-id': tenant,
          ...(body
            ? {
                'Idempotency-Key': createHash('sha256')
                  .update(`${phase}:${path}:${JSON.stringify(body)}`)
                  .digest('hex'),
              }
            : {}),
          ...(phase === 'propose' && body
            ? { 'Idempotency-Key': String(body.idempotencyKey) }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new DemoError('GATEWAY_REDIRECT_REJECTED');
      }
      json = object(await response.json());
    } catch (error) {
      if (error instanceof DemoError) throw error;
      throw new DemoError(
        'GATEWAY_IO_FAILED: request failed or exceeded 10 second deadline; inspect status before replay',
      );
    }
    const error =
      json.error && typeof json.error === 'object' && !Array.isArray(json.error)
        ? object(json.error)
        : {};
    if (expectDenial) {
      if (response.status === 403 && error.code === 'ACTION_APPROVAL_FORBIDDEN')
        return { boundary: 'DENIED' };
      throw new DemoError(
        'AGENT_BOUNDARY_NOT_VERIFIED: stop and inspect the agent identity scopes',
      );
    }
    if (!response.ok) {
      const code =
        typeof error.code === 'string' &&
        /^[A-Z_]{1,80}$/.test(error.code) &&
        !error.code.includes(token)
          ? error.code
          : 'UNKNOWN';
      throw new DemoError(`GATEWAY_HTTP ${response.status} ${code}`);
    }
    return json;
  }

  if (phase === 'propose') {
    const operationId = required('operation-id');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(operationId)) throw new DemoError('INVALID_OPERATION_ID');
    const destination = required('destination');
    try {
      parseGitHubDestination(destination);
    } catch {
      throw new DemoError('INVALID_DESTINATION');
    }
    const head = required('head');
    const baseBranch = required('base');
    if (
      [head, baseBranch].some((branch) => branch.includes(':') || /\s/.test(branch)) ||
      head === baseBranch
    )
      throw new DemoError('INVALID_BRANCH: distinct same-repository head and base required');
    const title = required('title');
    const body = required('body', true);
    if (body.includes('commander-action:')) throw new DemoError('RESERVED_BODY_MARKER');
    const response = await request('/v1/actions', {
      source: 'github-action-demo',
      package: 'github-action-demo',
      model: 'none',
      tool: descriptor.toolName,
      destination,
      effectType: descriptor.effectType,
      args: { head, base: baseBranch, title, body },
      idempotencyKey: `github-demo:${operationId}`,
    });
    return actionSummary(response.action);
  }

  const runId = identifier(required('run-id'));
  const path = `/v1/actions/${encodeURIComponent(runId)}`;
  if (phase === 'evidence') {
    const response = await request(`${path}/evidence`);
    const receipt = object(response.receipt);
    if (object(response.verification).ok !== true || object(receipt.scope).runId !== runId)
      throw new DemoError('EVIDENCE_BINDING_MISMATCH');
    if (!Array.isArray(receipt.effects)) throw new DemoError('GATEWAY_RESPONSE_INVALID');
    const effects = receipt.effects.map((value: unknown) => {
      const effect = object(value);
      const summary = effect.responseSummary === undefined ? {} : object(effect.responseSummary);
      const safe: Json = { effectId: identifier(effect.effectId) };
      for (const key of ['status', 'errorCode']) {
        const value = summary[key];
        if (
          typeof value === 'string' &&
          /^[A-Za-z0-9._:-]{1,80}$/.test(value) &&
          !value.includes(token)
        )
          safe[key] = value;
      }
      if (
        Number.isInteger(summary.httpStatus) &&
        Number(summary.httpStatus) >= 100 &&
        Number(summary.httpStatus) <= 599
      )
        safe.httpStatus = summary.httpStatus;
      return safe;
    });
    return { runId, evidenceId: identifier(receipt.bundleId), effects };
  }
  if (phase === 'status') {
    const wait = Number(options.get('wait-seconds') ?? '0');
    if (!Number.isInteger(wait) || wait < 0 || wait > 60)
      throw new DemoError('INVALID_WAIT_SECONDS: use 0..60');
    const deadline = Date.now() + wait * 1_000;
    while (true) {
      const response = await request(
        options.has('compensation') ? `/v1/runs/${encodeURIComponent(runId)}/status` : path,
      );
      const summary = actionSummary(options.has('compensation') ? response : response.action);
      if (summary.runId !== runId) throw new DemoError('RUN_BINDING_MISMATCH');
      if (
        [
          'SUCCEEDED',
          'FAILED',
          'CANCELLED',
          'COMPENSATED',
          'AWAITING_APPROVAL',
          'COMPLETION_UNKNOWN',
          'ESCALATED',
        ].includes(String(summary.state)) ||
        wait === 0
      )
        return summary;
      if (Date.now() >= deadline)
        throw new DemoError('STATUS_WAIT_EXPIRED: inspect status before replay');
      await sleep(Math.min(1_000, deadline - Date.now()));
    }
  }
  if (phase === 'approve-close') {
    const authorizationId = identifier(required('authorization-id'));
    const response = await request(
      `${path}/compensations/${encodeURIComponent(authorizationId)}/approve`,
      {
        actionDigest: hash(required('action-digest')),
        policySnapshotId: identifier(required('policy-snapshot-id')),
      },
    );
    if (response.accepted !== true) throw new DemoError('COMPENSATION_NOT_ACCEPTED');
    const accepted = object(response.request);
    return {
      runId,
      authorizationId,
      requestId: identifier(accepted.id),
      compensationRunId: identifier(accepted.compensationRunId),
      compensationEffectId: identifier(accepted.compensationEffectId),
    };
  }
  const action = object((await request(path)).action);
  if (identifier(action.runId) !== runId) throw new DemoError('RUN_BINDING_MISMATCH');
  if (phase === 'request-close') {
    if (
      action.state !== 'SUCCEEDED' ||
      typeof action.forwardReceiptHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(action.forwardReceiptHash)
    )
      throw new DemoError('FORWARD_RECEIPT_UNAVAILABLE');
    const response = await request(`${path}/compensations`, {
      originalEffectId: identifier(action.effectId),
      adapterVersion: descriptor.adapterVersion,
      compensationEffectType: descriptor.compensationEffectType,
      compensationPatch: {},
      forwardReceiptHash: action.forwardReceiptHash,
    });
    if (response.state !== 'AWAITING_APPROVAL')
      throw new DemoError('COMPENSATION_APPROVAL_REQUIRED');
    const authorization = object(response.authorization);
    return {
      runId,
      state: 'AWAITING_APPROVAL',
      authorizationId: identifier(authorization.id),
      actionDigest: hash(authorization.actionDigest),
      policySnapshotId: identifier(authorization.policySnapshotId),
    };
  }
  if (action.state !== 'AWAITING_APPROVAL') throw new DemoError('ACTION_NOT_AWAITING_APPROVAL');
  const persisted = binding(action.simulation);
  if (phase === 'verify-agent-boundary')
    return { runId, ...(await request(`${path}/approve`, persisted, true)) };
  const supplied = {
    actionDigest: hash(required('action-digest')),
    simulationId: identifier(required('simulation-id')),
    policySnapshotId: identifier(required('policy-snapshot-id')),
  };
  if (
    supplied.actionDigest !== persisted.actionDigest ||
    supplied.simulationId !== persisted.simulationId ||
    supplied.policySnapshotId !== persisted.policySnapshotId
  )
    throw new DemoError('APPROVAL_BINDING_MISMATCH');
  const approved = actionSummary((await request(`${path}/approve`, supplied)).action);
  if (approved.runId !== runId) throw new DemoError('RUN_BINDING_MISMATCH');
  return approved;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  runGitHubActionDemo(process.argv.slice(2)).then(
    (result) =>
      process.stdout.write(
        typeof result.usage === 'string' ? result.usage : `${JSON.stringify(result, null, 2)}\n`,
      ),
    (error) => {
      process.stderr.write(
        `${error instanceof DemoError ? error.message : 'GITHUB_DEMO_FAILED'}\n`,
      );
      process.exitCode = 1;
    },
  );
}
