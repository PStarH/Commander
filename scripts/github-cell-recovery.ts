import { setTimeout as sleep } from 'node:timers/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR } from '../packages/contracts/src/actionAdapters.js';

const executeFile = promisify(execFile);

function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  requireProof(
    value && typeof value === 'object' && !Array.isArray(value),
    'PROOF_RESPONSE_INVALID',
  );
  return value as Record<string, unknown>;
}

export async function runDemoProcess(input: {
  role: 'agent' | 'approver';
  token: string;
  baseUrl: string;
  tenantId: string;
  args: string[];
}): Promise<Record<string, unknown>> {
  // An explicit environment keeps owner, GitHub and other-role secrets out of each child.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    COMMANDER_GITHUB_DEMO_GATEWAY_URL: input.baseUrl,
    COMMANDER_GITHUB_DEMO_TENANT_ID: input.tenantId,
    [input.role === 'agent'
      ? 'COMMANDER_GITHUB_DEMO_AGENT_TOKEN'
      : 'COMMANDER_GITHUB_DEMO_APPROVER_TOKEN']: input.token,
  };
  try {
    const result = await executeFile(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./github-action-demo.ts', import.meta.url)),
        ...input.args,
      ],
      { env, timeout: 75_000, maxBuffer: 1024 * 1024 },
    );
    return jsonObject(result.stdout);
  } catch (error) {
    // The CLI emits allowlisted errors; never print execFile's command/env error object.
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string' && /^GATEWAY_HTTP 503 OPERATIONS_NOT_READY\s*$/.test(stderr))
      throw new Error('OPERATIONS_NOT_READY');
    throw new Error('RECOVERY_CLI_FAILED');
  }
}

export interface EffectObservation {
  id: string;
  runId: string;
  idempotencyKey: string;
  requestHash: string;
  state: string;
  prNumber: number | null;
}

export interface ProviderObservation {
  createCalls: number;
  closeCalls: number;
  responseCutInjected: boolean;
  committedCreateStatus: number | null;
  pulls: Array<{ number: number; state: string }>;
}

export interface RecoveryDriver {
  cli(role: 'agent' | 'approver', args: string[]): Promise<Record<string, unknown>>;
  pauseRecovery(): Promise<void>;
  resumeRecovery(): Promise<void>;
  workerStartedAt(): Promise<string>;
  restartWorker(): Promise<void>;
  effect(runId: string): Promise<EffectObservation | null>;
  provider(): Promise<ProviderObservation>;
}

function requireProof(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  requireProof(typeof value === 'string' && value.length > 0, 'PROOF_FIELD_MISSING');
  return value;
}

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  code: string,
): Promise<T> {
  const deadline = Date.now() + 90_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error(code);
}

export async function runRecoveryScenario(
  driver: RecoveryDriver,
  operationId: string,
): Promise<Record<string, unknown>> {
  const proposal = [
    'propose',
    '--operation-id',
    operationId,
    '--destination',
    'github://octo/repo/pulls',
    '--head',
    'cell-recovery',
    '--base',
    'main',
    '--title',
    'Cell GitHub recovery',
    '--body',
    'Approved response-loss recovery proof',
  ];
  const action = await driver.cli('agent', proposal);
  requireProof(action.state === 'AWAITING_APPROVAL', 'APPROVAL_WAS_BYPASSED');
  const runId = field(action, 'runId');
  const effectId = field(action, 'effectId');
  const denied = await driver.cli('agent', ['verify-agent-boundary', '--run-id', runId]);
  requireProof(denied.boundary === 'DENIED', 'AGENT_APPROVAL_BOUNDARY_FAILED');
  const beforeApproval = await driver.provider();
  requireProof(
    beforeApproval.createCalls === 0 && beforeApproval.closeCalls === 0,
    'REMOTE_WRITE_COUNT_INVALID',
  );
  let paused = false;
  try {
    await driver.pauseRecovery();
    paused = true;
    await driver.cli('approver', [
      'approve',
      '--run-id',
      runId,
      '--action-digest',
      field(action, 'actionDigest'),
      '--simulation-id',
      field(action, 'simulationId'),
      '--policy-snapshot-id',
      field(action, 'policySnapshotId'),
    ]);
    const unknown = await until(
      () => driver.effect(runId),
      (row) => row?.state === 'COMPLETION_UNKNOWN',
      'PERSISTED_UNKNOWN_NOT_OBSERVED',
    );
    requireProof(
      unknown &&
        unknown.id === effectId &&
        unknown.runId === runId &&
        unknown.idempotencyKey &&
        /^[a-f0-9]{64}$/.test(unknown.requestHash),
      'PERSISTED_IDENTITY_INVALID',
    );
    const remote = await driver.provider();
    requireProof(
      remote.responseCutInjected && remote.committedCreateStatus === 201,
      'REMOTE_CUT_NOT_PROVEN',
    );
    requireProof(
      remote.createCalls === 1 && remote.closeCalls === 0 && remote.pulls.length === 1,
      'REMOTE_WRITE_COUNT_INVALID',
    );
    const workerBefore = await driver.workerStartedAt();
    await driver.restartWorker();
    const workerAfter = await driver.workerStartedAt();
    requireProof(
      Number.isFinite(Date.parse(workerBefore)) &&
        Number.isFinite(Date.parse(workerAfter)) &&
        Date.parse(workerAfter) > Date.parse(workerBefore),
      'WORKER_RESTART_NOT_PROVEN',
    );
    const retained = await driver.effect(runId);
    requireProof(
      retained?.state === 'COMPLETION_UNKNOWN' &&
        retained.id === unknown.id &&
        retained.idempotencyKey === unknown.idempotencyKey &&
        retained.requestHash === unknown.requestHash,
      'RESTART_LOST_PERSISTED_OPERATION',
    );
    await driver.resumeRecovery();
    paused = false;
    const recovered = await until(
      () => driver.effect(runId),
      (row) => row?.state === 'COMPLETED',
      'RECOVERY_NOT_COMPLETED',
    );
    requireProof(
      recovered &&
        recovered.id === effectId &&
        recovered.runId === runId &&
        recovered.idempotencyKey === unknown.idempotencyKey &&
        recovered.requestHash === unknown.requestHash,
      'RECOVERED_IDENTITY_CHANGED',
    );
    requireProof(recovered.prNumber === remote.pulls[0]?.number, 'RECOVERED_RECEIPT_MISMATCH');
    await until(
      () => driver.cli('agent', ['status', '--run-id', runId]),
      (status) => status.state === 'SUCCEEDED',
      'RECOVERED_RUN_NOT_SUCCEEDED',
    );
    const replay = await driver.cli('agent', proposal);
    requireProof(
      replay.runId === runId && replay.effectId === effectId,
      'REPLAY_CREATED_NEW_OPERATION',
    );
    const afterReplay = await driver.provider();
    requireProof(
      afterReplay.createCalls === 1 &&
        afterReplay.closeCalls === 0 &&
        afterReplay.pulls.length === 1,
      'REMOTE_WRITE_COUNT_INVALID',
    );
    const evidence = await driver.cli('agent', ['evidence', '--run-id', runId]);
    requireProof(
      evidence.runId === runId &&
        Array.isArray(evidence.effects) &&
        evidence.effects.some(
          (effect: unknown) =>
            effect !== null &&
            typeof effect === 'object' &&
            'effectId' in effect &&
            effect.effectId === effectId,
        ),
      'EVIDENCE_EFFECT_MISMATCH',
    );
    const evidenceId = field(evidence, 'evidenceId');
    const authorization = await driver.cli('agent', ['request-close', '--run-id', runId]);
    requireProof(authorization.state === 'AWAITING_APPROVAL', 'CLOSE_APPROVAL_WAS_BYPASSED');
    const beforeCloseApproval = await driver.provider();
    requireProof(
      beforeCloseApproval.closeCalls === 0 && beforeCloseApproval.pulls[0]?.state === 'open',
      'CLOSE_OCCURRED_BEFORE_APPROVAL',
    );
    const close = await driver.cli('approver', [
      'approve-close',
      '--run-id',
      runId,
      '--authorization-id',
      field(authorization, 'authorizationId'),
      '--action-digest',
      field(authorization, 'actionDigest'),
      '--policy-snapshot-id',
      field(authorization, 'policySnapshotId'),
    ]);
    const compensationRunId = field(close, 'compensationRunId');
    await until(
      () => driver.cli('agent', ['status', '--run-id', compensationRunId, '--compensation']),
      (status) => status.state === 'SUCCEEDED',
      'CLOSE_NOT_COMPLETED',
    );
    const final = await driver.provider();
    requireProof(
      final.createCalls === 1 &&
        final.closeCalls === 1 &&
        final.pulls.length === 1 &&
        final.pulls[0]?.number === recovered.prNumber &&
        final.pulls[0]?.state === 'closed',
      'REMOTE_WRITE_COUNT_INVALID',
    );
    return {
      runId,
      effectId,
      operationId,
      idempotencyKey: recovered.idempotencyKey,
      requestHash: recovered.requestHash,
      prNumber: recovered.prNumber,
      workerBefore,
      workerAfter,
      agentApprovalDenied: true,
      persistedStateBeforeRestart: unknown.state,
      stateAfterRecovery: recovered.state,
      responseCutInjected: remote.responseCutInjected,
      committedCreateStatus: remote.committedCreateStatus,
      evidenceId,
      compensationRunId,
      createCalls: final.createCalls,
      closeCalls: final.closeCalls,
    };
  } finally {
    if (paused) await driver.resumeRecovery();
  }
}

async function runComposeRecovery(): Promise<Record<string, unknown>> {
  const {
    fixtureCompose,
    prepareCompensationFixture,
    seedCompensationFixturePolicy,
    COMPENSATION_COMPOSE_CMD,
  } = await import('./cell-compensation-fixture.js');
  const { tryComposeCellUp, assertComposeCellHealth, CELL_E2E_TENANT } =
    await import('./l4-b-cell-compose.js');
  const fixtureEnv = { ...prepareCompensationFixture(), CELL_GITHUB_CUT_CREATE_RESPONSE: '1' };
  const up = tryComposeCellUp(COMPENSATION_COMPOSE_CMD, fixtureEnv);
  requireProof(up.ok, 'RECOVERY_CELL_START_FAILED');
  requireProof(
    Object.values(await assertComposeCellHealth()).every(Boolean),
    'RECOVERY_CELL_UNHEALTHY',
  );
  seedCompensationFixturePolicy(fixtureEnv);
  const keys = {
    agent: `cmdr_${randomBytes(32).toString('base64url')}`,
    approver: `cmdr_${randomBytes(32).toString('base64url')}`,
  };
  function query(sql: string, variables: Record<string, string> = {}): string {
    return fixtureCompose(
      fixtureEnv,
      [
        'exec',
        '-T',
        'postgres',
        'psql',
        '--username',
        'commander_owner',
        '--dbname',
        'commander',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--set',
        `tenant=${CELL_E2E_TENANT}`,
        ...Object.entries(variables).flatMap(([key, value]) => ['--set', `${key}=${value}`]),
      ],
      sql,
    ).trim();
  }
  for (const role of ['agent', 'approver'] as const) {
    query(
      `INSERT INTO commander_auth_api_keys (id,name,prefix,key_hash,scopes,tenant_id)
      VALUES (:'id', :'name', :'prefix', :'hash', ${role === 'agent' ? "ARRAY['read','write']" : "ARRAY['read','write','actions:approve']"}::text[], :'tenant');`,
      {
        id: `ak_recovery_${randomUUID()}`,
        name: `cell-recovery-${role}`,
        prefix: keys[role].slice(0, 8),
        hash: createHash('sha256').update(keys[role]).digest('hex'),
      },
    );
  }
  const compose = (args: string[]) => fixtureCompose(fixtureEnv, args).trim();
  const startedAt = (service: string) => {
    const id = compose(['ps', '--all', '--quiet', service]);
    requireProof(/^[a-f0-9]{12,64}$/.test(id), 'RECOVERY_CONTAINER_NOT_FOUND');
    return execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', id], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  };
  const databaseStartedAt = startedAt('postgres');
  const driver: RecoveryDriver = {
    cli: (role, args) =>
      runDemoProcess({
        role,
        token: keys[role],
        baseUrl: 'http://localhost:4000',
        tenantId: CELL_E2E_TENANT,
        args,
      }),
    async pauseRecovery() {
      compose(['pause', 'adapter-ops']);
    },
    async resumeRecovery() {
      compose(['unpause', 'adapter-ops']);
    },
    async workerStartedAt() {
      return startedAt('worker');
    },
    async restartWorker() {
      compose(['kill', '--signal', 'SIGKILL', 'worker']);
      compose(['start', 'worker']);
      await until(
        async () => {
          const response = compose([
            'exec',
            '-T',
            'worker',
            'node',
            '-e',
            "fetch('http://127.0.0.1:8083/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('unavailable'))",
          ]);
          return response === '200';
        },
        Boolean,
        'RESTARTED_WORKER_NOT_READY',
      );
    },
    async effect(runId) {
      const rows: unknown = JSON.parse(
        query(
          `SELECT COALESCE(json_agg(json_build_object(
        'id',id,'runId',run_id,'idempotencyKey',idempotency_key,'requestHash',request_hash,
        'state',state,'prNumber',response->'prNumber')), '[]'::json)
        FROM commander_effects WHERE tenant_id=:'tenant' AND run_id=:'run_id';`,
          { run_id: runId },
        ),
      );
      requireProof(Array.isArray(rows) && rows.length <= 1, 'PERSISTED_EFFECT_COUNT_INVALID');
      if (rows.length === 0) return null;
      const row = jsonObject(JSON.stringify(rows[0]));
      requireProof(
        row.prNumber === null ||
          (typeof row.prNumber === 'number' &&
            Number.isSafeInteger(row.prNumber) &&
            row.prNumber > 0),
        'PERSISTED_RECEIPT_INVALID',
      );
      return {
        id: field(row, 'id'),
        runId: field(row, 'runId'),
        idempotencyKey: field(row, 'idempotencyKey'),
        requestHash: field(row, 'requestHash'),
        state: field(row, 'state'),
        prNumber: row.prNumber,
      };
    },
    async provider() {
      // The recovery worker cannot read this oracle; only the test controller does.
      const script = `fetch('https://api.github.com/__cell__/state', {headers:{Authorization:'Bearer '+process.env.CELL_GITHUB_ORACLE_TOKEN},signal:AbortSignal.timeout(5000)}).then(async r=>{
        if(!r.ok) throw new Error('ORACLE_UNAVAILABLE'); const s=await r.json();
        process.stdout.write(JSON.stringify({createCalls:s.createCalls,closeCalls:s.closeCalls,responseCutInjected:s.responseCutInjected,committedCreateStatus:s.committedCreateStatus,pulls:s.pulls.map(p=>({number:p.number,state:p.state}))}));
      }).catch(()=>process.exit(1));`;
      const state = jsonObject(compose(['exec', '-T', 'github-fixture', 'node', '-e', script]));
      requireProof(
        typeof state.createCalls === 'number' &&
          typeof state.closeCalls === 'number' &&
          typeof state.responseCutInjected === 'boolean' &&
          (state.committedCreateStatus === null ||
            typeof state.committedCreateStatus === 'number') &&
          Array.isArray(state.pulls),
        'PROVIDER_ORACLE_INVALID',
      );
      const pulls = state.pulls.map((value: unknown) => {
        const pull = jsonObject(JSON.stringify(value));
        requireProof(
          typeof pull.number === 'number' && Number.isSafeInteger(pull.number) && pull.number > 0,
          'PROVIDER_ORACLE_INVALID',
        );
        return { number: pull.number, state: field(pull, 'state') };
      });
      return {
        createCalls: state.createCalls,
        closeCalls: state.closeCalls,
        responseCutInjected: state.responseCutInjected,
        committedCreateStatus: state.committedCreateStatus,
        pulls,
      };
    },
  };
  // Only registration readiness is retryable before a proposal is accepted.
  const cli = driver.cli;
  driver.cli = async (role, args) => {
    if (args[0] !== 'propose') return cli(role, args);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await cli(role, args);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'OPERATIONS_NOT_READY' || attempt >= 11)
          throw error;
        await sleep(5_000);
      }
    }
  };
  const result = await runRecoveryScenario(driver, `cell-recovery-${randomUUID()}`);
  requireProof(startedAt('postgres') === databaseStartedAt, 'DATABASE_RESTARTED_DURING_PROOF');
  return { ...result, databaseStartedAt };
}

async function main(): Promise<void> {
  requireProof(process.argv.slice(2).join(' ') === '--up', 'EXPLICIT_DISPOSABLE_CELL_UP_REQUIRED');
  const started = Date.now();
  const artifact: Record<string, unknown> = {
    schema: 'commander.github-cell-recovery/v1',
    sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty:
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    adapterVersion: GITHUB_PULL_REQUEST_CREATE_DESCRIPTOR.adapterVersion,
    provider: 'synthetic-github-https',
    gateway: 'real-cell',
    database: 'postgres',
    model: 'none',
    passed: false,
  };
  try {
    artifact.result = await runComposeRecovery();
    artifact.passed = true;
  } catch (error) {
    artifact.error =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'RECOVERY_PROOF_FAILED';
    process.exitCode = 1;
  } finally {
    artifact.elapsedMs = Date.now() - started;
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/github-cell-recovery.json',
      JSON.stringify(artifact, null, 2) + '\n',
    );
    console.log(JSON.stringify(artifact));
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch(() => {
    console.error('RECOVERY_PROOF_FAILED');
    process.exitCode = 1;
  });
}
