import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAll } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Manifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  spec?: Record<string, unknown>;
};

const allRoles = ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops'];

function render(upgrade = false, extraArgs: string[] = [], release = 'lifecycle-demo'): string {
  return execFileSync(
    'helm',
    [
      'template',
      release,
      'deploy/helm/commander',
      '-f',
      'deploy/helm/commander/values-demo.yaml',
      '--set',
      `image.digest=sha256:${'a'.repeat(64)}`,
      '--set',
      `tenantAuthority.configurationSha256=${'b'.repeat(64)}`,
      '--set',
      'databaseTls.existingSecret=database-server-tls',
      '--set',
      'tenantAuthority.apiProof.publicSecret=api-proof-public',
      '--set',
      'tenantAuthority.apiProof.privateSecret=api-proof-private',
      '--set',
      'tenantAuthority.proofOwnerSecret=lifecycle-demo-proof-owner-r1',
      '--set',
      'tenantAuthority.releaseProjectionConfigMap=lifecycle-demo-release-projection-r1',
      ...extraArgs,
      ...(upgrade ? ['--is-upgrade'] : []),
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function manifests(rendered: string): Manifest[] {
  return loadAll(rendered, undefined, { json: true }).filter(
    (value): value is Manifest => typeof value === 'object' && value !== null,
  );
}

function manifest(rendered: string, kind: string, name: string): Manifest {
  const value = manifests(rendered).find(
    (candidate) => candidate.kind === kind && candidate.metadata?.name === name,
  );
  assert.ok(value, `${kind}/${name} missing`);
  return value;
}

function stablePolicyName(prefix: string, suffix: string): string {
  return `commander-mig-${createHash('sha256').update(prefix).digest('hex').slice(0, 24)}-${suffix}`;
}

function proofReaderName(namespace = 'default', release = 'lifecycle-demo'): string {
  const suffix = createHash('sha256').update(`${namespace}/${release}`).digest('hex').slice(0, 16);
  return `commander-proof-reader-${suffix}`;
}

function deployment(rendered: string, component: string): string {
  const document = rendered
    .split(/^---\s*$/m)
    .find(
      (candidate) =>
        /^kind: Deployment$/m.test(candidate) &&
        new RegExp(`app\\.kubernetes\\.io/component: ${component}`).test(candidate),
    );
  assert.ok(document, `${component} Deployment missing`);
  return document;
}

function resource(rendered: string, kind: string, name: string): string {
  const document = rendered
    .split(/^---\s*$/m)
    .find(
      (candidate) =>
        new RegExp(`^kind: ${kind}$`, 'm').test(candidate) &&
        new RegExp(`^  name: ${name}$`, 'm').test(candidate),
    );
  assert.ok(document, `${kind}/${name} missing`);
  return document;
}

describe('Helm lifecycle static contract', () => {
  it('keeps API file stores on the writable tmp volume', () => {
    const apiDeployments = [
      deployment(render(), 'api'),
      deployment(
        render(false, [
          '--set',
          'database.enabled=false',
          '--set',
          'database.backend=sqlite',
          '--set',
          'database.postgres.bundled=false',
        ]),
        'api',
      ),
    ];
    for (const api of apiDeployments) {
      assert.match(api, /- name: COMMANDER_WARROOM_FILE\n\s+value: \/tmp\/commander-api\/war-room.json/);
      assert.match(api, /- name: COMMANDER_AGENT_STATE_FILE\n\s+value: \/tmp\/commander-api\/agent-state.json/);
      assert.match(
        api,
        /- name: COMMANDER_ACTION_RATIONALE_FILE\n\s+value: \/tmp\/commander-api\/action-rationales.json/,
      );
      assert.match(
        api,
        /- name: API_RATE_LIMIT_DB_PATH\n\s+value: \/tmp\/commander-api\/rate-limit.sqlite/,
      );
      assert.match(api, /- name: COMMANDER_TRACE_DIR\n\s+value: \/tmp\/commander-api\/traces/);
      assert.match(api, /- name: tmp\n\s+mountPath: \/tmp/);
      assert.match(
        api,
        /- name: api-runtime-state\n\s+image:.*\n\s+imagePullPolicy:.*\n\s+command: \["node", "-e"\][\s\S]*\/tmp\/commander-api[\s\S]*runAsUser: 0[\s\S]*- name: tmp\n\s+mountPath: \/tmp/,
      );
      assert.match(
        api,
        /startupProbe:[\s\S]*path: \/health[\s\S]*port: http[\s\S]*failureThreshold: 30[\s\S]*periodSeconds: 2/,
      );
    }
  });

  it('does not bind authentication-failure authority to Redis', () => {
    const api = deployment(render(false, ['--set', 'redis.enabled=true']), 'api');
    assert.match(api, /- name: REDIS_URL\n\s+value: redis:\/\/lifecycle-demo-redis:6379/);
    assert.doesNotMatch(api, /AUTH_FAILURE_REDIS_URL/);
  });

  it('uses a local TCP readiness probe for the non-authoritative Redis cache', () => {
    const redis = resource(render(false, ['--set', 'redis.enabled=true']), 'StatefulSet', 'lifecycle-demo-redis');
    assert.match(redis, /readinessProbe:\n\s+tcpSocket:\n\s+port: redis/);
    assert.doesNotMatch(redis, /redis-cli/);
  });

  it('limits controller transport bootstrap to the three bundled PostgreSQL objects', () => {
    const rendered = render(false, [
      '--set',
      'database.postgres.existingSecret=lifecycle-demo-database-bootstrap',
      '--set',
      'tenantAuthority.transportBootstrap=true',
    ]);
    assert.deepEqual(
      manifests(rendered)
        .map((value) => `${value.kind}/${value.metadata?.name}`)
        .sort(),
      [
        'ConfigMap/lifecycle-demo-database-init',
        'Service/lifecycle-demo-postgres',
        'StatefulSet/lifecycle-demo-postgres',
      ],
    );
    assert.match(resource(rendered, 'ConfigMap', 'lifecycle-demo-database-init'), /DO \\\$\\\$/);
    assert.throws(
      () =>
        render(false, [
          '--set',
          'database.postgres.bundled=false',
          '--set',
          'database.postgres.existingSecret=external-database',
          '--set',
          'databaseTls.existingSecret=',
          '--set',
          'databaseTls.caSecret=external-ca',
          '--set',
          'tenantAuthority.transportBootstrap=true',
        ]),
      /tenantAuthority\.transportBootstrap requires bundled PostgreSQL/,
    );
  });

  it('runs bundled PostgreSQL with verify-full DSNs and a server-only TLS key mount', () => {
    const rendered = render(false, ['--set', 'databaseTls.existingSecret=database-server-tls']);
    const databaseSecret = manifest(rendered, 'Secret', 'lifecycle-demo-database');
    for (const key of [
      'owner-url',
      'app-url',
      'tenant-authority-url',
      'scheduler-url',
      'worker-url',
      'adapter-ops-url',
    ]) {
      const encoded = databaseSecret.data?.[key];
      assert.ok(encoded, `${key} missing`);
      const dsn = new URL(Buffer.from(encoded, 'base64').toString('utf8'));
      assert.equal(dsn.searchParams.get('sslmode'), 'verify-full');
    }
    const postgres = resource(rendered, 'StatefulSet', 'lifecycle-demo-postgres');
    assert.match(postgres, /ssl=on/);
    assert.match(postgres, /commander\.io\/database-transport-content-sha256: "[0-9a-f]{64}"/);
    assert.match(postgres, /ssl_ca_file=\/run\/commander\/database-tls\/ca\.crt/);
    assert.match(postgres, /ssl_cert_file=\/run\/commander\/database-tls\/tls\.crt/);
    assert.match(postgres, /ssl_key_file=\/run\/commander\/database-tls\/tls\.key/);
    assert.match(postgres, /secretName: "database-server-tls"/);
    assert.match(postgres, /key: "?tls\.key"?/);
    for (const document of rendered.split(/^---\s*$/m)) {
      if (!/^kind: StatefulSet$/m.test(document))
        assert.doesNotMatch(document, /database-server-tls[\s\S]*tls\.key/);
    }
  });

  it('uses revision-safe pre-hooks and never a post-install migration Job', () => {
    const rendered = render(true);
    const migration = resource(rendered, 'Job', 'lifecycle-demo-migration-r1');
    assert.match(migration, /helm\.sh\/hook: pre-install,pre-upgrade,pre-rollback/);
    assert.match(migration, /helm\.sh\/hook-weight: "-10"/);
    assert.doesNotMatch(migration, /helm\.sh\/hook: post-install,post-upgrade/);
    const migrationObject = manifest(rendered, 'Job', 'lifecycle-demo-migration-r1');
    const template = (migrationObject.spec?.template ?? {}) as {
      metadata?: { labels?: Record<string, string> };
    };
    assert.deepEqual(template.metadata?.labels, {
      'app.kubernetes.io/name': 'lifecycle-demo',
      'app.kubernetes.io/instance': 'lifecycle-demo',
      'commander.io/migration-client-v2': 'true',
      'commander.io/migration-release': 'lifecycle-demo',
    });
    assert.doesNotMatch(rendered, /name: wait-for-postgres/);
  });

  it('renders role-scoped endpoint egress while leaving stable policies operator-owned', () => {
    const databaseEndpoints = [
      {
        roles: ['owner'],
        service: {
          namespace: 'database',
          name: 'owner-proxy',
          servicePort: 15432,
          targetPort: 15433,
          podSelector: { app: 'database-proxy', shard: 'owner' },
        },
      },
      { roles: ['app', 'tenant-authority'], cidr: { cidr: '10.0.0.2/32', port: 25432 } },
      { roles: ['scheduler'], cidr: { cidr: '2001:db8::1/128', port: 35432 } },
      { roles: ['worker'], cidr: { cidr: '10.0.0.4/32', port: 45432 } },
      { roles: ['adapter-ops'], cidr: { cidr: '10.0.0.5/32', port: 55432 } },
    ];
    const rendered = render(false, [
      '--set-json',
      `networkPolicy.databaseEndpoints=${JSON.stringify(databaseEndpoints)}`,
    ]);

    const endpointPorts = new Set([15433, 25432, 35432, 45432, 55432]);
    const databasePorts = (policyName: string): number[] => {
      const policy = manifest(rendered, 'NetworkPolicy', policyName);
      const egress = (policy.spec?.egress ?? []) as Array<{ ports?: Array<{ port?: number }> }>;
      return egress
        .flatMap((rule) => rule.ports ?? [])
        .map((entry) => entry.port)
        .filter((port): port is number => typeof port === 'number' && endpointPorts.has(port))
        .sort((left, right) => left - right);
    };

    assert.deepEqual(databasePorts('lifecycle-demo-api-egress'), [25432]);
    assert.deepEqual(databasePorts('lifecycle-demo-worker-egress'), [45432]);
    assert.deepEqual(databasePorts('lifecycle-demo-kernel-ops-egress'), [35432]);
    assert.deepEqual(databasePorts('lifecycle-demo-adapter-ops-egress'), [55432]);
    assert.deepEqual(databasePorts('lifecycle-demo-tenant-cutover-prove'), [15433]);
    assert.deepEqual(
      databasePorts('lifecycle-demo-migration-egress'),
      [15433, 25432, 35432, 45432, 55432],
    );

    const ownerRule = (
      (manifest(rendered, 'NetworkPolicy', 'lifecycle-demo-migration-egress').spec?.egress ??
        []) as Array<{
        to?: unknown;
        ports?: Array<{ port?: number }>;
      }>
    ).find((rule) => rule.ports?.some((entry) => entry.port === 15433));
    assert.deepEqual(ownerRule, {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'database' } },
          podSelector: { matchLabels: { app: 'database-proxy', shard: 'owner' } },
        },
      ],
      ports: [{ protocol: 'TCP', port: 15433 }],
    });

    const oldMigrationPolicy = manifest(
      rendered,
      'NetworkPolicy',
      'lifecycle-demo-migration-egress',
    );
    const oldSelector = (
      oldMigrationPolicy.spec?.podSelector as { matchLabels?: Record<string, string> }
    ).matchLabels;
    assert.deepEqual(oldSelector, {
      'app.kubernetes.io/name': 'lifecycle-demo',
      'app.kubernetes.io/instance': 'lifecycle-demo',
      'app.kubernetes.io/component': 'migration',
    });
    const hookLabels = {
      'app.kubernetes.io/name': 'lifecycle-demo',
      'app.kubernetes.io/instance': 'lifecycle-demo',
      'commander.io/migration-client-v2': 'true',
      'commander.io/migration-release': 'lifecycle-demo',
    };
    assert.equal(
      Object.entries(oldSelector ?? {}).every(
        ([key, value]) => hookLabels[key as keyof typeof hookLabels] === value,
      ),
      false,
    );

    const stableNames = [
      stablePolicyName('egress\0default\0lifecycle-demo', 'egress'),
      stablePolicyName(
        `ingress\0default\0lifecycle-demo\0database\0owner-proxy\0${15433}`,
        'ingress',
      ),
      stablePolicyName(
        `api-proof-ingress\0default\0lifecycle-demo\0lifecycle-demo-api-proof\0${9443}`,
        'ingress',
      ),
    ];
    const renderedNames = new Set(manifests(rendered).map((value) => value.metadata?.name));
    for (const name of stableNames)
      assert.equal(renderedNames.has(name), false, `${name} must remain operator-owned`);
  });

  it('rejects incomplete or ambiguous database endpoint values at schema validation', () => {
    const invalidEndpoints = [
      [{ roles: ['owner'], cidr: { cidr: '10.0.0.1/32', port: 5432 } }],
      [{ roles: allRoles, cidr: { cidr: '10.0.0.0/24', port: 5432 } }],
      [{ roles: allRoles, cidr: { cidr: '999.0.0.1/32', port: 5432 } }],
      [{ roles: allRoles, hostname: { host: 'database.example.com', port: 5432 } }],
      [
        {
          roles: allRoles,
          service: {
            namespace: 'default',
            name: 'postgres',
            servicePort: '5432',
            targetPort: 5432,
            podSelector: { app: 'postgres' },
          },
        },
      ],
      [
        {
          roles: allRoles,
          cidr: { cidr: '10.0.0.1/32', port: 5432 },
          service: {
            namespace: 'default',
            name: 'postgres',
            servicePort: 5432,
            targetPort: 5432,
            podSelector: { app: 'postgres' },
          },
        },
      ],
    ];
    for (const endpoints of invalidEndpoints) {
      assert.throws(
        () =>
          render(false, [
            '--set-json',
            `networkPolicy.databaseEndpoints=${JSON.stringify(endpoints)}`,
          ]),
        /values don't meet the specifications of the schema|TENANT_POLICY_ENDPOINT_INVALID/,
      );
    }
  });

  it('gates each runtime role with only its own DSN and keeps bootstrap authority job-only', () => {
    const rendered = render();
    const expected: Record<string, string> = {
      api: 'app-url',
      worker: 'worker-url',
      'kernel-ops': 'scheduler-url',
      'adapter-ops': 'adapter-ops-url',
    };
    for (const [component, key] of Object.entries(expected)) {
      const manifest = deployment(rendered, component);
      assert.match(manifest, /name: migration-gate/);
      assert.match(manifest, /migrationGate\.js[\s\S]*await/);
      assert.match(manifest, new RegExp(`key: ["']?${key}["']?`));
      assert.match(manifest, /COMMANDER_DATABASE_TLS_CA_FILE/);
      assert.match(manifest, /COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256/);
      assert.match(
        manifest,
        /name: database-public-ca[\s\S]*mountPath: \/run\/commander\/database-tls/,
      );
      assert.doesNotMatch(manifest, /owner-url|BOOTSTRAP_AUTHORITY/);
    }
  });

  it('serves the tenant-authority readiness proof through a private TLS mount', () => {
    const rendered = render();
    const api = deployment(rendered, 'api');
    assert.match(api, /commander\.io\/tenant-context-aware: "true"/);
    assert.match(api, /commander\.io\/tenant-authority-phase: "enforce"/);
    assert.match(api, /COMMANDER_TENANT_AUTHORITY_CONFIGURATION_SHA256/);
    assert.match(
      api,
      /COMMANDER_TENANT_AUTHORITY_PROOF_DNS_NAME[\s\S]*lifecycle-demo-api-proof\.default\.svc\.cluster\.local/,
    );
    assert.match(api, /containerPort: 9443/);
    assert.match(api, /name: api-proof-tls-materialize[\s\S]*COPYFILE_EXCL/);
    assert.match(api, /name: api-proof-private-source[\s\S]*readOnly: true/);
    assert.match(api, /name: api-proof-tls-runtime[\s\S]*emptyDir: \{\}/);
    assert.match(api, /\['tls\.crt', 0o444\][\s\S]*\['tls\.key', 0o400\]/);
    assert.match(api, /name: COMMANDER_TENANT_AUTHORITY_PROOF_PORT[\s\S]*value: "9443"/);
    assert.match(
      api,
      /name: COMMANDER_TENANT_AUTHORITY_PROOF_CERT_FILE[\s\S]*value: \/run\/commander\/api-proof\/tls\.crt/,
    );
    assert.match(
      api,
      /name: COMMANDER_TENANT_AUTHORITY_PROOF_KEY_FILE[\s\S]*value: \/run\/commander\/api-proof\/tls\.key/,
    );
    assert.match(rendered, /name: lifecycle-demo-api-proof/);
    assert.match(
      api,
      /readinessProbe:[\s\S]*command:[\s\S]*- node[\s\S]*127\.0\.0\.1[\s\S]*\/ready\/tenant-authority\/v1/,
    );
    assert.match(
      api,
      /name: api-proof-private[\s\S]*mountPath: \/run\/commander\/api-proof[\s\S]*readOnly: true/,
    );
    assert.match(
      api,
      /secretName: "api-proof-private"[\s\S]*key: "tls\.crt"[\s\S]*key: "tls\.key"/,
    );
  });

  it('gives the proof reader only the exact read-only topology permissions', () => {
    const rendered = render();
    const identity = proofReaderName();
    resource(rendered, 'ServiceAccount', identity);
    const role = resource(rendered, 'Role', identity);
    const binding = resource(rendered, 'RoleBinding', identity);

    assert.match(
      role,
      /apiGroups:\s*\["apps"\][\s\S]*resources:\s*\["deployments", "replicasets"\][\s\S]*verbs:\s*\["get", "list"\]/,
    );
    assert.match(
      role,
      /apiGroups:\s*\[""\][\s\S]*resources:\s*\["pods"\][\s\S]*verbs:\s*\["get", "list"\]/,
    );
    assert.match(
      role,
      /resources:\s*\["services"\][\s\S]*resourceNames:\s*\["lifecycle-demo-api-proof"\][\s\S]*verbs:\s*\["get"\]/,
    );
    assert.doesNotMatch(
      role,
      /secrets|tokenreviews|networkpolicies|validatingadmission|pods\/(?:exec|attach|log)|impersonate|watch|create|update|patch|delete|\*/i,
    );
    assert.match(
      binding,
      new RegExp(`name: ${identity}[\\s\\S]*kind: ServiceAccount[\\s\\S]*name: ${identity}`),
    );
    const otherIdentity = proofReaderName('default', 'other-release');
    assert.notEqual(otherIdentity, identity);
    resource(render(false, [], 'other-release'), 'ServiceAccount', otherIdentity);
  });

  it('runs contained tenant-cutover-prove only as an ephemeral post-rollout hook', () => {
    const rendered = render();
    const identity = proofReaderName();
    const prove = resource(rendered, 'Job', 'lifecycle-demo-tenant-cutover-prove-r1');
    assert.match(prove, /name: release-projection/);
    assert.match(prove, /mountPath: \/run\/commander\/release-projection/);
    assert.match(prove, /name: "?lifecycle-demo-release-projection-r1"?/);
    assert.match(prove, /key: projection\.json/);
    assert.match(prove, /path: projection\.json/);
    assert.match(prove, /helm\.sh\/hook: post-install,post-upgrade/);
    assert.match(prove, /helm\.sh\/hook-weight: "10"/);
    assert.match(prove, /helm\.sh\/hook-delete-policy: before-hook-creation,hook-succeeded/);
    assert.doesNotMatch(prove, /hook-failed/);
    assert.match(prove, new RegExp(`serviceAccountName: ${identity}`));
    assert.match(prove, /automountServiceAccountToken: false/);
    assert.match(prove, /name: COMMANDER_KUBERNETES_PROOF_RUNTIME[\s\S]*value: "1"/);
    assert.match(
      prove,
      /serviceAccountToken:[\s\S]*audience: commander-tenant-cutover-proof\/v1[\s\S]*expirationSeconds: 300[\s\S]*path: token/,
    );
    assert.match(
      prove,
      /configMap:[\s\S]*name: kube-root-ca\.crt[\s\S]*key: ca\.crt[\s\S]*path: ca\.crt/,
    );
    assert.match(
      prove,
      /name: proof-api-token[\s\S]*mountPath: \/var\/run\/secrets\/commander\.io\/proof-api[\s\S]*readOnly: true/,
    );
    assert.match(prove, /commander\.io\/tenant-authority-proof-reader: "true"/);
    assert.match(prove, /packages\/kernel\/dist\/migrate\.js", "tenant-cutover-prove"/);
    assert.match(prove, /name: "lifecycle-demo-proof-owner-r1"[\s\S]*key: "owner-url"/);
    assert.doesNotMatch(prove, /name: "lifecycle-demo-database"/);
    assert.match(
      prove,
      /name: COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256[\s\S]*value: "c{64}"/,
    );
    assert.match(prove, /name: database-public-ca[\s\S]*readOnly: true/);
    assert.match(prove, /name: api-proof-public[\s\S]*readOnly: true/);
    assert.doesNotMatch(prove, /tls\.key|privateSecret|Service\n/);
  });

  it('seals the proof Service to the numeric HTTPS target port', () => {
    const rendered = render();
    const service = resource(rendered, 'Service', 'lifecycle-demo-api-proof');
    assert.match(
      service,
      /name: tenant-proof[\s\S]*port: 9443[\s\S]*targetPort: 9443[\s\S]*protocol: TCP/,
    );
    assert.doesNotMatch(service, /targetPort: tenant-authority-proof/);
  });

  it('isolates proof pod ingress and allows only database, DNS, and proof-port egress', () => {
    const rendered = render();
    const proofPolicy = resource(rendered, 'NetworkPolicy', 'lifecycle-demo-tenant-cutover-prove');
    assert.match(proofPolicy, /commander\.io\/tenant-authority-proof-reader: "true"/);
    assert.match(proofPolicy, /policyTypes:[\s\S]*- Ingress[\s\S]*- Egress/);
    assert.match(proofPolicy, /ingress: \[\]/);
    assert.match(
      proofPolicy,
      /kubernetes\.io\/metadata\.name: kube-system[\s\S]*k8s-app: kube-dns/,
    );
    assert.match(
      proofPolicy,
      /kubernetes\.io\/metadata\.name: kube-system[\s\S]*component: kube-apiserver[\s\S]*port: 6443/,
    );
    assert.doesNotMatch(proofPolicy, /namespaceSelector: \{\}/);
    assert.match(proofPolicy, /port: 9443/);
    assert.doesNotMatch(proofPolicy, /port: 4000/);
    assert.doesNotMatch(proofPolicy, /0\.0\.0\.0\/0/);

    const databaseIngress = resource(rendered, 'NetworkPolicy', 'lifecycle-demo-postgres-ingress');
    assert.match(databaseIngress, /commander\.io\/tenant-authority-proof-reader: "true"/);
    const apiProofIngress = resource(rendered, 'NetworkPolicy', 'lifecycle-demo-api-proof-ingress');
    assert.match(apiProofIngress, /commander\.io\/tenant-authority-proof-reader: "true"/);
    assert.match(apiProofIngress, /port: 9443/);
    assert.doesNotMatch(apiProofIngress, /port: 4000/);
  });
});
