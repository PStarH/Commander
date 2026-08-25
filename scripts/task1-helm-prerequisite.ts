import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  canonicalBootstrapJson,
  canonicalBootstrapSha256,
} from '../packages/kernel/src/canonicalBootstrap.js';

const ROLES = ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops'] as const;
type Role = (typeof ROLES)[number];
type Selector = Record<string, string>;

export type Task1DatabaseEndpoint =
  | {
      roles: Role[];
      cidr: { cidr: string; port: number };
      service?: never;
    }
  | {
      roles: Role[];
      service: {
        namespace: string;
        name: string;
        servicePort: number;
        targetPort: number;
        podSelector: Selector;
      };
      cidr?: never;
    };

export interface Task1PrerequisiteInput {
  namespace: string;
  releaseName: string;
  clusterDomain: string;
  migrationOperatorSubject: string;
  clusterDns: { namespace: string; podSelector: Selector };
  databaseEndpoints: Task1DatabaseEndpoint[];
  apiProof: {
    serviceName: string;
    servicePort: number;
    targetPort: number;
    podSelector: Selector;
    dnsSan: string;
    spkiSha256: string;
  };
}

type NormalizedEndpoint =
  | { roles: Role[]; kind: 'cidr'; cidr: string; port: number }
  | {
      roles: Role[];
      kind: 'service';
      namespace: string;
      name: string;
      servicePort: number;
      targetPort: number;
      podSelector: Selector;
    };

interface Task1NormalizedStablePolicy {
  namespace: string;
  name: string;
  labels: Selector;
  spec: Record<string, unknown>;
  specSha256: string;
}

interface Task1NormalizedAdmissionGuard {
  stage: 'network' | 'workload';
  name: string;
  policySpec: Record<string, unknown>;
  policySpecSha256: string;
  bindingSpec: Record<string, unknown>;
  bindingSpecSha256: string;
}

interface Task1StablePolicyNames {
  egress: string;
  databaseIngress: Array<{
    namespace: string;
    name: string;
    serviceName: string;
    targetPort: number;
  }>;
  apiProofIngress: string;
}

export interface Task1PrerequisitePolicyConfig {
  format: 'prerequisite-policy-config/v1';
  namespace: string;
  releaseName: string;
  migrationOperatorSubject: string;
  clusterDns: { namespace: string; podSelector: Selector };
  databaseEndpoints: NormalizedEndpoint[];
  apiProof: Task1PrerequisiteInput['apiProof'];
  stablePolicies: Task1NormalizedStablePolicy[];
  admissionGuards: Task1NormalizedAdmissionGuard[];
  /** Compatibility view for renderers; deliberately excluded from the canonical projection. */
  stablePolicyNames: Task1StablePolicyNames;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_KEY =
  /^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/;

function invalid(): never {
  throw new Error('TENANT_POLICY_ENDPOINT_INVALID');
}
function name(value: string): string {
  if (!DNS_LABEL.test(value)) invalid();
  return value;
}
function port(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) invalid();
  return value;
}
function selector(value: Selector): Selector {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (
    entries.length === 0 ||
    entries.some(([key, item]) => !LABEL_KEY.test(key) || !LABEL_VALUE.test(item))
  )
    invalid();
  return Object.fromEntries(entries);
}
function hashPrefix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}
function hash16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}
function normalizedRoles(values: readonly Role[]): Role[] {
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((role) => !ROLES.includes(role))
  )
    invalid();
  return [...values].sort();
}
function normalizeEndpoint(endpoint: Task1DatabaseEndpoint): NormalizedEndpoint {
  const roles = normalizedRoles(endpoint.roles);
  if (endpoint.cidr && !endpoint.service) {
    const slash = endpoint.cidr.cidr.lastIndexOf('/');
    const address = endpoint.cidr.cidr.slice(0, slash);
    const prefix = endpoint.cidr.cidr.slice(slash + 1);
    const version = isIP(address);
    if ((version === 4 && prefix !== '32') || (version === 6 && prefix !== '128') || version === 0)
      invalid();
    return {
      roles,
      kind: 'cidr',
      cidr: endpoint.cidr.cidr.toLowerCase(),
      port: port(endpoint.cidr.port),
    };
  }
  if (endpoint.service && !endpoint.cidr) {
    return {
      roles,
      kind: 'service',
      namespace: name(endpoint.service.namespace),
      name: name(endpoint.service.name),
      servicePort: port(endpoint.service.servicePort),
      targetPort: port(endpoint.service.targetPort),
      podSelector: selector(endpoint.service.podSelector),
    };
  }
  return invalid();
}

export function task1StablePolicyNames(
  namespace: string,
  releaseName: string,
  config: Pick<Task1PrerequisitePolicyConfig, 'databaseEndpoints' | 'apiProof'>,
): Task1PrerequisitePolicyConfig['stablePolicyNames'] {
  const egress = `commander-mig-${hashPrefix(`egress\0${namespace}\0${releaseName}`)}-egress`;
  const serviceTuples = new Map<string, Extract<NormalizedEndpoint, { kind: 'service' }>>();
  for (const endpoint of config.databaseEndpoints) {
    if (endpoint.kind !== 'service') continue;
    const key = canonicalBootstrapJson({
      namespace: endpoint.namespace,
      name: endpoint.name,
      targetPort: endpoint.targetPort,
    });
    const prior = serviceTuples.get(key);
    if (
      prior &&
      canonicalBootstrapJson(prior.podSelector) !== canonicalBootstrapJson(endpoint.podSelector)
    )
      invalid();
    serviceTuples.set(key, endpoint);
  }
  const databaseIngress = [...serviceTuples.values()]
    .map((endpoint) => ({
      namespace: endpoint.namespace,
      name: `commander-mig-${hashPrefix(`ingress\0${namespace}\0${releaseName}\0${endpoint.namespace}\0${endpoint.name}\0${endpoint.targetPort}`)}-ingress`,
      serviceName: endpoint.name,
      targetPort: endpoint.targetPort,
    }))
    .sort((left, right) =>
      `${left.namespace}/${left.name}`.localeCompare(`${right.namespace}/${right.name}`),
    );
  const apiProofIngress = `commander-mig-${hashPrefix(`api-proof-ingress\0${namespace}\0${releaseName}\0${config.apiProof.serviceName}\0${config.apiProof.targetPort}`)}-ingress`;
  return { egress, databaseIngress, apiProofIngress };
}

function hookLabels(namespace: string, releaseName: string): Selector {
  return {
    'app.kubernetes.io/instance': releaseName,
    'app.kubernetes.io/name': releaseName,
    'commander.io/migration-client-v2': 'true',
    'commander.io/migration-release': releaseName,
  };
}

function policyLabels(purpose: string): Selector {
  return {
    'app.kubernetes.io/managed-by': 'commander-operator',
    'commander.io/purpose': purpose,
  };
}

function peer(namespace: string, podSelector: Selector): Record<string, unknown> {
  return {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
    podSelector: { matchLabels: podSelector },
  };
}

function normalizedPolicy(
  namespace: string,
  nameValue: string,
  purpose: string,
  spec: Record<string, unknown>,
): Task1NormalizedStablePolicy {
  return {
    namespace,
    name: nameValue,
    labels: policyLabels(purpose),
    spec,
    specSha256: canonicalBootstrapSha256(spec),
  };
}

function createStablePolicies(
  namespace: string,
  releaseName: string,
  clusterDns: { namespace: string; podSelector: Selector },
  databaseEndpoints: NormalizedEndpoint[],
  apiProof: Task1PrerequisiteInput['apiProof'],
  names: Task1StablePolicyNames,
): Task1NormalizedStablePolicy[] {
  const labels = hookLabels(namespace, releaseName);
  const egress: Array<Record<string, unknown>> = [
    {
      to: [peer(clusterDns.namespace, clusterDns.podSelector)],
      ports: [
        { protocol: 'TCP', port: 53 },
        { protocol: 'UDP', port: 53 },
      ],
    },
    {
      to: [peer(namespace, apiProof.podSelector)],
      ports: [{ protocol: 'TCP', port: apiProof.targetPort }],
    },
  ];
  for (const endpoint of databaseEndpoints) {
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
  const policies = [
    normalizedPolicy(namespace, names.egress, 'migration-egress', {
      podSelector: { matchLabels: labels },
      policyTypes: ['Egress'],
      egress,
    }),
    normalizedPolicy(namespace, names.apiProofIngress, 'api-proof-migration-ingress', {
      podSelector: { matchLabels: apiProof.podSelector },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [peer(namespace, labels)],
          ports: [{ protocol: 'TCP', port: apiProof.targetPort }],
        },
      ],
    }),
  ];
  for (const stable of names.databaseIngress) {
    const endpoint = databaseEndpoints.find(
      (candidate) =>
        candidate.kind === 'service' &&
        candidate.namespace === stable.namespace &&
        candidate.name === stable.serviceName &&
        candidate.targetPort === stable.targetPort,
    );
    if (!endpoint || endpoint.kind !== 'service') invalid();
    policies.push(
      normalizedPolicy(stable.namespace, stable.name, 'database-migration-ingress', {
        podSelector: { matchLabels: endpoint.podSelector },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [peer(namespace, labels)],
            ports: [{ protocol: 'TCP', port: stable.targetPort }],
          },
        ],
      }),
    );
  }
  return policies.sort((left, right) =>
    canonicalBootstrapJson([left.namespace, left.name]).localeCompare(
      canonicalBootstrapJson([right.namespace, right.name]),
    ),
  );
}

export const TASK1_SELECTOR_CAN_MATCH_H_CEL =
  "variables.selectorRequirements.all(r, r.key in variables.hookLabels ? (r.operator == 'In' ? variables.hookLabels[r.key] in r.values : r.operator == 'NotIn' ? !(variables.hookLabels[r.key] in r.values) : r.operator == 'Exists' ? true : false) : r.key == variables.componentKey ? r.operator == 'DoesNotExist' : (!(r.operator == 'DoesNotExist' && variables.selectorRequirements.exists(o, o.key == r.key && o.operator != 'DoesNotExist')) && (r.operator != 'In' || r.values.exists(v, variables.selectorRequirements.all(o, o.key != r.key || (o.operator == 'In' ? v in o.values : o.operator == 'NotIn' ? !(v in o.values) : o.operator == 'Exists' ? true : false)))))" +
  ')';

export const TASK1_SELECTOR_REQUIREMENTS_CEL =
  "request.resource.resource != 'networkpolicies' ? [] : (has(object.spec.podSelector.matchLabels) ? object.spec.podSelector.matchLabels.map(k, {'key': dyn(k), 'operator': dyn('In'), 'values': dyn([object.spec.podSelector.matchLabels[k]])}) : []) + (has(object.spec.podSelector.matchExpressions) ? object.spec.podSelector.matchExpressions : [])";

export function task1CelDynLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value))
    return '[' + value.map((item) => 'dyn(' + task1CelDynLiteral(item) + ')').join(',') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ':dyn(' + task1CelDynLiteral(item) + ')')
        .join(',') +
      '}'
    );
  return invalid();
}

function networkGuardValidations(
  migrationOperatorSubject: string,
  labels: Selector,
  policies: Task1NormalizedStablePolicy[],
): Array<Record<string, string>> {
  const allowed = policies.map(({ namespace, name: policyName, labels: policyLabelSet, spec }) => ({
    namespace,
    name: policyName,
    labels: policyLabelSet,
    spec,
  }));
  const allowedCel = task1CelDynLiteral(allowed);
  const operator = migrationOperatorSubject.replaceAll("'", "\\'");
  const protectedNames = policies.map((policy) => `'${policy.name}'`).join(',');
  const fixed = Object.entries(labels)
    .map(([key, value]) => `object.metadata.labels['${key}'] == '${value}'`)
    .join(' && ');
  const oldFixed = Object.entries(labels)
    .map(([key, value]) => `oldObject.metadata.labels['${key}'] == '${value}'`)
    .join(' && ');
  return [
    {
      expression: `request.resource.resource != 'networkpolicies' || request.operation == 'CREATE' || !(object.metadata.name in [${protectedNames}])`,
      message: 'protected stable policies are create-only',
    },
    {
      expression:
        "request.resource.resource != 'networkpolicies' || request.userInfo.username != '" +
        operator +
        "' || (request.operation == 'CREATE' && " +
        allowedCel +
        '.exists(p, p.namespace == object.metadata.namespace && p.name == object.metadata.name && p.labels == object.metadata.labels && p.spec == object.spec))',
      message: 'migration operator may create only an exact rendered stable policy',
    },
    {
      expression:
        "request.resource.resource != 'networkpolicies' || request.userInfo.username == '" +
        operator +
        "' || request.operation == 'DELETE' || !has(dyn(object).spec.egress) || size(dyn(object).spec.egress) == 0 || !(" +
        TASK1_SELECTOR_CAN_MATCH_H_CEL +
        ')',
      message: 'non-operator NetworkPolicy must not add egress to a protected hook selector',
    },
    {
      expression: `request.resource.resource != 'pods' || request.operation != 'CREATE' || !(${fixed}) || !('app.kubernetes.io/component' in object.metadata.labels)`,
      message: 'migration hook Pods may not carry the legacy component label',
    },
    {
      expression: `request.resource.resource != 'pods' || request.operation != 'UPDATE' || !(${oldFixed}) || ((${fixed}) && !('app.kubernetes.io/component' in object.metadata.labels))`,
      message: 'migration hook Pod labels are immutable',
    },
  ];
}

function workloadGuardValidations(releaseName: string): Array<Record<string, string>> {
  const release = releaseName.replaceAll("'", "\\'");
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

function createAdmissionGuard(
  stage: 'network' | 'workload',
  namespace: string,
  releaseName: string,
  migrationOperatorSubject: string,
  databaseEndpoints: NormalizedEndpoint[],
  stablePolicies: Task1NormalizedStablePolicy[],
): Task1NormalizedAdmissionGuard {
  const labels = hookLabels(namespace, releaseName);
  const guardName =
    stage === 'network'
      ? `commander-tenant-authority-policy-guard-${hash16(`${namespace}/${releaseName}`)}`
      : `commander-tenant-authority-guard-${hash16(`${namespace}/${releaseName}`)}`;
  const policySpec: Record<string, unknown> = {
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
                scope: '*',
              },
              {
                apiGroups: [''],
                apiVersions: ['v1'],
                operations: ['CREATE', 'UPDATE'],
                resources: ['pods'],
                scope: '*',
              },
            ]
          : [
              {
                apiGroups: ['apps'],
                apiVersions: ['v1'],
                operations: ['CREATE', 'UPDATE'],
                resources: ['deployments', 'statefulsets'],
                scope: '*',
              },
            ],
      matchPolicy: 'Equivalent',
      namespaceSelector: {},
      objectSelector: {},
    },
    ...(stage === 'network'
      ? {
          variables: [
            { name: 'hookLabels', expression: canonicalBootstrapJson(labels) },
            { name: 'componentKey', expression: "'app.kubernetes.io/component'" },
            {
              name: 'selectorRequirements',
              expression: TASK1_SELECTOR_REQUIREMENTS_CEL,
            },
          ],
        }
      : {}),
    validations:
      stage === 'network'
        ? networkGuardValidations(migrationOperatorSubject, labels, stablePolicies)
        : workloadGuardValidations(releaseName),
  };
  const namespaces = [
    ...new Set([
      namespace,
      ...databaseEndpoints
        .filter(
          (endpoint): endpoint is Extract<NormalizedEndpoint, { kind: 'service' }> =>
            endpoint.kind === 'service',
        )
        .map((endpoint) => endpoint.namespace),
    ]),
  ].sort();
  const bindingSpec: Record<string, unknown> = {
    policyName: guardName,
    validationActions: ['Deny'],
    matchResources: {
      matchPolicy: 'Equivalent',
      namespaceSelector:
        stage === 'network'
          ? {
              matchExpressions: [
                {
                  key: 'kubernetes.io/metadata.name',
                  operator: 'In',
                  values: namespaces,
                },
              ],
            }
          : { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
      objectSelector: {},
    },
  };
  return {
    stage,
    name: guardName,
    policySpec,
    policySpecSha256: canonicalBootstrapSha256(policySpec),
    bindingSpec,
    bindingSpecSha256: canonicalBootstrapSha256(bindingSpec),
  };
}

export function createTask1PrerequisitePolicyConfig(input: Task1PrerequisiteInput): {
  value: Task1PrerequisitePolicyConfig;
  jcs: string;
  sha256: string;
} {
  const namespace = name(input.namespace);
  const releaseName = name(input.releaseName);
  if (!DNS_SUBDOMAIN.test(input.clusterDomain)) invalid();
  const subject = /^system:serviceaccount:([^:]+):([^:]+)$/.exec(input.migrationOperatorSubject);
  if (!subject || name(subject[1]!) !== subject[1] || name(subject[2]!) !== subject[2]) invalid();
  const databaseEndpoints = input.databaseEndpoints
    .map(normalizeEndpoint)
    .sort((left, right) =>
      canonicalBootstrapJson(left).localeCompare(canonicalBootstrapJson(right)),
    );
  const covered = new Set(databaseEndpoints.flatMap((endpoint) => endpoint.roles));
  if (ROLES.some((role) => !covered.has(role))) invalid();
  const apiProof = {
    serviceName: name(input.apiProof.serviceName),
    servicePort: port(input.apiProof.servicePort),
    targetPort: port(input.apiProof.targetPort),
    podSelector: selector(input.apiProof.podSelector),
    dnsSan: input.apiProof.dnsSan,
    spkiSha256: input.apiProof.spkiSha256,
  };
  const expectedDns = `${apiProof.serviceName}.${namespace}.svc.${input.clusterDomain}`;
  if (apiProof.dnsSan !== expectedDns || !/^[0-9a-f]{64}$/.test(apiProof.spkiSha256)) invalid();
  const clusterDns = {
    namespace: name(input.clusterDns.namespace),
    podSelector: selector(input.clusterDns.podSelector),
  };
  const stablePolicyNames = task1StablePolicyNames(namespace, releaseName, {
    databaseEndpoints,
    apiProof,
  });
  const stablePolicies = createStablePolicies(
    namespace,
    releaseName,
    clusterDns,
    databaseEndpoints,
    apiProof,
    stablePolicyNames,
  );
  const serializable = {
    format: 'prerequisite-policy-config/v1',
    namespace,
    releaseName,
    migrationOperatorSubject: input.migrationOperatorSubject,
    clusterDns,
    databaseEndpoints,
    apiProof,
    stablePolicies,
    admissionGuards: [
      createAdmissionGuard(
        'network',
        namespace,
        releaseName,
        input.migrationOperatorSubject,
        databaseEndpoints,
        stablePolicies,
      ),
      createAdmissionGuard(
        'workload',
        namespace,
        releaseName,
        input.migrationOperatorSubject,
        databaseEndpoints,
        stablePolicies,
      ),
    ],
  };
  const value = new Proxy(serializable as Task1PrerequisitePolicyConfig, {
    get(target, property, receiver) {
      if (property === 'stablePolicyNames') return stablePolicyNames;
      return Reflect.get(target, property, receiver);
    },
  });
  const jcs = canonicalBootstrapJson(value);
  return { value, jcs, sha256: canonicalBootstrapSha256(value) };
}
