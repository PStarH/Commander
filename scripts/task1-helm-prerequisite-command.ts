import { createHash, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { load } from 'js-yaml';
import { canonicalBootstrapJson } from '../packages/kernel/src/canonicalBootstrap.js';
import { verifyChartContentDigest } from './chart-content-digest.js';
import {
  createTask1PrerequisitePolicyConfig,
  type Task1PrerequisiteInput,
} from './task1-helm-prerequisite.js';

const NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const SUBJECT =
  /^system:serviceaccount:([a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?):([a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONFIG_DIGEST_ANNOTATION = 'commander.io/prerequisite-policy-config-sha256';
const LABEL_KEY =
  /^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;

export const TASK1_SELECTOR_CAN_MATCH_H_CEL =
  "variables.selectorRequirements.all(r, r.key in variables.hookLabels ? (r.operator == 'In' ? variables.hookLabels[r.key] in r.values : r.operator == 'NotIn' ? !(variables.hookLabels[r.key] in r.values) : r.operator == 'Exists' ? true : false) : r.key == variables.componentKey ? r.operator == 'DoesNotExist' : (!(r.operator == 'DoesNotExist' && variables.selectorRequirements.exists(o, o.key == r.key && o.operator != 'DoesNotExist')) && (r.operator != 'In' || r.values.exists(v, variables.selectorRequirements.all(o, o.key != r.key || (o.operator == 'In' ? v in o.values : o.operator == 'NotIn' ? !(v in o.values) : o.operator == 'Exists' ? true : false)))))";

export type Task1PrerequisiteStage = 'network' | 'workload';

export interface Task1PrerequisiteCommandRequest {
  namespace: string;
  release: string;
  valuesPath: string;
  stage: Task1PrerequisiteStage;
  migrationOperatorSubject: string;
}

export interface Task1KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    generation?: number;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
}

export interface Task1PrerequisiteContext {
  request: Task1PrerequisiteCommandRequest;
  projection: ReturnType<typeof createTask1PrerequisitePolicyConfig>;
  annotationValue: string;
  platformChartDigest: string;
  imageDigest: string;
  configurationSha256: string;
  publicCertificateSecret: string;
  publicCertificateKey: string;
}

export interface Task1PrerequisiteCommandPorts {
  get(kind: string, name: string, namespace?: string): Promise<Task1KubernetesObject | null>;
  create(object: Task1KubernetesObject): Promise<Task1KubernetesObject>;
  tokenReview(): Promise<string>;
  canI(verb: string, resource: string, name?: string): Promise<boolean>;
  dryRunCreate(object: Task1KubernetesObject): Promise<boolean>;
  readPublicCertificate(namespace: string, secretName: string, key: string): Promise<string>;
  verifyPublicCertificate(pem: string, expectedSpkiSha256: string, expectedDnsSan: string): void;
}

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('TENANT_POLICY_VALUES_INVALID');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('TENANT_POLICY_VALUES_INVALID');
  return value;
}

function name(value: unknown): string {
  const result = string(value);
  if (!NAME.test(result)) fail('TENANT_POLICY_CLI_ARGUMENT_INVALID');
  return result;
}

function subject(value: unknown): string {
  const result = string(value);
  if (!SUBJECT.test(result)) fail('TENANT_POLICY_CLI_ARGUMENT_INVALID');
  return result;
}

export function parseTask1PrerequisiteCommandArgs(
  args: readonly string[],
  cwd: string,
): Task1PrerequisiteCommandRequest {
  if (
    args.length !== 10 ||
    args[0] !== '--namespace' ||
    args[2] !== '--release' ||
    args[4] !== '--values' ||
    args[6] !== '--stage' ||
    args[8] !== '--migration-operator-subject' ||
    !args[5] ||
    !['network', 'workload'].includes(args[7] ?? '')
  )
    fail('TENANT_POLICY_CLI_ARGUMENT_INVALID');
  return {
    namespace: name(args[1]),
    release: name(args[3]),
    valuesPath: isAbsolute(args[5]) ? args[5] : resolve(cwd, args[5]),
    stage: args[7] as Task1PrerequisiteStage,
    migrationOperatorSubject: subject(args[9]),
  };
}

export function loadTask1PrerequisiteContext(
  request: Task1PrerequisiteCommandRequest,
  bytes: string,
  chartDigest: string,
): Task1PrerequisiteContext {
  let parsed: unknown;
  try {
    parsed = load(bytes);
  } catch {
    fail('TENANT_POLICY_VALUES_INVALID');
  }
  const root = record(parsed);
  const networkPolicy = record(root.networkPolicy);
  const migrationOperator = record(networkPolicy.migrationOperator);
  const configuredSubject = string(migrationOperator.subject);
  if (configuredSubject !== request.migrationOperatorSubject)
    fail('TENANT_POLICY_SUBJECT_MISMATCH');
  if (networkPolicy.enabled !== true) fail('TENANT_POLICY_NETWORK_POLICY_REQUIRED');

  const tenantAuthority = record(root.tenantAuthority);
  const platformBinding = record(tenantAuthority.platformBinding);
  const expectedChartDigest = string(platformBinding.chartContentSha256);
  if (!SHA256.test(chartDigest) || expectedChartDigest !== chartDigest)
    fail('TENANT_POLICY_CHART_DIGEST_MISMATCH');
  const image = record(root.image);
  const imageDigest = string(image.digest);
  const configurationSha256 = string(tenantAuthority.configurationSha256);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest) || !SHA256.test(configurationSha256))
    fail('TENANT_POLICY_VALUES_INVALID');

  const apiProof = record(tenantAuthority.apiProof);
  const input: Task1PrerequisiteInput = {
    namespace: request.namespace,
    releaseName: request.release,
    clusterDomain: string(networkPolicy.clusterDomain),
    migrationOperatorSubject: request.migrationOperatorSubject,
    clusterDns: record(networkPolicy.clusterDns) as Task1PrerequisiteInput['clusterDns'],
    databaseEndpoints:
      networkPolicy.databaseEndpoints as Task1PrerequisiteInput['databaseEndpoints'],
    apiProof: {
      serviceName: string(apiProof.serviceName),
      servicePort: apiProof.servicePort as number,
      targetPort: apiProof.targetPort as number,
      podSelector: record(apiProof.podSelector) as Record<string, string>,
      dnsSan: string(apiProof.dnsSan),
      spkiSha256: string(apiProof.publicCertificateSpkiSha256),
    },
  };
  let projection: ReturnType<typeof createTask1PrerequisitePolicyConfig>;
  try {
    projection = createTask1PrerequisitePolicyConfig(input);
  } catch {
    fail('TENANT_POLICY_VALUES_INVALID');
  }
  return {
    request,
    projection,
    annotationValue: projection.sha256,
    platformChartDigest: chartDigest,
    imageDigest,
    configurationSha256,
    publicCertificateSecret: string(apiProof.publicSecret),
    publicCertificateKey: typeof apiProof.certKey === 'string' ? apiProof.certKey : 'tls.crt',
  };
}

function hash16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

type SelectorRequirement = {
  key: string;
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  values: string[];
};

function selectorInvalid(): never {
  throw new Error('TENANT_POLICY_SELECTOR_INVALID');
}

function selectorRequirements(value: unknown): SelectorRequirement[] {
  const selector = record(value);
  if (Object.keys(selector).some((key) => !['matchLabels', 'matchExpressions'].includes(key)))
    selectorInvalid();
  const requirements: SelectorRequirement[] = [];
  if (selector.matchLabels !== undefined) {
    const labels = record(selector.matchLabels);
    for (const [key, item] of Object.entries(labels)) {
      if (!LABEL_KEY.test(key) || typeof item !== 'string' || !LABEL_VALUE.test(item))
        selectorInvalid();
      requirements.push({ key, operator: 'In', values: [item] });
    }
  }
  if (selector.matchExpressions !== undefined) {
    if (!Array.isArray(selector.matchExpressions)) selectorInvalid();
    for (const item of selector.matchExpressions) {
      const expression = record(item);
      if (
        Object.keys(expression).some((key) => !['key', 'operator', 'values'].includes(key)) ||
        typeof expression.key !== 'string' ||
        !LABEL_KEY.test(expression.key) ||
        !['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(String(expression.operator)) ||
        !Array.isArray(expression.values) ||
        expression.values.some(
          (candidate) => typeof candidate !== 'string' || !LABEL_VALUE.test(candidate),
        )
      )
        selectorInvalid();
      const operator = expression.operator as SelectorRequirement['operator'];
      if (
        (['In', 'NotIn'].includes(operator) && expression.values.length === 0) ||
        (['Exists', 'DoesNotExist'].includes(operator) && expression.values.length !== 0)
      )
        selectorInvalid();
      requirements.push({
        key: expression.key,
        operator,
        values: [...expression.values] as string[],
      });
    }
  }
  return requirements;
}

export function canTask1SelectorMatchHook(
  value: unknown,
  fixedHookLabels: Record<string, string>,
): boolean {
  const requirements = selectorRequirements(value);
  const groups = new Map<string, SelectorRequirement[]>();
  for (const requirement of requirements) {
    const group = groups.get(requirement.key) ?? [];
    group.push(requirement);
    groups.set(requirement.key, group);
  }
  for (const [key, group] of groups) {
    const fixed = fixedHookLabels[key];
    if (fixed !== undefined) {
      if (
        !group.every((requirement) =>
          requirement.operator === 'In'
            ? requirement.values.includes(fixed)
            : requirement.operator === 'NotIn'
              ? !requirement.values.includes(fixed)
              : requirement.operator === 'Exists',
        )
      )
        return false;
      continue;
    }
    if (key === 'app.kubernetes.io/component') {
      if (!group.every((requirement) => requirement.operator === 'DoesNotExist')) return false;
      continue;
    }
    const absent = group.some((requirement) => requirement.operator === 'DoesNotExist');
    const requiresExistence = group.some((requirement) => requirement.operator !== 'DoesNotExist');
    if (absent && requiresExistence) return false;
    const finite = group.filter((requirement) => requirement.operator === 'In');
    if (finite.length === 0) continue;
    const candidates = finite[0]!.values.filter(
      (candidate) =>
        finite.every((requirement) => requirement.values.includes(candidate)) &&
        group.every(
          (requirement) =>
            requirement.operator !== 'NotIn' || !requirement.values.includes(candidate),
        ),
    );
    if (candidates.length === 0) return false;
  }
  return true;
}

function hookLabels(context: Task1PrerequisiteContext): Record<string, string> {
  return {
    'app.kubernetes.io/instance': context.request.release,
    'app.kubernetes.io/name': context.request.release,
    'commander.io/migration-client-v2': 'true',
    'commander.io/migration-release': context.request.release,
  };
}

function policyMetadata(nameValue: string, namespace: string, purpose: string, digest: string) {
  return {
    name: nameValue,
    namespace,
    labels: {
      'app.kubernetes.io/managed-by': 'commander-operator',
      'commander.io/purpose': purpose,
    },
    annotations: { [CONFIG_DIGEST_ANNOTATION]: digest },
  };
}

function peer(namespace: string, podSelector: Record<string, string>): Record<string, unknown> {
  return {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
    podSelector: { matchLabels: podSelector },
  };
}

export function renderTask1StablePolicies(
  context: Task1PrerequisiteContext,
): Task1KubernetesObject[] {
  const { value } = context.projection;
  const labels = hookLabels(context);
  const egress: Array<Record<string, unknown>> = [
    {
      to: [peer(value.clusterDns.namespace, value.clusterDns.podSelector)],
      ports: [
        { protocol: 'TCP', port: 53 },
        { protocol: 'UDP', port: 53 },
      ],
    },
    {
      to: [peer(value.namespace, value.apiProof.podSelector)],
      ports: [{ protocol: 'TCP', port: value.apiProof.targetPort }],
    },
  ];
  for (const endpoint of value.databaseEndpoints) {
    egress.push(
      endpoint.kind === 'cidr'
        ? {
            to: [{ ipBlock: { cidr: endpoint.cidr } }],
            ports: [{ protocol: 'TCP', port: endpoint.port }],
          }
        : {
            to: [peer(endpoint.namespace, endpoint.podSelector)],
            ports: [{ protocol: 'TCP', port: endpoint.targetPort }],
          },
    );
  }
  const policies: Task1KubernetesObject[] = [
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: policyMetadata(
        value.stablePolicyNames.egress,
        value.namespace,
        'migration-egress',
        context.annotationValue,
      ),
      spec: { podSelector: { matchLabels: labels }, policyTypes: ['Egress'], egress },
    },
  ];

  const ingress = (
    policyName: string,
    namespace: string,
    podSelector: Record<string, string>,
    targetPort: number,
    purpose: string,
  ): Task1KubernetesObject => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: policyMetadata(policyName, namespace, purpose, context.annotationValue),
    spec: {
      podSelector: { matchLabels: podSelector },
      policyTypes: ['Ingress'],
      ingress: [
        { from: [peer(value.namespace, labels)], ports: [{ protocol: 'TCP', port: targetPort }] },
      ],
    },
  });
  policies.push(
    ingress(
      value.stablePolicyNames.apiProofIngress,
      value.namespace,
      value.apiProof.podSelector,
      value.apiProof.targetPort,
      'api-proof-migration-ingress',
    ),
  );
  for (const stable of value.stablePolicyNames.databaseIngress) {
    const endpoint = value.databaseEndpoints.find(
      (candidate) =>
        candidate.kind === 'service' &&
        candidate.namespace === stable.namespace &&
        candidate.name === stable.serviceName &&
        candidate.targetPort === stable.targetPort,
    );
    if (!endpoint || endpoint.kind !== 'service') fail('TENANT_POLICY_VALUES_INVALID');
    policies.push(
      ingress(
        stable.name,
        stable.namespace,
        endpoint.podSelector,
        stable.targetPort,
        'database-migration-ingress',
      ),
    );
  }
  return policies;
}

function admissionMetadata(nameValue: string, digest: string) {
  return { name: nameValue, annotations: { [CONFIG_DIGEST_ANNOTATION]: digest } };
}

function networkGuardValidations(context: Task1PrerequisiteContext): Array<Record<string, string>> {
  const policies = renderTask1StablePolicies(context);
  const allowed = policies.map((policy) => ({
    namespace: policy.metadata.namespace,
    name: policy.metadata.name,
    labels: policy.metadata.labels,
    annotations: policy.metadata.annotations,
    spec: policy.spec,
  }));
  const allowedJcs = canonicalBootstrapJson(allowed)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");
  const operator = context.request.migrationOperatorSubject.replaceAll("'", "\\'");
  const protectedNames = policies.map((policy) => `'${policy.metadata.name}'`).join(',');
  return [
    {
      expression: `request.resource.resource != 'networkpolicies' || request.operation == 'CREATE' || !(object.metadata.name in [${protectedNames}])`,
      message: 'protected stable policies are create-only',
    },
    {
      expression: `request.resource.resource != 'networkpolicies' || request.userInfo.username != '${operator}' || (request.operation == 'CREATE' && ${allowedJcs}.exists(p, p.namespace == object.metadata.namespace && p.name == object.metadata.name && p.labels == object.metadata.labels && p.annotations == object.metadata.annotations && p.spec == object.spec))`,
      message: 'migration operator may create only an exact rendered stable policy',
    },
    {
      expression: `request.resource.resource != 'networkpolicies' || request.userInfo.username == '${operator}' || request.operation == 'DELETE' || !has(object.spec.egress) || size(object.spec.egress) == 0 || !(${TASK1_SELECTOR_CAN_MATCH_H_CEL})`,
      message: 'non-operator NetworkPolicy must not add egress to a protected hook selector',
    },
    {
      expression: `request.resource.resource != 'pods' || request.operation != 'CREATE' || !(${Object.entries(
        hookLabels(context),
      )
        .map(([key, value]) => `object.metadata.labels['${key}'] == '${value}'`)
        .join(' && ')}) || !('${'app.kubernetes.io/component'}' in object.metadata.labels)`,
      message: 'migration hook Pods may not carry the legacy component label',
    },
    {
      expression: `request.resource.resource != 'pods' || request.operation != 'UPDATE' || !(${Object.entries(
        hookLabels(context),
      )
        .map(([key, value]) => `oldObject.metadata.labels['${key}'] == '${value}'`)
        .join(' && ')}) || ((${Object.entries(hookLabels(context))
        .map(([key, value]) => `object.metadata.labels['${key}'] == '${value}'`)
        .join(' && ')}) && !('${'app.kubernetes.io/component'}' in object.metadata.labels))`,
      message: 'migration hook Pod labels are immutable',
    },
  ];
}

function workloadGuardValidations(
  context: Task1PrerequisiteContext,
): Array<Record<string, string>> {
  const release = context.request.release.replaceAll("'", "\\'");
  return [
    {
      expression: `object.metadata.name != '${release}-api' || (object.metadata.labels['app.kubernetes.io/instance'] == '${release}' && object.metadata.labels['app.kubernetes.io/component'] == 'api' && object.metadata.annotations['commander.io/tenant-context-aware'] == 'true' && object.spec.template.metadata.annotations['commander.io/tenant-context-aware'] == 'true' && object.metadata.annotations['commander.io/tenant-authority-phase'] in ['expand', 'enforce'] && object.metadata.annotations['commander.io/tenant-authority-phase'] == object.spec.template.metadata.annotations['commander.io/tenant-authority-phase'] && object.metadata.annotations['commander.io/tenant-authority-image-digest'].matches('^sha256:[0-9a-f]{64}$') && object.metadata.annotations['commander.io/tenant-authority-image-digest'] == object.spec.template.metadata.annotations['commander.io/tenant-authority-image-digest'] && object.metadata.annotations['commander.io/tenant-authority-configuration-sha256'].matches('^[0-9a-f]{64}$') && object.metadata.annotations['commander.io/tenant-authority-configuration-sha256'] == object.spec.template.metadata.annotations['commander.io/tenant-authority-configuration-sha256'] && object.spec.template.spec.containers.filter(c, c.name == 'api').size() == 1 && object.spec.template.spec.containers.exists(c, c.name == 'api' && c.image.endsWith('@' + object.metadata.annotations['commander.io/tenant-authority-image-digest']) && c.env.exists(e, e.name == 'COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST' && e.value == object.metadata.annotations['commander.io/tenant-authority-image-digest']) && c.env.exists(e, e.name == 'COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256' && e.value == object.metadata.annotations['commander.io/tenant-authority-configuration-sha256']) && c.readinessProbe.exec.command.exists(a, a == '/ready/tenant-authority/v1'))))`,
      message: 'tenant-authority API workload must preserve exact context-aware metadata',
    },
    {
      expression: `object.metadata.name != '${release}-postgres' || (object.metadata.labels['app.kubernetes.io/instance'] == '${release}' && object.metadata.labels['app.kubernetes.io/component'] == 'postgres' && object.spec.serviceName == '${release}-postgres' && object.spec.template.metadata.annotations['commander.io/database-transport-content-sha256'].matches('^[0-9a-f]{64}$') && object.spec.template.spec.volumes.filter(v, v.name == 'database-tls').size() == 1 && object.spec.template.spec.volumes.exists(v, v.name == 'database-tls' && has(v.secret) && v.secret.defaultMode == 288 && v.secret.items.exists(i, i.key == 'ca.crt' && i.path == 'ca.crt') && v.secret.items.exists(i, i.key == 'tls.crt' && i.path == 'tls.crt') && v.secret.items.exists(i, i.key == 'tls.key' && i.path == 'tls.key')) && object.spec.template.spec.containers.filter(c, c.name == 'postgres').size() == 1 && object.spec.template.spec.containers.exists(c, c.name == 'postgres' && c.args.exists(a, a == 'ssl=on') && c.args.exists(a, a == 'ssl_ca_file=/run/commander/database-tls/ca.crt') && c.args.exists(a, a == 'ssl_cert_file=/run/commander/database-tls/tls.crt') && c.args.exists(a, a == 'ssl_key_file=/run/commander/database-tls/tls.key') && c.volumeMounts.exists(m, m.name == 'database-tls' && m.mountPath == '/run/commander/database-tls' && m.readOnly == true) && c.volumeMounts.exists(m, m.name == 'postgres-data' && m.mountPath == '/var/lib/postgresql/data')) && ((has(object.spec.volumeClaimTemplates) && object.spec.volumeClaimTemplates.size() == 1 && object.spec.volumeClaimTemplates[0].metadata.name == 'postgres-data') || object.spec.template.spec.volumes.exists(v, v.name == 'postgres-data' && has(v.emptyDir))))`,
      message: 'bundled PostgreSQL must preserve exact TLS transport and data-volume identity',
    },
  ];
}

export function renderTask1AdmissionPair(
  context: Task1PrerequisiteContext,
  stage: Task1PrerequisiteStage,
): { policy: Task1KubernetesObject; binding: Task1KubernetesObject } {
  const suffix = hash16(`${context.request.namespace}/${context.request.release}`);
  const nameValue =
    stage === 'network'
      ? `commander-tenant-authority-policy-guard-${suffix}`
      : `commander-tenant-authority-guard-${suffix}`;
  const resources =
    stage === 'network' ? ['networkpolicies', 'pods'] : ['deployments', 'statefulsets'];
  const apiGroups = stage === 'network' ? ['networking.k8s.io', ''] : ['apps'];
  const policy: Task1KubernetesObject = {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: admissionMetadata(nameValue, context.annotationValue),
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules:
          stage === 'network'
            ? [
                {
                  apiGroups: ['networking.k8s.io'],
                  apiVersions: ['v1'],
                  operations: ['CREATE', 'UPDATE', 'DELETE'],
                  resources: ['networkpolicies'],
                },
                {
                  apiGroups: [''],
                  apiVersions: ['v1'],
                  operations: ['CREATE', 'UPDATE'],
                  resources: ['pods'],
                },
              ]
            : [{ apiGroups, apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources }],
        matchPolicy: 'Equivalent',
      },
      ...(stage === 'network'
        ? {
            variables: [
              { name: 'hookLabels', expression: canonicalBootstrapJson(hookLabels(context)) },
              { name: 'componentKey', expression: "'app.kubernetes.io/component'" },
              {
                name: 'selectorRequirements',
                expression:
                  "request.resource.resource != 'networkpolicies' ? [] : (has(object.spec.podSelector.matchLabels) ? object.spec.podSelector.matchLabels.map(k, {'key': k, 'operator': 'In', 'values': [object.spec.podSelector.matchLabels[k]]}) : []) + (has(object.spec.podSelector.matchExpressions) ? object.spec.podSelector.matchExpressions : [])",
              },
            ],
          }
        : {}),
      validations:
        stage === 'network' ? networkGuardValidations(context) : workloadGuardValidations(context),
    },
  };
  const binding: Task1KubernetesObject = {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicyBinding',
    metadata: admissionMetadata(nameValue, context.annotationValue),
    spec: {
      policyName: nameValue,
      validationActions: ['Deny'],
      matchResources: {
        namespaceSelector:
          stage === 'network'
            ? {
                matchExpressions: [
                  {
                    key: 'kubernetes.io/metadata.name',
                    operator: 'In',
                    values: [
                      ...new Set([
                        context.request.namespace,
                        ...context.projection.value.databaseEndpoints
                          .filter((endpoint) => endpoint.kind === 'service')
                          .map((endpoint) => endpoint.namespace),
                      ]),
                    ].sort(),
                  },
                ],
              }
            : {
                matchLabels: { 'kubernetes.io/metadata.name': context.request.namespace },
              },
      },
    },
  };
  return { policy, binding };
}

function comparable(object: Task1KubernetesObject): Record<string, unknown> {
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    metadata: {
      name: object.metadata.name,
      ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
      ...(object.metadata.labels ? { labels: object.metadata.labels } : {}),
      ...(object.metadata.annotations ? { annotations: object.metadata.annotations } : {}),
    },
    spec: object.spec,
  };
}

function exact(actual: Task1KubernetesObject, expected: Task1KubernetesObject): boolean {
  return (
    canonicalBootstrapJson(comparable(actual)) === canonicalBootstrapJson(comparable(expected))
  );
}

async function ensureCreateOnly(
  objects: readonly Task1KubernetesObject[],
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  const existing = await Promise.all(
    objects.map((object) =>
      ports.get(object.kind, object.metadata.name, object.metadata.namespace),
    ),
  );
  for (let index = 0; index < objects.length; index += 1) {
    if (existing[index] && !exact(existing[index]!, objects[index]!))
      fail('TENANT_POLICY_OBJECT_COLLISION');
  }
  for (let index = 0; index < objects.length; index += 1) {
    const expected = objects[index]!;
    if (!existing[index]) await ports.create(expected);
    const observed = await ports.get(
      expected.kind,
      expected.metadata.name,
      expected.metadata.namespace,
    );
    if (!observed || !exact(observed, expected)) fail('TENANT_POLICY_OBJECT_MISMATCH');
  }
}

function deploymentReady(
  deployment: Task1KubernetesObject | null,
  context: Task1PrerequisiteContext,
): boolean {
  try {
    if (!deployment) return false;
    const spec = record(deployment.spec);
    const status = record(deployment.status);
    const metadata = deployment.metadata;
    const labels = metadata.labels ?? {};
    const annotations = metadata.annotations ?? {};
    const template = record(spec.template);
    const templateMetadata = record(template.metadata);
    const templateLabels = record(templateMetadata.labels);
    const templateAnnotations = record(templateMetadata.annotations);
    const templateSpec = record(template.spec);
    if (!Array.isArray(templateSpec.containers)) return false;
    const apiContainers = templateSpec.containers
      .map(record)
      .filter((container) => container.name === 'api');
    if (apiContainers.length !== 1) return false;
    const api = apiContainers[0]!;
    if (!Array.isArray(api.env)) return false;
    const environment = new Map(api.env.map(record).map((item) => [item.name, item.value]));
    const readinessProbe = record(api.readinessProbe);
    const execProbe = record(readinessProbe.exec);
    const execCommand = Array.isArray(execProbe.command) ? execProbe.command : [];
    const replicas = spec.replicas;
    return (
      metadata.name === context.request.release + '-api' &&
      labels['app.kubernetes.io/instance'] === context.request.release &&
      labels['app.kubernetes.io/component'] === 'api' &&
      metadata.generation === status.observedGeneration &&
      typeof replicas === 'number' &&
      replicas > 0 &&
      status.readyReplicas === replicas &&
      status.updatedReplicas === replicas &&
      status.availableReplicas === replicas &&
      annotations['commander.io/tenant-context-aware'] === 'true' &&
      ['expand', 'enforce'].includes(annotations['commander.io/tenant-authority-phase'] ?? '') &&
      annotations['commander.io/tenant-authority-image-digest'] === context.imageDigest &&
      annotations['commander.io/tenant-authority-configuration-sha256'] ===
        context.configurationSha256 &&
      templateLabels['app.kubernetes.io/instance'] === context.request.release &&
      templateLabels['app.kubernetes.io/component'] === 'api' &&
      templateAnnotations['commander.io/tenant-context-aware'] === 'true' &&
      templateAnnotations['commander.io/tenant-authority-phase'] ===
        annotations['commander.io/tenant-authority-phase'] &&
      templateAnnotations['commander.io/tenant-authority-image-digest'] === context.imageDigest &&
      templateAnnotations['commander.io/tenant-authority-configuration-sha256'] ===
        context.configurationSha256 &&
      typeof api.image === 'string' &&
      api.image.endsWith('@' + context.imageDigest) &&
      environment.get('COMMANDER_TENANT_AUTHORITY_IMAGE_DIGEST') === context.imageDigest &&
      environment.get('COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256') ===
        context.configurationSha256 &&
      execCommand.some(
        (value) => typeof value === 'string' && value.includes('/ready/tenant-authority/v1'),
      )
    );
  } catch {
    return false;
  }
}

async function requireReadyDeployment(
  context: Task1PrerequisiteContext,
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  const deployment = await ports.get(
    'Deployment',
    `${context.request.release}-api`,
    context.request.namespace,
  );
  if (!deploymentReady(deployment, context)) fail('TENANT_POLICY_WORKLOAD_NOT_READY');
}

export async function runTask1AdmissionAdministrator(
  context: Task1PrerequisiteContext,
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  if (context.request.stage === 'workload') await requireReadyDeployment(context, ports);
  const pair = renderTask1AdmissionPair(context, context.request.stage);
  await ensureCreateOnly([pair.policy, pair.binding], ports);
}

function admissionReady(policy: Task1KubernetesObject): boolean {
  try {
    const status = record(policy.status);
    const checking = record(status.typeChecking);
    return (
      policy.metadata.generation === status.observedGeneration &&
      Array.isArray(checking.expressionWarnings) &&
      checking.expressionWarnings.length === 0
    );
  } catch {
    return false;
  }
}

async function requireAdmission(
  context: Task1PrerequisiteContext,
  stage: Task1PrerequisiteStage,
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  const pair = renderTask1AdmissionPair(context, stage);
  const policy = await ports.get(pair.policy.kind, pair.policy.metadata.name);
  const binding = await ports.get(pair.binding.kind, pair.binding.metadata.name);
  if (!policy || !binding || !exact(policy, pair.policy) || !exact(binding, pair.binding))
    fail('TENANT_POLICY_ADMISSION_MISMATCH');
  if (!admissionReady(policy)) fail('TENANT_POLICY_ADMISSION_NOT_READY');
  for (const resource of [
    'validatingadmissionpolicies.admissionregistration.k8s.io',
    'validatingadmissionpolicybindings.admissionregistration.k8s.io',
  ]) {
    for (const verb of ['create', 'update', 'patch', 'delete', 'list', 'watch']) {
      if (await ports.canI(verb, resource, pair.policy.metadata.name))
        fail('TENANT_POLICY_ADMISSION_RBAC_TOO_BROAD');
    }
  }
}

function assertService(
  service: Task1KubernetesObject | null,
  expected: {
    namespace: string;
    name: string;
    servicePort: number;
    targetPort: number;
    podSelector: Record<string, string>;
  },
): void {
  if (!service) fail('TENANT_POLICY_SERVICE_MISMATCH');
  const selector = service.spec.selector;
  const ports = service.spec.ports;
  if (
    canonicalBootstrapJson(selector) !== canonicalBootstrapJson(expected.podSelector) ||
    !Array.isArray(ports)
  )
    fail('TENANT_POLICY_SERVICE_MISMATCH');
  const matching = ports.filter((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    return (
      value.port === expected.servicePort &&
      value.targetPort === expected.targetPort &&
      value.protocol === 'TCP'
    );
  });
  if (matching.length !== 1) fail('TENANT_POLICY_SERVICE_MISMATCH');
}

async function validateServices(
  context: Task1PrerequisiteContext,
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  const releaseDeployment = await ports.get(
    'Deployment',
    `${context.request.release}-api`,
    context.request.namespace,
  );
  const fresh = releaseDeployment === null;
  for (const endpoint of context.projection.value.databaseEndpoints) {
    if (endpoint.kind !== 'service') continue;
    const service = await ports.get('Service', endpoint.name, endpoint.namespace);
    if (
      !service &&
      fresh &&
      endpoint.namespace === context.request.namespace &&
      endpoint.name === `${context.request.release}-postgres`
    )
      continue;
    assertService(service, endpoint);
  }
  const proof = context.projection.value.apiProof;
  const proofService = await ports.get('Service', proof.serviceName, context.request.namespace);
  if (!proofService && fresh && proof.serviceName === `${context.request.release}-api-proof`)
    return;
  assertService(proofService, {
    namespace: context.request.namespace,
    name: proof.serviceName,
    servicePort: proof.servicePort,
    targetPort: proof.targetPort,
    podSelector: proof.podSelector,
  });
}

async function proveAdmissionEnforcement(
  policies: readonly Task1KubernetesObject[],
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  const exactPolicy = policies[0]!;
  if (!(await ports.dryRunCreate(exactPolicy))) fail('TENANT_POLICY_ADMISSION_PROOF_FAILED');
  const malformed = [
    {
      ...structuredClone(exactPolicy),
      metadata: { ...exactPolicy.metadata, name: `${exactPolicy.metadata.name}-malformed` },
    },
    { ...structuredClone(exactPolicy), spec: { ...exactPolicy.spec, podSelector: {} } },
    {
      ...structuredClone(exactPolicy),
      spec: { ...exactPolicy.spec, egress: [...(exactPolicy.spec.egress as unknown[]), {}] },
    },
  ];
  for (const object of malformed) {
    if (await ports.dryRunCreate(object)) fail('TENANT_POLICY_ADMISSION_PROOF_FAILED');
  }
}

export async function runTask1PrerequisiteOperator(
  context: Task1PrerequisiteContext,
  ports: Task1PrerequisiteCommandPorts,
): Promise<void> {
  if ((await ports.tokenReview()) !== context.request.migrationOperatorSubject)
    fail('TENANT_POLICY_SUBJECT_MISMATCH');
  await requireAdmission(context, 'network', ports);
  if (context.request.stage === 'workload') {
    await requireReadyDeployment(context, ports);
    await requireAdmission(context, 'workload', ports);
  }
  await validateServices(context, ports);
  const pem = await ports.readPublicCertificate(
    context.request.namespace,
    context.publicCertificateSecret,
    context.publicCertificateKey,
  );
  ports.verifyPublicCertificate(
    pem,
    context.projection.value.apiProof.spkiSha256,
    context.projection.value.apiProof.dnsSan,
  );
  const policies = renderTask1StablePolicies(context);
  if (context.request.stage === 'network') await proveAdmissionEnforcement(policies, ports);
  await ensureCreateOnly(policies, ports);
}

function resourceForKind(kind: string): string {
  const resources: Record<string, string> = {
    ValidatingAdmissionPolicy: 'validatingadmissionpolicies.admissionregistration.k8s.io',
    ValidatingAdmissionPolicyBinding:
      'validatingadmissionpolicybindings.admissionregistration.k8s.io',
    NetworkPolicy: 'networkpolicies.networking.k8s.io',
    Deployment: 'deployments.apps',
    Service: 'services',
    Secret: 'secrets',
  };
  return resources[kind] ?? fail('TENANT_POLICY_KUBERNETES_RESOURCE_INVALID');
}

async function kubectl(args: readonly string[], stdin?: string): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = execFile(
      'kubectl',
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          rejectCommand(new Error('TENANT_POLICY_KUBERNETES_COMMAND_FAILED'));
          return;
        }
        resolveCommand(stdout);
      },
    );
    child.stdin?.end(stdin);
  });
}

export function verifyTask1PublicCertificate(
  pem: string,
  expectedSpkiSha256: string,
  expectedDnsSan: string,
): void {
  try {
    const certificate = new X509Certificate(pem);
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const actual = createHash('sha256').update(spki).digest('hex');
    if (
      actual !== expectedSpkiSha256 ||
      certificate.checkHost(expectedDnsSan, { wildcards: false }) !== expectedDnsSan
    )
      fail('TENANT_POLICY_PUBLIC_CERTIFICATE_MISMATCH');
  } catch (error) {
    if (error instanceof Error && error.message === 'TENANT_POLICY_PUBLIC_CERTIFICATE_MISMATCH')
      throw error;
    fail('TENANT_POLICY_PUBLIC_CERTIFICATE_INVALID');
  }
}

export function createTask1KubectlPorts(
  runCommand: (args: readonly string[], stdin?: string) => Promise<string> = kubectl,
  readToken: () => Promise<string> = () =>
    readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8'),
): Task1PrerequisiteCommandPorts {
  return {
    async get(kind, objectName, namespace) {
      const args = [
        'get',
        resourceForKind(kind),
        objectName,
        '--output',
        'json',
        '--ignore-not-found',
      ];
      if (namespace) args.push('--namespace', namespace);
      const output = await runCommand(args);
      if (!output.trim()) return null;
      return JSON.parse(output) as Task1KubernetesObject;
    },
    async create(object) {
      return JSON.parse(
        await runCommand(
          ['create', '--filename', '-', '--output', 'json'],
          `${canonicalBootstrapJson(object)}\n`,
        ),
      ) as Task1KubernetesObject;
    },
    async tokenReview() {
      const token = await readToken();
      const review = JSON.parse(
        await runCommand(
          ['create', '--filename', '-', '--output', 'json'],
          canonicalBootstrapJson({
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenReview',
            spec: { token: token.trim() },
          }) + '\n',
        ),
      ) as Record<string, unknown>;
      const status = record(review.status);
      const user = record(status.user);
      if (status.authenticated !== true) fail('TENANT_POLICY_TOKEN_REVIEW_FAILED');
      return string(user.username);
    },
    async canI(verb, resource, objectName) {
      const args = ['auth', 'can-i', verb, resource];
      if (objectName) args.push('--resource-name', objectName);
      return (await runCommand(args)).trim() === 'yes';
    },
    async dryRunCreate(object) {
      try {
        await runCommand(
          ['create', '--filename', '-', '--dry-run=server', '--output', 'name'],
          `${canonicalBootstrapJson(object)}\n`,
        );
        return true;
      } catch {
        return false;
      }
    },
    async readPublicCertificate(namespace, secretName, key) {
      const secret = await this.get('Secret', secretName, namespace);
      const encoded = secret?.data?.[key];
      if (
        !encoded ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
        Buffer.from(encoded, 'base64').toString('base64') !== encoded
      )
        fail('TENANT_POLICY_PUBLIC_CERTIFICATE_INVALID');
      return Buffer.from(encoded, 'base64').toString('utf8');
    },
    verifyPublicCertificate: verifyTask1PublicCertificate,
  };
}

export async function loadTask1PrerequisiteCommandContext(
  args: readonly string[],
  cwd: string,
): Promise<Task1PrerequisiteContext> {
  const request = parseTask1PrerequisiteCommandArgs(args, cwd);
  const values = await readFile(request.valuesPath, 'utf8').catch(() =>
    fail('TENANT_POLICY_VALUES_UNREADABLE'),
  );
  return loadTask1PrerequisiteContext(
    request,
    values,
    verifyChartContentDigest(resolve(cwd, 'deploy/helm/commander')),
  );
}
