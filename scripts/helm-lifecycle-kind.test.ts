import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as lifecycleHarness from './helm-lifecycle-kind.js';
import {
  aggregateScenarioPass,
  aggregateScenarioChecks,
  assertHelmVersion,
  assertNegativeCanaryResult,
  assertProofPodContract,
  buildExternalPostgresResources,
  buildLifecycleValues,
  calicoImagesForArchitecture,
  kindNodeImageForArchitecture,
  leafCertificateExtensions,
  nodeInventoriesContainExactReference,
  namespaceCleanupArgs,
  postgresImageForArchitecture,
  productionImageReferences,
  productionImageBuildArguments,
  reusableProductionImageDigest,
  controlPlaneReadinessSelectors,
  proofReaderName,
  selectLifecycleScenarios,
  sanitizeEvidence,
  kindClusterExists,
  proofTemplatesPresent,
  parseOwnerFailureEvidence,
  classifyRolloutObservation,
  classifyRolloutFailureJson,
  retainRolloutObservation,
  retainRolloutFailureEvidence,
  productionImageSourceRevision,
  KIND_NODE_IMAGE,
  CALICO_URL,
} from './helm-lifecycle-kind.js';

describe('helm-lifecycle-kind helpers', () => {
  it('selects an API pod with a startup failure before a lexically earlier healthy pod', () => {
    const selectPod = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectFailingApiPodName?: (items: unknown[]) => string | undefined;
      }
    ).selectFailingApiPodName;
    assert.equal(typeof selectPod, 'function');

    assert.equal(
      selectPod!([
        {
          metadata: { name: 'api-healthy-a' },
          status: {
            containerStatuses: [{ state: { running: {} }, lastState: {} }],
          },
        },
        {
          metadata: { name: 'api-crashing-z' },
          status: {
            containerStatuses: [
              { state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: {} },
            ],
          },
        },
      ]),
      'api-crashing-z',
    );
  });

  it('retains only an allowlisted API startup code and hash from pod logs', () => {
    const diagnostic = (
      lifecycleHarness as typeof lifecycleHarness & {
        apiPodStartupFailureDiagnostic?: (
          logs: string,
          transport?: 'kubectl_logs' | 'kubectl_logs_unavailable',
        ) => string;
      }
    ).apiPodStartupFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const logs = [
      'Error: TASK1_READINESS_CERT_FILE_OWNER_INVALID',
      'postgres://api:secret@database/commander',
      'opaque-api-startup-marker-3281',
    ].join('\n');
    const result = diagnostic!(logs);

    assert.match(
      result,
      /^code=TASK1_READINESS_CERT_FILE_OWNER_INVALID;producer=api_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /secret|opaque-api-startup-marker-3281/);
    assert.match(
      diagnostic!('opaque-api-startup-marker-9142'),
      /^code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;producer=api_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );
    assert.match(
      diagnostic!('Error [ERR_MODULE_NOT_FOUND]: Cannot find package'),
      /^code=COMMANDER_API_RUNTIME_MODULE_NOT_FOUND;producer=api_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );
    assert.match(
      diagnostic!('Error: DATABASE_URL_REQUIRED'),
      /^code=DATABASE_URL_REQUIRED;producer=api_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );
    assert.match(
      diagnostic!('COMMANDER_API_STARTUP_FAILED: opaque startup detail'),
      /^code=COMMANDER_API_STARTUP_FAILED;producer=api_entrypoint;transport=kubectl_logs;log_sha256=[a-f0-9]{64}$/,
    );

    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:' +
            result +
            '\npostgres://api:secret@database/commander opaque-api-startup-marker-3281',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0]?.apiStartupFailure, {
      code: 'TASK1_READINESS_CERT_FILE_OWNER_INVALID',
      producer: 'api_entrypoint',
      transport: 'kubectl_logs',
      logSha256: result.match(/log_sha256=([a-f0-9]{64})$/)?.[1],
    });
    assert.equal(JSON.stringify(sanitized).includes('opaque-api-startup-marker-3281'), false);
  });

  it('retains only allowlisted API container termination facts', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;' +
            'producer=api_entrypoint;transport=kubectl_logs;termination_reason=Error;exit_code=1;' +
            'log_sha256=' +
            'a'.repeat(64) +
            ';message=postgres://api:secret@database/commander',
        },
        {
          name: 'fresh-external',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;' +
            'producer=api_entrypoint;transport=kubectl_logs;termination_reason=Error;exit_code=999;' +
            'log_sha256=' +
            'b'.repeat(64),
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.apiStartupFailure, {
      code: 'TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED',
      producer: 'api_entrypoint',
      transport: 'kubectl_logs',
      terminationReason: 'Error',
      exitCode: 1,
      logSha256: 'a'.repeat(64),
    });
    assert.equal(JSON.stringify(sanitized).includes('postgres://'), false);
    assert.equal(sanitized.scenarios[1]?.apiStartupFailure, undefined);
  });

  it('extracts only an allowlisted terminated API container state', () => {
    const facts = (
      lifecycleHarness as typeof lifecycleHarness & {
        apiPodTerminationFacts?: (status: unknown) => unknown;
      }
    ).apiPodTerminationFacts;
    assert.equal(typeof facts, 'function');

    assert.deepEqual(
      facts!({
        containerStatuses: [
          {
            name: 'api',
            lastState: {
              terminated: {
                reason: 'Error',
                exitCode: 1,
                message: 'postgres://api:secret@database/commander',
              },
            },
          },
        ],
      }),
      { terminationReason: 'Error', exitCode: 1 },
    );
    assert.equal(
      facts!({
        containerStatuses: [
          { name: 'api', lastState: { terminated: { reason: 'SecretValue', exitCode: 1 } } },
        ],
      }),
      undefined,
    );
  });

  it('uses current API logs when the previous container has no classified startup failure', () => {
    const selectLogs = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectApiPodStartupLogs?: (previousLogs: string, currentLogs: string) => string;
      }
    ).selectApiPodStartupLogs;
    assert.equal(typeof selectLogs, 'function');

    assert.equal(
      selectLogs!('opaque previous output', 'COMMANDER_API_STARTUP_FAILED: database unavailable'),
      'COMMANDER_API_STARTUP_FAILED: database unavailable',
    );
    assert.equal(
      selectLogs!('DATABASE_URL_REQUIRED', 'COMMANDER_API_STARTUP_FAILED: database unavailable'),
      'DATABASE_URL_REQUIRED',
    );
  });

  it('classifies finite rollout query, output-limit, empty, and nonterminal outcomes', () => {
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 1,
        stdout: '',
        stderr: 'private query failure',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 1,
        stdout: '',
        stderr: 'private oversized output',
        errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stdout: 'x'.repeat(1024 * 1024 + 1),
        stderr: '',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: {
                labels: { 'app.kubernetes.io/component': 'worker' },
                annotations: { ignored: 'x'.repeat(128 * 1024) },
              },
              status: { conditions: [{ type: 'Ready', status: 'False' }] },
            },
          ],
        }),
      }),
      {
        kind: 'success',
        evidence: {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stdout: JSON.stringify({ items: [] }),
        stderr: '',
      }),
      { kind: 'success', evidence: { code: 'TENANT_CUTOVER_ROLLOUT_EMPTY' } },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
              status: { conditions: [{ type: 'Ready', status: 'False', message: 'private' }] },
            },
          ],
        }),
      }),
      {
        kind: 'success',
        evidence: {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      },
    );
  });

  it('selects terminal then pod, job, deployment and fixed component tie-breaks', () => {
    const observation = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { conditions: [{ type: 'Available', status: 'False' }] },
          },
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: { active: 1 },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
            status: { conditions: [{ type: 'Ready', status: 'False' }] },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    });
    assert.deepEqual(observation, {
      kind: 'terminal',
      evidence: {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Pod',
        component: 'api',
        reasonCode: 'POD_CRASH_LOOP_BACKOFF',
      },
    });
  });

  it('maps every nonterminal resource kind to its fixed reason code', () => {
    for (const [item, expected] of [
      [
        {
          kind: 'Deployment',
          metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
          status: { conditions: [{ type: 'Available', status: 'False', message: 'private' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Deployment',
          component: 'api',
          reasonCode: 'DEPLOYMENT_UNAVAILABLE',
        },
      ],
      [
        {
          kind: 'Job',
          metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
          status: { active: 1 },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Job',
          component: 'migration',
          reasonCode: 'JOB_ACTIVE',
        },
      ],
      [
        {
          kind: 'Pod',
          metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
          status: { conditions: [{ type: 'Ready', status: 'False', message: 'private' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      ],
    ] as const) {
      assert.deepEqual(
        classifyRolloutObservation({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ items: [item] }),
        }),
        { kind: 'success', evidence: expected },
      );
    }
  });

  it('retains terminal evidence but replaces nonterminal state on successful healthy and empty polls', () => {
    const unready = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: { active: 1 },
          },
        ],
      }),
    });
    const healthy = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { conditions: [{ type: 'Available', status: 'True' }] },
          },
        ],
      }),
    });
    const disappeared = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({ items: [] }),
    });
    const terminal = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: {
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
        ],
      }),
    });

    const earlyUnready = retainRolloutObservation(undefined, unready);
    assert.deepEqual(earlyUnready, {
      nonterminal: {
        code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_ACTIVE',
      },
    });
    assert.deepEqual(retainRolloutObservation(earlyUnready, healthy), {});
    assert.deepEqual(retainRolloutObservation(earlyUnready, disappeared), {
      nonterminal: { code: 'TENANT_CUTOVER_ROLLOUT_EMPTY' },
    });
    const terminalState = retainRolloutObservation(earlyUnready, terminal);
    assert.deepEqual(retainRolloutObservation(terminalState, disappeared), terminalState);
  });

  it('sanitizes finite rollout observation records and rejects malicious extra fields', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_ROLLOUT_NONTERMINAL:resource_kind=Job;component=migration;reason_code=JOB_ACTIVE\nsecret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: ['HELM_TENANT_CUTOVER_FAILED', 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL'],
      rolloutObservation: {
        code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_ACTIVE',
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /private|secret/i);

    const malformed = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_ROLLOUT_NONTERMINAL:resource_kind=Job;component=migration;reason_code=JOB_ACTIVE;secret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.equal(malformed.scenarios[0]?.rolloutObservation, undefined);
  });

  it('classifies exact controller rollout failures without retaining object data', () => {
    for (const [item, expected] of [
      [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: 'tenant-secret-deployment',
            namespace: 'tenant-secret-namespace',
            uid: 'sensitive-uid',
            labels: { 'app.kubernetes.io/component': 'api' },
          },
          status: {
            conditions: [
              {
                type: 'Progressing',
                status: 'False',
                reason: 'ProgressDeadlineExceeded',
                message: 'private probe endpoint failed',
              },
            ],
          },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Deployment',
          component: 'api',
          reasonCode: 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED',
        },
      ],
      [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: 'tenant-migration-secret',
            labels: { 'app.kubernetes.io/component': 'migration' },
          },
          status: { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Job',
          component: 'migration',
          reasonCode: 'JOB_DEADLINE_EXCEEDED',
        },
      ],
      [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: 'tenant-proof-secret',
            labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
          },
          status: {
            conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
          },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Job',
          component: 'tenant-cutover-proof',
          reasonCode: 'JOB_BACKOFF_LIMIT_EXCEEDED',
        },
      ],
    ] as const) {
      const classified = classifyRolloutFailureJson(
        JSON.stringify({ kind: 'List', items: [item] }),
      );
      assert.deepEqual(classified, expected);
      assert.doesNotMatch(
        JSON.stringify(classified),
        /tenant-secret|tenant-secret-namespace|sensitive-uid|private probe/i,
      );
    }
  });

  it('classifies exact pod rollout failures without container detail', () => {
    for (const [status, expectedReason] of [
      [
        { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] },
        'POD_UNSCHEDULABLE',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] },
        'POD_IMAGE_PULL_FAILED',
      ],
      [
        {
          initContainerStatuses: [{ state: { waiting: { reason: 'CreateContainerConfigError' } } }],
        },
        'POD_CONTAINER_CONFIG_ERROR',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'RunContainerError' } } }] },
        'POD_CONTAINER_START_FAILED',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
        'POD_CRASH_LOOP_BACKOFF',
      ],
      [
        {
          containerStatuses: [
            {
              lastState: { terminated: { reason: 'OOMKilled' } },
              state: { waiting: { reason: 'CrashLoopBackOff' } },
            },
          ],
        },
        'POD_OOM_KILLED',
      ],
    ] as const) {
      assert.deepEqual(
        classifyRolloutFailureJson(
          JSON.stringify({
            kind: 'List',
            items: [
              {
                kind: 'Pod',
                metadata: {
                  name: 'tenant-pod-secret',
                  labels: { 'app.kubernetes.io/component': 'worker' },
                },
                status: { ...status, message: 'secret SQL detail' },
              },
            ],
          }),
        ),
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: expectedReason,
        },
      );
    }
  });

  it('maps migration and proof Pods from fixed labels rather than names', () => {
    const migration = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Pod',
            metadata: {
              name: 'sensitive-randomized-name',
              labels: { 'commander.io/migration-client-v2': 'true' },
            },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    const proof = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Pod',
            metadata: {
              name: 'sensitive-proof-name',
              labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
            },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    assert.equal(migration?.component, 'migration');
    assert.equal(proof?.component, 'tenant-cutover-proof');
  });

  it('rejects malformed, unknown, and oversized rollout observations', () => {
    assert.equal(classifyRolloutFailureJson('not-json'), undefined);
    assert.equal(
      classifyRolloutFailureJson(
        JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: { labels: { 'app.kubernetes.io/component': 'unknown' } },
              status: { containerStatuses: [{ state: { waiting: { reason: 'PrivateReason' } } }] },
            },
          ],
        }),
      ),
      undefined,
    );
    assert.equal(
      classifyRolloutFailureJson(JSON.stringify({ items: Array.from({ length: 65 }) })),
      undefined,
    );
    assert.equal(classifyRolloutFailureJson('x'.repeat(65 * 1024)), undefined);
  });

  it('selects one deterministic highest-priority rollout failure', () => {
    const classified = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: {
              conditions: [
                { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
              ],
            },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    assert.deepEqual(classified, {
      code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
      resourceKind: 'Pod',
      component: 'worker',
      reasonCode: 'POD_CRASH_LOOP_BACKOFF',
    });
  });

  it('retains observed evidence when a later atomic rollback observation is empty', () => {
    const observed = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: {
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
        ],
      }),
    );
    assert.deepEqual(retainRolloutFailureEvidence(observed, undefined), observed);
  });

  it('sanitizes a valid rollout record and excludes hostile raw content', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/tenant-secret/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [{ message: 'private event' }],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=Job;component=migration;reason_code=JOB_DEADLINE_EXCEEDED\nname=tenant-secret;message=private SQL SELECT;stderr=secret',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: [
        'HELM_TENANT_CUTOVER_FAILED',
        'TENANT_CUTOVER_HELM_COMMAND_FAILED',
        'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
      ],
      rolloutFailure: {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_DEADLINE_EXCEEDED',
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /tenant-secret|private|SELECT|stderr|secret/i);
  });

  it('rejects malformed rollout records and preserves existing Helm failure codes', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED:TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=Pod;component=api;reason_code=POD_CRASH_LOOP_BACKOFF;name=tenant-secret',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
      'TENANT_CUTOVER_HELM_COMMAND_FAILED',
      'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED',
      'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
    ]);
    assert.equal(sanitized.scenarios[0]?.rolloutFailure, undefined);
  });

  it('retains only a parsed allowlisted owner failure record and source revision', () => {
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=owner_pool_connect;log_sha256=' +
          'a'.repeat(64),
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'owner_pool_connect',
        logSha256: 'a'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=TASK1_CLOSURE_BASELINE_REQUIRED;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          '9'.repeat(64) +
          '\nNAME READY STATUS secret raw detail',
      ),
      {
        code: 'TASK1_CLOSURE_BASELINE_REQUIRED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        logSha256: '9'.repeat(64),
      },
    );
    for (const ownerStage of [
      'lifecycle_pinned_manifest_validation',
      'lifecycle_prepared_request_validation',
      'lifecycle_table_discovery',
      'lifecycle_initialization_planning',
      'lifecycle_descriptor_transaction',
      'lifecycle_peer_reobservation',
      'lifecycle_peer_reobservation_input_consistency',
      'lifecycle_peer_reobservation_candidate_binding_validation',
      'lifecycle_peer_reobservation_observed_binding_validation',
      'lifecycle_peer_reobservation_binding_consistency',
    ] as const) {
      assert.deepEqual(
        parseOwnerFailureEvidence(
          'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=' +
            ownerStage +
            ';log_sha256=' +
            'f'.repeat(64),
        ),
        {
          code: 'COMMANDER_MIGRATION_FAILED',
          producer: 'owner_entrypoint',
          transport: 'kubectl_logs',
          ownerStage,
          logSha256: 'f'.repeat(64),
        },
      );
    }
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=origin_classification;origin_classification_step=role_envelope;log_sha256=' +
          'e'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotValidation: 'origin_classification',
        originClassificationStep: 'role_envelope',
        logSha256: 'e'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=identity_validation;log_sha256=' +
          'd'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotValidation: 'identity_validation',
        logSha256: 'd'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_transaction=begin;log_sha256=' +
          'c'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotTransaction: 'begin',
        logSha256: 'c'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;catalog_step=functions;log_sha256=' +
          'b'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        catalogStep: 'functions',
        logSha256: 'b'.repeat(64),
      },
    );
    assert.equal(
      productionImageSourceRevision({ GITHUB_SHA: 'b'.repeat(40) }, () => 'c'.repeat(40)),
      'b'.repeat(40),
    );
    assert.equal(
      productionImageSourceRevision({}, () => 'c'.repeat(40)),
      'c'.repeat(40),
    );
    assert.equal(
      parseOwnerFailureEvidence(
        'code=PRIVATE_SECRET_VALUE;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          'f'.repeat(64),
      ),
      undefined,
    );
    assert.equal(parseOwnerFailureEvidence('postgres://owner:secret@db private detail'), undefined);
  });

  it('pins Kubernetes 1.33.2 and the expected digest', () => {
    assert.match(KIND_NODE_IMAGE, /kindest\/node:v1\.33\.2/);
    assert.match(KIND_NODE_IMAGE, /sha256:[a-f0-9]{64}/);
  });

  it('selects immutable Kind node manifests for both supported CI architectures', () => {
    assert.equal(
      kindNodeImageForArchitecture('x64'),
      'kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121',
    );
    assert.equal(
      kindNodeImageForArchitecture('arm64'),
      'kindest/node:v1.33.2@sha256:2206121406df04dd321ea04919c7a1a3c3b12220770b4a62dc5e57e2cfab4dad',
    );
    assert.throws(() => kindNodeImageForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('selects immutable Calico and PostgreSQL manifests for both supported architectures', () => {
    assert.deepEqual(calicoImagesForArchitecture('arm64'), [
      'docker.io/calico/cni:v3.29.0@sha256:173ea2834c655eeee3aa9c3491c7ef6d75a2de1e622e127f524f02a4e1918f17',
      'docker.io/calico/node:v3.29.0@sha256:f74ff658399ab2c7deb7cb28f2eccccd303d22bfd674b32547a8e6d83a44ac7c',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:38d28083aad4783556c4172df0cfcca30e31b1a323017bb74988ea95ca391c14',
    ]);
    assert.deepEqual(calicoImagesForArchitecture('x64'), [
      'docker.io/calico/cni:v3.29.0@sha256:10643eba882c49d2558ee1f047ab4b42283c4b3e9e0864e4007e46c9faf5d50e',
      'docker.io/calico/node:v3.29.0@sha256:ec9fc719f8b51397fff195d60c7d12d4149fa08c3167a6485e7691119560451f',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:10a8342ee971aeb53cfe94599f1ba7048ff815e43689014cd436cc46d4d7d1e0',
    ]);
    assert.equal(
      postgresImageForArchitecture('arm64'),
      'docker.io/library/postgres:16-alpine@sha256:7ae1143a9f249af815f056751a122a86d7e44ddce0926f2b227e3d5c434444f4',
    );
    assert.throws(() => calicoImagesForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('uses ECDSA-compatible key usage for live fixture leaf certificates', () => {
    const extensions = leafCertificateExtensions(['postgres.default.svc']);
    assert.match(extensions, /keyUsage=critical,digitalSignature\n/);
    assert.doesNotMatch(extensions, /keyEncipherment/);
  });

  it('bounds namespace cleanup and requires every control-plane component after image imports', () => {
    assert.deepEqual(namespaceCleanupArgs('commander-lifecycle'), [
      'delete',
      'namespace',
      'commander-lifecycle',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]);
    assert.deepEqual(controlPlaneReadinessSelectors(), [
      'component=etcd',
      'component=kube-apiserver',
      'component=kube-controller-manager',
      'component=kube-scheduler',
    ]);
  });

  it('requires the exact supported Helm runtime', () => {
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3+ge4da497'));
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3'));
    assert.throws(() => assertHelmVersion('v3.17.3-rc.1'), /HELM_VERSION_INVALID/);
    assert.throws(() => assertHelmVersion('v4.2.3+g43e8b7f'), /HELM_VERSION_INVALID/);
  });

  it('builds digest-pinned production values with all six database roles sealed', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-live',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
      kubernetesApiServiceIp: '10.96.0.1',
    });
    assert.match(values, /repository: commander-lifecycle-api/);
    assert.match(values, new RegExp(`digest: sha256:${'a'.repeat(64)}`));
    assert.match(values, /bundled: true\n    user: postgres/);
    assert.match(values, /existingSecret: cmdr-live-database-tls/);
    assert.match(values, /redis:\n  enabled: true/);
    assert.match(values, /kubernetesApiCidrs:\n      - 10\.96\.0\.1\/32/);
    for (const role of ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops']) {
      assert.match(values, new RegExp(`- ${role}`));
    }
    assert.doesNotMatch(values, /commander-lifecycle-noop/);
  });

  it('builds a real external PostgreSQL TLS lifecycle configuration', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-external',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
      kubernetesApiServiceIp: '10.96.0.1',
      database: {
        kind: 'external',
        secretName: 'cmdr-external-database',
        caSecret: 'cmdr-external-database-ca',
        bootstrapAuthoritySecret: 'cmdr-external-bootstrap',
        serviceNamespace: 'external-db',
        serviceName: 'external-postgres',
        serviceClusterIp: '10.96.12.34',
      },
    });
    assert.match(values, /bundled: false/);
    assert.match(values, /existingSecret: cmdr-external-database/);
    assert.match(values, /caSecret: cmdr-external-database-ca/);
    assert.match(values, /bootstrapAuthoritySecret: cmdr-external-bootstrap/);
    assert.match(values, /namespace: external-db/);
    assert.match(values, /name: external-postgres/);
    assert.match(
      values,
      /egress:\n    databaseCidrs:\n      - 10\.96\.12\.34\/32\n    kubernetesApiCidrs:\n      - 10\.96\.0\.1\/32/,
    );
    assert.doesNotMatch(values, /existingSecret: cmdr-external-database-tls/);
  });

  it('provisions external PostgreSQL with TLS and the exact six-role E2 envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const serialized = JSON.stringify(resources);
    assert.match(serialized, /ssl=on/);
    assert.match(serialized, /ssl_ca_file=\/run\/commander\/database-tls\/ca\.crt/);
    assert.match(serialized, /ssl_cert_file=\/run\/commander\/database-tls\/tls\.crt/);
    assert.match(serialized, /ssl_key_file=\/run\/commander\/database-tls\/tls\.key/);
    assert.match(serialized, /external-postgres-tls/);
    for (const role of [
      'commander_owner',
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      assert.match(serialized, new RegExp(`CREATE ROLE ${role}`));
    }
    assert.equal((resources as { items?: unknown[] }).items?.length, 3);
  });

  it('pins owner memberships to the exact PostgreSQL 16 privilege envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const externalInit = JSON.stringify(resources);
    const bundledInit = readFileSync(
      resolve('deploy/helm/commander/templates/configmap-database-init.yaml'),
      'utf8',
    );
    for (const role of [
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      const grant = new RegExp(
        `GRANT ${role} TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;`,
      );
      assert.match(externalInit, grant);
      assert.match(bundledInit, grant);
    }
  });

  it('pins fresh E2 database ownership and removes ambient PUBLIC access', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const initializers = [
      JSON.stringify(resources),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    for (const initializer of initializers) {
      assert.match(
        initializer,
        /ALTER DATABASE (?:commander|\$\{POSTGRES_DB\}) OWNER TO commander_owner;/,
      );
      assert.match(initializer, /ALTER SCHEMA public OWNER TO commander_owner;/);
      assert.match(
        initializer,
        /REVOKE ALL ON DATABASE (?:commander|\$\{POSTGRES_DB\}) FROM PUBLIC;/,
      );
      assert.match(initializer, /REVOKE ALL ON SCHEMA public FROM PUBLIC;/);
      assert.doesNotMatch(initializer, /GRANT ALL PRIVILEGES ON DATABASE/);
      assert.doesNotMatch(initializer, /GRANT CREATE ON SCHEMA public TO commander_owner/);
      for (const role of [
        'commander_app',
        'commander_tenant_authority',
        'commander_scheduler',
        'commander_worker',
        'commander_adapter_ops',
      ]) {
        assert.match(
          initializer,
          new RegExp(`GRANT CONNECT ON DATABASE (?:commander|\\$\\{POSTGRES_DB\\}) TO ${role};`),
        );
        assert.match(initializer, new RegExp(`GRANT USAGE ON SCHEMA public TO ${role};`));
      }
    }
  });

  it('creates both fresh E2 fixtures with exact role attributes and app settings', () => {
    const initializers = [
      JSON.stringify(
        buildExternalPostgresResources({
          namespace: 'external-db',
          image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
          credentialsSecret: 'external-postgres-credentials',
          tlsSecret: 'external-postgres-tls',
        }),
      ),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    const roleAttributes = new Map([
      ['commander_owner', 'NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS'],
      ['commander_app', 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'],
      [
        'commander_tenant_authority',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_scheduler',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
      ],
      [
        'commander_worker',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_adapter_ops',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
    ]);
    for (const initializer of initializers) {
      for (const [role, attributes] of roleAttributes) {
        assert.match(
          initializer,
          new RegExp(`CREATE ROLE ${role} WITH LOGIN PASSWORD '[^']+' ${attributes};`),
        );
      }
      assert.match(initializer, /ALTER ROLE commander_app SET statement_timeout = '55s';/);
      assert.match(
        initializer,
        /ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s';/,
      );
    }
  });

  it('selects the complete real lifecycle matrix and rejects unknown scenarios', () => {
    assert.deepEqual(selectLifecycleScenarios(), [
      'real-bundled',
      'real-external-tls',
      'failed-rollout-recovery',
    ]);
    assert.deepEqual(selectLifecycleScenarios('real-external-tls'), ['real-external-tls']);
    assert.throws(() => selectLifecycleScenarios('external-postgres'), /KIND_SCENARIO_INVALID/);
  });

  it('fails the top-level harness when any selected scenario fails', () => {
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: false }]), false);
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: true }]), true);
    assert.equal(aggregateScenarioPass([]), false);
  });

  it('includes RBAC and NetworkPolicy results in each scenario pass decision', () => {
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: false }],
        networkPolicy: [{ passed: true }],
      }),
      false,
    );
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: true }],
        networkPolicy: [{ passed: true }],
      }),
      true,
    );
    assert.equal(aggregateScenarioChecks({ assertions: [], rbac: [], networkPolicy: [] }), false);
  });

  it('maps the local production tag to the exact Kind containerd digest reference', () => {
    assert.deepEqual(productionImageReferences(`sha256:${'a'.repeat(64)}`), {
      source: 'docker.io/library/commander-lifecycle-api:kind',
      target: `docker.io/library/commander-lifecycle-api@sha256:${'a'.repeat(64)}`,
    });
    assert.throws(() => productionImageReferences('sha256:bad'), /PRODUCTION_IMAGE_DIGEST_INVALID/);
  });

  it('passes the checked-out source revision into the production image build', () => {
    const args = productionImageBuildArguments('a'.repeat(40));
    assert.ok(args.includes('--build-arg'));
    assert.ok(args.includes('COMMANDER_SOURCE_REVISION=' + 'a'.repeat(40)));
    assert.throws(
      () => productionImageBuildArguments('not-a-revision'),
      /PRODUCTION_IMAGE_SOURCE_REVISION_INVALID/,
    );
  });

  it('reuses a local production image only when its exact repo digest matches its image ID', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    assert.equal(
      reusableProductionImageDigest({
        imageId: digest,
        repoDigests: [`commander-lifecycle-api@${digest}`],
      }),
      digest,
    );
    assert.throws(
      () =>
        reusableProductionImageDigest({
          imageId: digest,
          repoDigests: [`commander-lifecycle-api@sha256:${'b'.repeat(64)}`],
        }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
    assert.throws(
      () => reusableProductionImageDigest({ imageId: digest, repoDigests: [] }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
  });

  it('omits a source revision claim for a reused image digest', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/chart',
      calicoUrl: CALICO_URL,
      image: { digest: 'sha256:' + 'a'.repeat(64) },
      scenarios: [],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.image, { digest: 'sha256:' + 'a'.repeat(64) });
  });

  it('skips a Kind image import only when every node has the exact digest reference', () => {
    const exact = `docker.io/library/postgres:16-alpine@sha256:${'a'.repeat(64)}`;
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine', exact] },
        ],
        exact,
      ),
      true,
    );
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine'] },
        ],
        exact,
      ),
      false,
    );
    assert.equal(nodeInventoriesContainExactReference([], exact), false);
  });

  it('requires the exact proof-reader identity and projected token contract', () => {
    const serviceAccountName = proofReaderName('commander-lifecycle', 'cmdr-live');
    assert.match(serviceAccountName, /^commander-proof-reader-[a-f0-9]{16}$/);
    assert.doesNotThrow(() =>
      assertProofPodContract(
        {
          spec: {
            serviceAccountName,
            automountServiceAccountToken: false,
            volumes: [
              {
                name: 'proof-api-token',
                projected: {
                  sources: [
                    {
                      serviceAccountToken: {
                        audience: 'commander-tenant-cutover-proof/v1',
                        expirationSeconds: 600,
                        path: 'identity-token',
                      },
                    },
                    {
                      serviceAccountToken: {
                        expirationSeconds: 600,
                        path: 'api-token',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        serviceAccountName,
      ),
    );
    assert.throws(
      () =>
        assertProofPodContract(
          {
            spec: {
              serviceAccountName: 'default',
              automountServiceAccountToken: true,
              volumes: [],
            },
          },
          serviceAccountName,
        ),
      /PROOF_POD_CONTRACT_INVALID/,
    );
  });

  it('accepts only the explicit NetworkPolicy timeout sentinel as a negative canary', () => {
    assert.doesNotThrow(() => assertNegativeCanaryResult({ exitCode: 42, reason: 'Error' }));
    assert.throws(
      () => assertNegativeCanaryResult({ exitCode: 1, reason: 'Error' }),
      /NETWORK_POLICY_NEGATIVE_CANARY_INVALID/,
    );
  });

  it('pins the Calico manifest URL', () => {
    assert.match(CALICO_URL, /projectcalico\/calico\/v3\.29\.0/);
  });

  it('detects proof job templates in a chart directory', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'kind-chart-'));
    writeFileSync(resolve(tmp, 'Chart.yaml'), 'name: test\nversion: 0.0.1\n');
    writeFileSync(resolve(tmp, 'values.yaml'), '{}\n');
    const templatesDir = resolve(tmp, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // No templates yet.
    assert.equal(proofTemplatesPresent(tmp), false);

    // Create the template.
    writeFileSync(resolve(templatesDir, 'tenant-cutover-prove-job.yaml'), 'kind: Job\n');
    assert.equal(proofTemplatesPresent(tmp), true);
  });

  it('runs the live Kind workflow for every production proof dependency', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    for (const path of [
      'apps/api/**',
      'deploy/helm/commander/**',
      'packages/**',
      'scripts/**',
      '.dockerignore',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig*.json',
    ]) {
      const quoted = `'${path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`;
      assert.equal(
        workflow.match(new RegExp(`^\\s*- ${quoted}$`, 'gm'))?.length,
        2,
        `${path} must trigger both pull_request and push lifecycle proofs`,
      );
    }
    assert.match(workflow, /run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts run/);
  });

  it('builds Kind lifecycle workspace runtime dependencies before the harness', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const kindJob = workflow.match(/  kind:\n[\s\S]*?(?=\n  [a-z]|$)/)?.[0];

    assert.ok(kindJob, 'the Kind lifecycle job must exist');
    const build = kindJob.indexOf('pnpm --filter @commander/postgres-runtime build');
    const harness = kindJob.indexOf('pnpm exec tsx scripts/helm-lifecycle-kind.ts run');
    assert.ok(build >= 0, 'the Kind lifecycle job must build workspace runtime dependencies');
    assert.ok(build < harness, 'workspace runtime dependencies must build before the harness');
    assert.match(
      kindJob,
      /pnpm --filter @commander\/postgres-runtime build\n          pnpm --filter @commander\/contracts build\n          pnpm --filter @commander\/plugin-sdk build\n          pnpm --filter @commander\/effect-broker build\n          pnpm --filter @commander\/kernel build\n          pnpm --filter @commander\/action-adapters build\n          pnpm --filter @commander\/core build\n          pnpm --filter @commander\/worker-plane build/,
    );
  });

  it('fails closed when sanitized Kind evidence cannot be uploaded', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const uploadStep = workflow.match(/- name: Upload sanitized evidence\n[\s\S]*$/)?.[0];

    assert.ok(uploadStep, 'the Kind lifecycle workflow must upload sanitized evidence');
    assert.match(uploadStep, /uses: actions\/upload-artifact@v4/);
    assert.match(uploadStep, /if: always\(\)/);
    assert.match(uploadStep, /name: kind-lifecycle-evidence/);
    assert.match(uploadStep, /path: kind-lifecycle-evidence\.json/);
    assert.match(uploadStep, /if-no-files-found: error/);
    assert.match(uploadStep, /retention-days: 30/);
  });

  it('omits raw scenario diagnostics and retains only canonical safe evidence fields', () => {
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/secret/chart',
      calicoUrl: CALICO_URL,
      image: { digest: `sha256:${'a'.repeat(64)}`, sourceRevision: 'b'.repeat(40) },
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [{ message: 'kubectl event secret-token private SQL SELECT' }],
          assertions: [
            {
              description: 'raw assertion',
              passed: false,
              detail: 'postgres://owner:secret@db:5432/commander SELECT private_value',
            },
          ],
          error:
            'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=TASK1_CLOSURE_BASELINE_REQUIRED;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
            'd'.repeat(64) +
            '\nNAME READY STATUS COMMANDER_PRIVATE_SECRET_VALUE raw SQL SELECT private_value',
        },
      ],
      ownerFailureEvidence: [
        {
          code: 'COMMANDER_MIGRATION_FAILED' as const,
          producer: 'owner_entrypoint' as const,
          transport: 'kubectl_logs' as const,
          ownerStage: 'lifecycle_prebootstrap_snapshot',
          snapshot: 's0',
          catalogStep: 'functions',
          logSha256: 'c'.repeat(64),
        },
      ],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0];
    const sanitized = sanitizeEvidence(evidence);
    assert.deepEqual(sanitized, {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      calicoUrl: CALICO_URL,
      image: { digest: `sha256:${'a'.repeat(64)}`, sourceRevision: 'b'.repeat(40) },
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          failureCodes: [
            'HELM_TENANT_CUTOVER_FAILED',
            'TENANT_CUTOVER_OWNER_JOB_FAILED',
            'TASK1_CLOSURE_BASELINE_REQUIRED',
          ],
        },
      ],
      ownerFailureEvidence: evidence.ownerFailureEvidence,
      passed: false,
      sanitized: true,
    });
    assert.doesNotMatch(
      JSON.stringify(sanitized),
      /secret|private|SELECT|event|assertion|postgres/i,
    );
  });

  it('rejects unallowlisted and oversized prefixed diagnostic candidates', () => {
    const oversized = 'COMMANDER_' + 'A'.repeat(512);
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/secret/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'COMMANDER_EXFILTRATED_BASE32_PAYLOAD ' + oversized + ' HELM_TENANT_CUTOVER_FAILED',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0];

    assert.deepEqual(sanitizeEvidence(evidence).scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
    ]);
    assert.equal(
      parseOwnerFailureEvidence(
        'code=COMMANDER_EXFILTRATED_BASE32_PAYLOAD;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          'a'.repeat(64),
      ),
      undefined,
    );
  });

  it('reports cluster existence without throwing', () => {
    const exists = kindClusterExists('commander-helm-lifecycle');
    assert.equal(typeof exists, 'boolean');
  });
});
