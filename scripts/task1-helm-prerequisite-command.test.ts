import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  TASK1_SELECTOR_CAN_MATCH_H_CEL,
  canTask1SelectorMatchHook,
  createTask1KubectlPorts,
  loadTask1PrerequisiteContext,
  parseTask1PrerequisiteCommandArgs,
  renderTask1AdmissionPair,
  renderTask1StablePolicies,
  runTask1AdmissionAdministrator,
  runTask1PrerequisiteOperator,
  type Task1KubernetesObject,
  type Task1PrerequisiteCommandPorts,
} from './task1-helm-prerequisite-command.js';

const fixturePath = resolve('scripts/fixtures/task1-prerequisites/values.yaml');
const chartDigest = 'c'.repeat(64);
const subject = 'system:serviceaccount:commander-ops:migration-operator';

async function context() {
  return loadTask1PrerequisiteContext(
    {
      namespace: 'commander',
      release: 'release-a',
      valuesPath: fixturePath,
      stage: 'network',
      migrationOperatorSubject: subject,
    },
    await readFile(fixturePath, 'utf8'),
    chartDigest,
  );
}

function key(object: Task1KubernetesObject): string {
  return `${object.kind}/${object.metadata.namespace ?? ''}/${object.metadata.name}`;
}

function memoryPorts(seed: Task1KubernetesObject[] = []): Task1PrerequisiteCommandPorts & {
  objects: Map<string, Task1KubernetesObject>;
  created: Task1KubernetesObject[];
} {
  const objects = new Map(seed.map((object) => [key(object), structuredClone(object)]));
  const created: Task1KubernetesObject[] = [];
  return {
    objects,
    created,
    async get(kind, name, namespace) {
      return structuredClone(objects.get(`${kind}/${namespace ?? ''}/${name}`) ?? null);
    },
    async create(object) {
      if (objects.has(key(object))) throw new Error('already exists');
      objects.set(key(object), structuredClone(object));
      created.push(structuredClone(object));
      return structuredClone(object);
    },
    async tokenReview() {
      return subject;
    },
    async canI() {
      return false;
    },
    async dryRunCreate(object) {
      const labels = (object.spec.podSelector as { matchLabels?: Record<string, string> })
        ?.matchLabels;
      return (
        !object.metadata.name.endsWith('-malformed') &&
        labels?.['commander.io/migration-client-v2'] === 'true' &&
        Array.isArray(object.spec.egress) &&
        object.spec.egress.length === 3
      );
    },
    async readPublicCertificate() {
      return 'fixture certificate';
    },
    verifyPublicCertificate(pem, expectedSpki, expectedDnsSan) {
      assert.equal(pem, 'fixture certificate');
      assert.equal(expectedSpki, 'd'.repeat(64));
      assert.equal(expectedDnsSan, 'release-a-api-proof.commander.svc.cluster.local');
    },
  };
}

function readyDeployment(
  loaded: Awaited<ReturnType<typeof context>>,
  image = `commander@${loaded.imageDigest}`,
): Task1KubernetesObject {
  const annotations = {
    'commander.io/tenant-context-aware': 'true',
    'commander.io/tenant-authority-phase': 'expand',
    'commander.io/tenant-authority-image-digest': loaded.imageDigest,
    'commander.io/tenant-authority-configuration-sha256': loaded.configurationSha256,
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      namespace: 'commander',
      name: 'release-a-api',
      generation: 4,
      labels: { 'app.kubernetes.io/instance': 'release-a', 'app.kubernetes.io/component': 'api' },
      annotations,
    },
    spec: {
      replicas: 2,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/instance': 'release-a',
            'app.kubernetes.io/component': 'api',
          },
          annotations,
        },
        spec: {
          containers: [
            {
              name: 'api',
              image,
              env: [
                { name: 'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST', value: loaded.imageDigest },
                {
                  name: 'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256',
                  value: loaded.configurationSha256,
                },
              ],
              readinessProbe: {
                exec: { command: ['node', '-e', "https.get('/ready/tenant-authority/v1')"] },
              },
            },
          ],
        },
      },
    },
    status: { observedGeneration: 4, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2 },
  };
}

describe('Task 1 prerequisite command contract', () => {
  it('keeps the tracked CEL selector predicate and exact local truth table in lockstep', async () => {
    assert.equal(
      await readFile(
        resolve('scripts/fixtures/task1-prerequisites/selector-can-match-hook.cel'),
        'utf8',
      ),
      `${TASK1_SELECTOR_CAN_MATCH_H_CEL}\n`,
    );
    const hook = {
      'app.kubernetes.io/name': 'release-a',
      'app.kubernetes.io/instance': 'release-a',
      'commander.io/migration-client-v2': 'true',
      'commander.io/migration-release': 'release-a',
    };
    const cases: Array<[string, unknown, boolean | 'invalid']> = [
      ['empty', {}, true],
      ['fixed matchLabels', { matchLabels: { 'app.kubernetes.io/name': 'other' } }, false],
      [
        'In fixed match',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/name', operator: 'In', values: ['release-a'] },
          ],
        },
        true,
      ],
      [
        'In fixed miss',
        {
          matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'In', values: ['other'] }],
        },
        false,
      ],
      [
        'NotIn fixed match',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/name', operator: 'NotIn', values: ['other'] },
          ],
        },
        true,
      ],
      [
        'NotIn fixed miss',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/name', operator: 'NotIn', values: ['release-a'] },
          ],
        },
        false,
      ],
      [
        'Exists fixed',
        { matchExpressions: [{ key: 'app.kubernetes.io/name', operator: 'Exists', values: [] }] },
        true,
      ],
      [
        'DoesNotExist fixed',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/name', operator: 'DoesNotExist', values: [] },
          ],
        },
        false,
      ],
      [
        'forbidden component absent',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/component', operator: 'DoesNotExist', values: [] },
          ],
        },
        true,
      ],
      [
        'forbidden component required',
        {
          matchExpressions: [
            { key: 'app.kubernetes.io/component', operator: 'NotIn', values: ['migration'] },
          ],
        },
        false,
      ],
      [
        'unconstrained intersection',
        {
          matchExpressions: [
            { key: 'injected', operator: 'In', values: ['a', 'b'] },
            { key: 'injected', operator: 'In', values: ['b', 'c'] },
            { key: 'injected', operator: 'NotIn', values: ['b'] },
          ],
        },
        false,
      ],
      [
        'unconstrained outside finite exclusions',
        {
          matchExpressions: [
            { key: 'injected', operator: 'NotIn', values: ['a', 'b'] },
            { key: 'injected', operator: 'Exists', values: [] },
          ],
        },
        true,
      ],
      [
        'absent conflicts with existence',
        {
          matchExpressions: [
            { key: 'injected', operator: 'DoesNotExist', values: [] },
            { key: 'injected', operator: 'NotIn', values: ['a'] },
          ],
        },
        false,
      ],
      [
        'unknown operator',
        { matchExpressions: [{ key: 'injected', operator: 'Nope', values: [] }] },
        'invalid',
      ],
      [
        'invalid In values',
        { matchExpressions: [{ key: 'injected', operator: 'In', values: [] }] },
        'invalid',
      ],
    ];
    for (const [label, selector, expected] of cases) {
      if (expected === 'invalid') {
        assert.throws(
          () => canTask1SelectorMatchHook(selector, hook),
          /TENANT_POLICY_SELECTOR_INVALID/,
          label,
        );
      } else {
        assert.equal(canTask1SelectorMatchHook(selector, hook), expected, label);
      }
    }
  });

  it('accepts only the exact ordered CLI and resolves the values path', () => {
    const args = [
      '--namespace',
      'commander',
      '--release',
      'release-a',
      '--values',
      'values.yaml',
      '--stage',
      'network',
      '--migration-operator-subject',
      subject,
    ];
    assert.deepEqual(parseTask1PrerequisiteCommandArgs(args, '/workspace'), {
      namespace: 'commander',
      release: 'release-a',
      valuesPath: '/workspace/values.yaml',
      stage: 'network',
      migrationOperatorSubject: subject,
    });
    assert.throws(
      () => parseTask1PrerequisiteCommandArgs([...args, '--force'], '/workspace'),
      /TENANT_POLICY_CLI_ARGUMENT_INVALID/,
    );
    assert.throws(
      () =>
        parseTask1PrerequisiteCommandArgs(
          ['--release', 'release-a', '--namespace', 'commander', ...args.slice(4)],
          '/workspace',
        ),
      /TENANT_POLICY_CLI_ARGUMENT_INVALID/,
    );
    const invalidStage = [...args];
    invalidStage[7] = 'other';
    assert.throws(
      () => parseTask1PrerequisiteCommandArgs(invalidStage, '/workspace'),
      /TENANT_POLICY_CLI_ARGUMENT_INVALID/,
    );
  });

  it('treats only an explicit empty get result as NotFound', async () => {
    const calls: string[][] = [];
    const missing = createTask1KubectlPorts(async (args) => {
      calls.push([...args]);
      return '';
    });
    assert.equal(await missing.get('Service', 'release-a-api-proof', 'commander'), null);
    assert.ok(calls[0]?.includes('--ignore-not-found'));

    const forbidden = createTask1KubectlPorts(async () => {
      throw new Error('TENANT_POLICY_KUBERNETES_COMMAND_FAILED');
    });
    await assert.rejects(
      forbidden.get('Service', 'release-a-api-proof', 'commander'),
      /TENANT_POLICY_KUBERNETES_COMMAND_FAILED/,
    );
  });

  it('reviews an explicitly supplied service-account token', async () => {
    let reviewedToken = '';
    const ports = createTask1KubectlPorts(
      async (args, stdin) => {
        assert.deepEqual(args.slice(0, 2), ['create', '--filename']);
        reviewedToken =
          (JSON.parse(stdin ?? '{}') as { spec?: { token?: string } }).spec?.token ?? '';
        return JSON.stringify({
          status: {
            authenticated: true,
            user: { username: subject },
          },
        });
      },
      async () => 'short-lived-service-account-token\n',
    );

    assert.equal(await ports.tokenReview(), subject);
    assert.equal(reviewedToken, 'short-lived-service-account-token');
  });

  it('checks named access through a structured SelfSubjectAccessReview', async () => {
    let command: readonly string[] = [];
    let manifest: unknown;
    const ports = createTask1KubectlPorts(async (args, stdin) => {
      command = args;
      manifest = JSON.parse(stdin ?? '{}');
      return JSON.stringify({ status: { allowed: false } });
    });

    assert.equal(
      await ports.canI(
        'get',
        'validatingadmissionpolicies.admissionregistration.k8s.io',
        'tenant-policy-guard',
      ),
      false,
    );
    assert.deepEqual(command, ['create', '--filename', '-', '--output', 'json']);
    assert.deepEqual(manifest, {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: {
        resourceAttributes: {
          group: 'admissionregistration.k8s.io',
          name: 'tenant-policy-guard',
          resource: 'validatingadmissionpolicies',
          verb: 'get',
        },
      },
    });
  });

  it('rejects a malformed SelfSubjectAccessReview response', async () => {
    const ports = createTask1KubectlPorts(async () => JSON.stringify({ status: {} }));

    await assert.rejects(
      ports.canI('get', 'validatingadmissionpolicies.admissionregistration.k8s.io'),
      /TENANT_POLICY_KUBERNETES_RESPONSE_INVALID/,
    );
  });

  it('uses the canonical projection and renders the exact stable policy set', async () => {
    const loaded = await context();
    assert.equal(loaded.projection.sha256, loaded.annotationValue);
    assert.equal(loaded.platformChartDigest, chartDigest);
    const policies = renderTask1StablePolicies(loaded);
    assert.equal(policies.length, 3);
    assert.deepEqual(
      policies.map((policy) => `${policy.metadata.namespace}/${policy.metadata.name}`),
      [
        `commander/${loaded.projection.value.stablePolicyNames.egress}`,
        `commander/${loaded.projection.value.stablePolicyNames.apiProofIngress}`,
        `commander/${loaded.projection.value.stablePolicyNames.databaseIngress[0]!.name}`,
      ],
    );
    assert.deepEqual(policies[0]!.spec.podSelector, {
      matchLabels: {
        'app.kubernetes.io/instance': 'release-a',
        'app.kubernetes.io/name': 'release-a',
        'commander.io/migration-client-v2': 'true',
        'commander.io/migration-release': 'release-a',
      },
    });
    assert.deepEqual(policies[0]!.spec.policyTypes, ['Egress']);
    assert.equal((policies[0]!.spec.egress as unknown[]).length, 3);
  });

  it('renders stage-specific fail-closed admission resources with exact names', async () => {
    const loaded = await context();
    const network = renderTask1AdmissionPair(loaded, 'network');
    assert.match(
      network.policy.metadata.name,
      /^commander-tenant-authority-policy-guard-[0-9a-f]{16}$/,
    );
    assert.equal(network.policy.spec.failurePolicy, 'Fail');
    assert.deepEqual(network.binding.spec.validationActions, ['Deny']);
    assert.match(JSON.stringify(network.policy.spec.validations), /migration-operator/);

    const workload = renderTask1AdmissionPair(loaded, 'workload');
    assert.match(workload.policy.metadata.name, /^commander-tenant-authority-guard-[0-9a-f]{16}$/);
    assert.notEqual(workload.policy.metadata.name, network.policy.metadata.name);
    assert.match(JSON.stringify(workload.policy.spec.validations), /tenant-context-aware/);
    assert.match(
      JSON.stringify(workload.policy.spec.validations),
      /COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST/,
    );
    assert.match(
      JSON.stringify(workload.policy.spec.validations),
      /COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256/,
    );
    assert.match(JSON.stringify(workload.policy.spec.validations), /ready\/tenant-authority\/v1/);
    assert.match(JSON.stringify(workload.policy.spec.matchConstraints), /statefulsets/);
    assert.match(
      JSON.stringify(workload.policy.spec.validations),
      /database-transport-content-sha256/,
    );
    assert.match(JSON.stringify(workload.policy.spec.validations), /ssl=on/);
    const sealed = loaded.projection.value.admissionGuards.find(
      (guard) => guard.stage === 'workload',
    );
    assert.ok(sealed);
    assert.deepEqual(workload.policy.spec, sealed.policySpec);
    assert.deepEqual(workload.binding.spec, sealed.bindingSpec);
  });

  it('is create-only, idempotent for exact admission objects, and rejects collisions', async () => {
    const loaded = await context();
    const ports = memoryPorts();
    await runTask1AdmissionAdministrator(loaded, ports);
    assert.equal(ports.created.length, 2);
    await runTask1AdmissionAdministrator(loaded, ports);
    assert.equal(ports.created.length, 2);

    const pair = renderTask1AdmissionPair(loaded, 'network');
    pair.policy.spec.failurePolicy = 'Ignore';
    const collision = memoryPorts([pair.policy]);
    await assert.rejects(
      runTask1AdmissionAdministrator(loaded, collision),
      /TENANT_POLICY_OBJECT_COLLISION/,
    );
    assert.equal(collision.created.length, 0);
  });

  it('refuses workload admission until the exact release Deployment is fully Ready', async () => {
    const loaded = {
      ...(await context()),
      request: { ...(await context()).request, stage: 'workload' as const },
    };
    const ports = memoryPorts();
    await assert.rejects(
      runTask1AdmissionAdministrator(loaded, ports),
      /TENANT_POLICY_WORKLOAD_NOT_READY/,
    );
    assert.equal(ports.created.length, 0);

    const drift = memoryPorts([readyDeployment(loaded, `commander@sha256:${'f'.repeat(64)}`)]);
    await assert.rejects(
      runTask1AdmissionAdministrator(loaded, drift),
      /TENANT_POLICY_WORKLOAD_NOT_READY/,
    );

    const exact = memoryPorts([readyDeployment(loaded)]);
    await runTask1AdmissionAdministrator(loaded, exact);
    assert.deepEqual(
      exact.created.map((object) => object.kind),
      ['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'],
    );
  });

  it('operator verifies identity, admission/RBAC, live Services and creates only stable policies', async () => {
    const loaded = await context();
    const pair = renderTask1AdmissionPair(loaded, 'network');
    pair.policy.status = { observedGeneration: 1, typeChecking: { expressionWarnings: [] } };
    pair.policy.metadata.generation = 1;
    const ports = memoryPorts([
      pair.policy,
      pair.binding,
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { namespace: 'commander', name: 'postgres' },
        spec: {
          selector: {
            'app.kubernetes.io/component': 'postgres',
            'app.kubernetes.io/instance': 'release-a',
          },
          ports: [{ port: 5432, targetPort: 5432, protocol: 'TCP' }],
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { namespace: 'commander', name: 'release-a-api-proof' },
        spec: {
          selector: {
            'app.kubernetes.io/component': 'api',
            'app.kubernetes.io/instance': 'release-a',
          },
          ports: [{ port: 9443, targetPort: 9443, protocol: 'TCP' }],
        },
      },
    ]);
    await runTask1PrerequisiteOperator(loaded, ports);
    assert.equal(ports.created.length, 3);
    assert.ok(ports.created.every((object) => object.kind === 'NetworkPolicy'));
  });

  it('allows only deterministic future release Services to be absent on a fresh install', async () => {
    const bytes = (await readFile(fixturePath, 'utf8')).replace(
      'name: postgres',
      'name: release-a-postgres',
    );
    const loaded = loadTask1PrerequisiteContext(
      {
        namespace: 'commander',
        release: 'release-a',
        valuesPath: fixturePath,
        stage: 'network',
        migrationOperatorSubject: subject,
      },
      bytes,
      chartDigest,
    );
    const pair = renderTask1AdmissionPair(loaded, 'network');
    pair.policy.metadata.generation = 1;
    pair.policy.status = { observedGeneration: 1, typeChecking: { expressionWarnings: [] } };
    const ports = memoryPorts([pair.policy, pair.binding]);
    await runTask1PrerequisiteOperator(loaded, ports);
    assert.equal(ports.created.length, 3);
  });

  it('operator fails closed on subject mismatch, admission write permission, or Service drift', async () => {
    const loaded = await context();
    const pair = renderTask1AdmissionPair(loaded, 'network');
    pair.policy.metadata.generation = 1;
    pair.policy.status = { observedGeneration: 1, typeChecking: { expressionWarnings: [] } };
    const wrongSubject = memoryPorts([pair.policy, pair.binding]);
    wrongSubject.tokenReview = async () => 'system:serviceaccount:commander-ops:other';
    await assert.rejects(
      runTask1PrerequisiteOperator(loaded, wrongSubject),
      /TENANT_POLICY_SUBJECT_MISMATCH/,
    );

    const broadRbac = memoryPorts([pair.policy, pair.binding]);
    broadRbac.canI = async () => true;
    await assert.rejects(
      runTask1PrerequisiteOperator(loaded, broadRbac),
      /TENANT_POLICY_ADMISSION_RBAC_TOO_BROAD/,
    );

    const drift = memoryPorts([
      pair.policy,
      pair.binding,
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { namespace: 'commander', name: 'postgres' },
        spec: {
          selector: { app: 'wrong' },
          ports: [{ port: 5432, targetPort: 5432, protocol: 'TCP' }],
        },
      },
    ]);
    await assert.rejects(
      runTask1PrerequisiteOperator(loaded, drift),
      /TENANT_POLICY_SERVICE_MISMATCH/,
    );
  });
});
