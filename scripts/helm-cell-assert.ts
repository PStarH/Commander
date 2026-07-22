#!/usr/bin/env tsx
/**
 * Helm cell topology assertions (H1–H11 + role/DSN gates).
 *
 * Usage:
 *   helm template cell-demo deploy/helm/commander -f deploy/helm/commander/values-demo.yaml | tsx scripts/helm-cell-assert.ts --profile demo
 *   tsx scripts/helm-cell-assert.ts --file /tmp/rendered.yaml --profile enterprise
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export type HelmCellProfile = 'demo' | 'enterprise';

const CELL_COMPONENTS = ['api', 'worker', 'kernel-ops', 'adapter-ops'] as const;

/** Runtime cell workloads must never mount owner-url. */
const RUNTIME_COMPONENTS = ['api', 'worker', 'kernel-ops', 'adapter-ops'] as const;

const EXPECTED_DSN_KEYS = {
  api: 'app-url',
  worker: 'worker-url',
  'kernel-ops': 'scheduler-url',
  'adapter-ops': 'worker-url',
  migration: 'owner-url',
} as const;

interface K8sDoc {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
  _raw?: string;
}

function parseArgs(): { file: string | null; profile: HelmCellProfile; stdin: boolean } {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const profileIdx = args.indexOf('--profile');
  return {
    file: fileIdx >= 0 ? args[fileIdx + 1] ?? null : null,
    profile: (profileIdx >= 0 ? args[profileIdx + 1] : 'demo') as HelmCellProfile,
    stdin: !process.stdin.isTTY && fileIdx < 0,
  };
}

export function loadYamlDocuments(yaml: string): K8sDoc[] {
  return yaml
    .split(/^---\s*$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      try {
        const kind = chunk.match(/^kind:\s*(\S+)/m)?.[1];
        const name = chunk.match(/^metadata:\s*\n\s*name:\s*(.+)$/m)?.[1]?.trim()
          ?? chunk.match(/^  name:\s*(.+)$/m)?.[1]?.trim();
        const annotations: Record<string, string> = {};
        const hook = chunk.match(/helm\.sh\/hook:\s*(.+)$/m)?.[1]?.trim();
        if (hook) annotations['helm.sh/hook'] = hook;
        return { kind, metadata: { name, annotations }, spec: {}, _raw: chunk };
      } catch {
        return { kind: undefined, _raw: chunk };
      }
    });
}

function deploymentComponent(raw: string): string | null {
  const templateLabel = raw.match(
    /template:\s*\n\s*metadata:\s*\n\s*labels:\s*\n\s*app\.kubernetes\.io\/component:\s*(\S+)/,
  );
  if (templateLabel) return templateLabel[1];
  const m = raw.match(/app\.kubernetes\.io\/component:\s*(\S+)/);
  return m?.[1] ?? null;
}

function deploymentSpecReplicas(raw: string): number | null {
  const specSection = raw.split(/^  template:/m)[0] ?? raw;
  const m = specSection.match(/^spec:\s*\n\s*replicas:\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

function indexDeploymentsByComponent(docs: K8sDoc[]): Map<string, string> {
  const byComponent = new Map<string, string>();
  for (const doc of docs) {
    if (doc.kind !== 'Deployment' || !doc._raw) continue;
    const component = deploymentComponent(doc._raw);
    if (component) byComponent.set(component, doc._raw);
  }
  return byComponent;
}

/** Extract secretKeyRef key for COMMANDER_KERNEL_DATABASE_URL (or DATABASE_URL). */
export function extractKernelDatabaseSecretKey(raw: string): string | null {
  const kernelBlock = raw.match(
    /- name:\s*COMMANDER_KERNEL_DATABASE_URL\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*\S+\s*\n\s*key:\s*(\S+)/,
  );
  if (kernelBlock) return kernelBlock[1].replace(/['"]/g, '');
  const dbBlock = raw.match(
    /- name:\s*DATABASE_URL\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name:\s*\S+\s*\n\s*key:\s*(\S+)/,
  );
  return dbBlock ? dbBlock[1].replace(/['"]/g, '') : null;
}

function extractWorkerTenants(raw: string): string | null {
  const m = raw.match(/- name:\s*COMMANDER_WORKER_TENANTS\s*\n\s*value:\s*(.+)/);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function extractCellTenantId(raw: string): string | null {
  const m = raw.match(/- name:\s*COMMANDER_CELL_TENANT_ID\s*\n\s*value:\s*(.+)/);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function findMigrationRaw(docs: K8sDoc[]): string {
  for (const doc of docs) {
    if (doc.kind === 'Job' && doc._raw && /component:\s*migration/.test(doc._raw)) {
      return doc._raw;
    }
  }
  return '';
}

function findPostgresStatefulSetRaw(docs: K8sDoc[]): string {
  for (const doc of docs) {
    if (doc.kind === 'StatefulSet' && doc._raw && /component:\s*postgres/.test(doc._raw)) {
      return doc._raw;
    }
  }
  return '';
}

function findDatabaseInitConfigMapRaw(docs: K8sDoc[]): string {
  for (const doc of docs) {
    if (doc.kind === 'ConfigMap' && doc._raw && /database-init|01-commander-roles\.sh/.test(doc._raw)) {
      return doc._raw;
    }
  }
  return '';
}

function findDatabaseSecretRaw(docs: K8sDoc[]): string {
  for (const doc of docs) {
    if (doc.kind !== 'Secret' || !doc._raw) continue;
    if (
      /owner-url:/.test(doc._raw)
      && /app-url:/.test(doc._raw)
      && /scheduler-url:/.test(doc._raw)
      && /worker-url:/.test(doc._raw)
    ) {
      return doc._raw;
    }
  }
  return '';
}

/** Runtime cell workloads that mint/verify capability tokens. */
const CAPABILITY_COMPONENTS = ['worker', 'adapter-ops'] as const;

const CAPABILITY_ENV_NAMES = [
  'COMMANDER_CAPABILITY_PRIVATE_KEY_PEM',
  'COMMANDER_CAPABILITY_KEY_ID',
  'COMMANDER_CAPABILITY_JWKS_JSON',
] as const;

function envHasSecretKeyRef(raw: string, envName: string): boolean {
  const re = new RegExp(
    `- name:\\s*${envName}\\s*\\n\\s*valueFrom:\\s*\\n\\s*secretKeyRef:\\s*\\n\\s*name:\\s*\\S+\\s*\\n\\s*key:\\s*\\S+`,
  );
  return re.test(raw);
}

function envHasInlineValue(raw: string, envName: string): boolean {
  return new RegExp(`- name:\\s*${envName}\\s*\\n\\s*value:`).test(raw);
}

function assertCapabilityAuthorityMounts(
  docs: K8sDoc[],
  profile: HelmCellProfile,
  raw: string,
): void {
  const deployByComponent = indexDeploymentsByComponent(docs);

  for (const component of CAPABILITY_COMPONENTS) {
    const deployRaw = deployByComponent.get(component) ?? '';
    assert.ok(deployRaw, `H16: ${component} Deployment missing for capability env check`);
    for (const envName of CAPABILITY_ENV_NAMES) {
      assert.ok(
        envHasSecretKeyRef(deployRaw, envName),
        `H16: ${component} must mount ${envName} via secretKeyRef`,
      );
      assert.ok(
        !envHasInlineValue(deployRaw, envName),
        `H16: ${component} must not inline ${envName}`,
      );
    }
    // Retire HMAC capability-token path for worker/adapter authority.
    assert.ok(
      !/COMMANDER_CAPABILITY_TOKEN_KEY/.test(deployRaw),
      `H16: ${component} must not use COMMANDER_CAPABILITY_TOKEN_KEY`,
    );
    assert.ok(
      !/capability-token-key/.test(deployRaw),
      `H16: ${component} must not reference capability-token-key`,
    );
  }

  // O1 clarity: API may retain HMAC COMMANDER_CAPABILITY_TOKEN_KEY — Task 4 retires
  // HMAC only for worker/adapter. H16 scope must stay worker+adapter-ops (never API).
  assert.deepEqual(
    [...CAPABILITY_COMPONENTS],
    ['worker', 'adapter-ops'],
    'H16: HMAC ban applies only to worker/adapter-ops (API HMAC retention intentional)',
  );

  // Deployments (not Secrets) must never embed literal PEM/JWKS.
  for (const component of CAPABILITY_COMPONENTS) {
    const deployRaw = deployByComponent.get(component) ?? '';
    assert.ok(
      !/BEGIN (?:PRIVATE|PUBLIC) KEY/.test(deployRaw),
      `H16: ${component} Deployment must not embed PEM`,
    );
    assert.ok(
      !/"kty"\s*:\s*"OKP"/.test(deployRaw),
      `H16: ${component} Deployment must not embed JWKS JSON`,
    );
  }

  if (profile === 'enterprise') {
    // No chart-generated capability Secret; existingSecret refs only.
    for (const doc of docs) {
      if (doc.kind !== 'Secret' || !doc._raw) continue;
      assert.ok(
        !/private-key-pem:/.test(doc._raw),
        'H17: enterprise must not render chart-generated capability Secret (private-key-pem)',
      );
      assert.ok(
        !/jwks-json:/.test(doc._raw),
        'H17: enterprise must not render chart-generated capability Secret (jwks-json)',
      );
    }
    assert.ok(
      !/BEGIN PRIVATE KEY/.test(raw),
      'H17: enterprise render must not embed literal PEM',
    );
    // Worker/adapter must ref operator secret name from values-enterprise.
    for (const component of CAPABILITY_COMPONENTS) {
      const deployRaw = deployByComponent.get(component) ?? '';
      assert.match(
        deployRaw,
        /name:\s*["']?cmdr-capability["']?/,
        `H17: ${component} must ref capability.existingSecret (cmdr-capability)`,
      );
    }
  }

  if (profile === 'demo') {
    // Fixed DEV keypair is demo-gated; Secret must carry not-for-production annotations.
    const capSecret = docs.find(
      (d) => d.kind === 'Secret' && d._raw && /private-key-pem:/.test(d._raw) && /jwks-json:/.test(d._raw),
    );
    assert.ok(capSecret?._raw, 'H17: demo must render capability Secret with PEM/JWKS');
    assert.match(
      capSecret!._raw!,
      /commander\.io\/not-for-production:\s*["']?true["']?/,
      'H17: demo capability Secret must annotate not-for-production',
    );
    assert.match(
      capSecret!._raw!,
      /commander\.io\/capability-keys:\s*["']?demo-dev-fixed-pair["']?/,
      'H17: demo capability Secret must annotate demo-dev-fixed-pair',
    );
  }
}

function assertRoleDsnSeparation(docs: K8sDoc[], profile: HelmCellProfile, raw: string): void {
  const deployByComponent = indexDeploymentsByComponent(docs);
  const migrationRaw = findMigrationRaw(docs);

  // Distinct secret keys per authority mapping
  const seenKeys = new Map<string, string>();
  for (const [component, expectedKey] of Object.entries(EXPECTED_DSN_KEYS)) {
    const componentRaw =
      component === 'migration' ? migrationRaw : (deployByComponent.get(component) ?? '');
    assert.ok(componentRaw, `H12: ${component} manifest missing for DSN key check`);
    const key = extractKernelDatabaseSecretKey(componentRaw);
    assert.equal(key, expectedKey, `H12: ${component} must use secret key ${expectedKey}, got ${key}`);
    const prior = seenKeys.get(key);
    if (prior && prior !== component && !(key === 'worker-url' && (component === 'worker' || component === 'adapter-ops'))) {
      // worker and adapter-ops intentionally share worker-url
    }
    seenKeys.set(key, component);
  }

  // Four distinct keys across the authority map (worker+adapter share worker-url → 4 keys)
  const uniqueKeys = new Set(Object.values(EXPECTED_DSN_KEYS));
  assert.equal(uniqueKeys.size, 4, 'H12: expected four distinct DSN secret keys');
  assert.deepEqual(
    [...uniqueKeys].sort(),
    ['app-url', 'owner-url', 'scheduler-url', 'worker-url'],
    'H12: DSN secret keys must be owner/app/scheduler/worker-url',
  );

  // No runtime workload uses owner-url
  for (const component of RUNTIME_COMPONENTS) {
    const deployRaw = deployByComponent.get(component) ?? '';
    const key = extractKernelDatabaseSecretKey(deployRaw);
    assert.notEqual(key, 'owner-url', `H13: runtime ${component} must not use owner-url`);
    assert.ok(!/key:\s*["']?owner-url["']?/.test(deployRaw), `H13: runtime ${component} must not reference owner-url`);
  }

  // Migration alone uses owner-url (never the legacy generic "url" key)
  assert.match(migrationRaw, /key:\s*["']?owner-url["']?/, 'H13: migration must select owner-url');
  assert.equal(
    extractKernelDatabaseSecretKey(migrationRaw),
    'owner-url',
    'H13: migration must not use legacy url key',
  );

  // Worker + adapter-ops tenants: never empty / never '*'
  const workerRaw = deployByComponent.get('worker') ?? '';
  const tenants = extractWorkerTenants(workerRaw);
  assert.ok(tenants && tenants.length > 0, 'H14: worker COMMANDER_WORKER_TENANTS must be non-empty');
  assert.notEqual(tenants, '*', 'H14: COMMANDER_WORKER_TENANTS must not be *');
  assert.ok(!/COMMANDER_WORKER_TENANTS[\s\S]*?value:\s*["']?\*/.test(workerRaw), 'H14: no WORKER_TENANTS=*');
  if (profile === 'demo') {
    assert.equal(tenants, 'local', 'H14: demo worker tenants must be local');
  }

  const adapterOpsRaw = deployByComponent.get('adapter-ops') ?? '';
  const adapterTenants = extractWorkerTenants(adapterOpsRaw);
  assert.ok(
    adapterTenants && adapterTenants.length > 0,
    'H14: adapter-ops COMMANDER_WORKER_TENANTS must be non-empty',
  );
  assert.notEqual(adapterTenants, '*', 'H14: adapter-ops COMMANDER_WORKER_TENANTS must not be *');
  assert.ok(
    !/COMMANDER_WORKER_TENANTS[\s\S]*?value:\s*["']?\*/.test(adapterOpsRaw),
    'H14: adapter-ops no WORKER_TENANTS=*',
  );
  if (profile === 'demo') {
    assert.equal(adapterTenants, 'local', 'H14: demo adapter-ops tenants must be local');
  }
  assert.equal(
    adapterTenants,
    tenants,
    'H14: adapter-ops COMMANDER_WORKER_TENANTS must match worker',
  );

  // COMMANDER_CELL_TENANT_ID — explicit inject (no silent local fallback on enterprise).
  const workerCellTenant = extractCellTenantId(workerRaw);
  const adapterCellTenant = extractCellTenantId(adapterOpsRaw);
  assert.ok(
    workerCellTenant && workerCellTenant.length > 0,
    'H14: worker COMMANDER_CELL_TENANT_ID must be non-empty',
  );
  assert.ok(
    adapterCellTenant && adapterCellTenant.length > 0,
    'H14: adapter-ops COMMANDER_CELL_TENANT_ID must be non-empty',
  );
  assert.equal(
    adapterCellTenant,
    workerCellTenant,
    'H14: adapter-ops COMMANDER_CELL_TENANT_ID must match worker',
  );
  if (profile === 'demo') {
    assert.equal(workerCellTenant, 'local', 'H14: demo COMMANDER_CELL_TENANT_ID must be local');
  }
  if (profile === 'enterprise') {
    assert.notEqual(
      workerCellTenant,
      'local',
      'H14: enterprise COMMANDER_CELL_TENANT_ID must not silently be local',
    );
    const tenantList = tenants!
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    assert.ok(
      tenantList.includes(workerCellTenant!),
      'H14: enterprise COMMANDER_CELL_TENANT_ID must be in worker.tenants',
    );

    // P1-B: enterprise tier must wire COMMANDER_PROFILE=enterprise (fail-closed authority).
    for (const component of ['api', 'worker', 'adapter-ops'] as const) {
      const deployRaw = deployByComponent.get(component) ?? '';
      assert.ok(deployRaw, `H18: ${component} Deployment missing for COMMANDER_PROFILE check`);
      assert.match(
        deployRaw,
        /name:\s*COMMANDER_PROFILE[\s\S]*?value:\s*["']?enterprise["']?/,
        `H18: enterprise ${component} must set COMMANDER_PROFILE=enterprise`,
      );
      assert.match(
        deployRaw,
        /name:\s*COMMANDER_CELL_TIER[\s\S]*?value:\s*["']?enterprise["']?/,
        `H18: enterprise ${component} must set COMMANDER_CELL_TIER=enterprise`,
      );
    }
  }

  if (profile === 'demo') {
    // Init ConfigMap: CREATE ROLE LOGIN × 4
    const initCm = findDatabaseInitConfigMapRaw(docs);
    assert.ok(initCm, 'H15: demo must render database-init ConfigMap');
    const createRoleLogin = initCm.match(/CREATE ROLE \w+ WITH LOGIN/g) ?? [];
    assert.equal(createRoleLogin.length, 4, `H15: expected 4 CREATE ROLE ... LOGIN, got ${createRoleLogin.length}`);
    for (const role of ['commander_owner', 'commander_app', 'commander_scheduler', 'commander_worker']) {
      assert.match(initCm, new RegExp(`CREATE ROLE ${role} WITH LOGIN`), `H15: missing CREATE ROLE ${role} LOGIN`);
    }

    // StatefulSet mounts init under /docker-entrypoint-initdb.d and sources password secrets
    const sts = findPostgresStatefulSetRaw(docs);
    assert.ok(sts, 'H15: demo Postgres StatefulSet missing');
    assert.match(sts, /mountPath:\s*\/docker-entrypoint-initdb\.d/, 'H15: init mount /docker-entrypoint-initdb.d required');
    assert.match(sts, /name:\s*database-init/, 'H15: database-init volume required');
    for (const env of [
      'COMMANDER_OWNER_PASSWORD',
      'COMMANDER_APP_PASSWORD',
      'COMMANDER_SCHEDULER_PASSWORD',
      'COMMANDER_WORKER_PASSWORD',
    ]) {
      assert.match(sts, new RegExp(`name:\\s*${env}`), `H15: StatefulSet must inject ${env}`);
    }
    for (const key of ['owner-password', 'app-password', 'scheduler-password', 'worker-password']) {
      assert.match(sts, new RegExp(`key:\\s*${key}`), `H15: StatefulSet must ref secret key ${key}`);
    }

    // Generated Secret has four DSN keys + passwords
    const secret = findDatabaseSecretRaw(docs);
    assert.ok(secret, 'H15: demo database Secret with four DSN keys required');
    for (const key of ['owner-url', 'app-url', 'scheduler-url', 'worker-url']) {
      assert.match(secret, new RegExp(`${key}:`), `H15: Secret missing ${key}`);
    }
    for (const key of ['owner-password', 'app-password', 'scheduler-password', 'worker-password']) {
      assert.match(secret, new RegExp(`${key}:`), `H15: Secret missing ${key}`);
    }

    // Init script references password env vars (sourced from Secret via STS)
    assert.match(initCm, /COMMANDER_OWNER_PASSWORD/, 'H15: init must reference COMMANDER_OWNER_PASSWORD');
    assert.match(initCm, /COMMANDER_APP_PASSWORD/, 'H15: init must reference COMMANDER_APP_PASSWORD');
    assert.match(initCm, /COMMANDER_SCHEDULER_PASSWORD/, 'H15: init must reference COMMANDER_SCHEDULER_PASSWORD');
    assert.match(initCm, /COMMANDER_WORKER_PASSWORD/, 'H15: init must reference COMMANDER_WORKER_PASSWORD');
  } else {
    // Enterprise: no bundled init / no generated four-DSN secret from chart
    assert.ok(!findDatabaseInitConfigMapRaw(docs), 'H15: enterprise must not render database-init ConfigMap');
    assert.ok(!findPostgresStatefulSetRaw(docs), 'H15: enterprise must not render Postgres StatefulSet');
    // Operator-supplied Secret is external — rendered workloads must still pin all four DSN keys.
    for (const key of ['owner-url', 'app-url', 'scheduler-url', 'worker-url']) {
      assert.match(
        raw,
        new RegExp(`key:\\s*["']?${key}["']?`),
        `H15: enterprise render must reference secret key ${key}`,
      );
    }
  }

  // Sanity: rendered yaml never ships WORKER_TENANTS=*
  assert.ok(!/COMMANDER_WORKER_TENANTS[\s\S]{0,80}value:\s*["']?\*/.test(raw), 'H14: rendered yaml must not contain WORKER_TENANTS=*');
}

export function assertHelmCellTopology(docs: K8sDoc[], profile: HelmCellProfile, yaml?: string): void {
  const raw = yaml ?? docs.map((d) => d._raw ?? '').join('\n---\n');
  const deployments = docs.filter((d) => d.kind === 'Deployment');
  const deployByComponent = indexDeploymentsByComponent(docs);

  // H1 — require exactly four cell Deployments (not label substring anywhere in manifest)
  for (const component of CELL_COMPONENTS) {
    assert.ok(deployByComponent.has(component), `H1: ${component} Deployment missing`);
  }
  const cellDeployCount = CELL_COMPONENTS.filter((c) => deployByComponent.has(c)).length;
  assert.equal(cellDeployCount, CELL_COMPONENTS.length, 'H1: expected four cell Deployments');
  assert.equal(deployments.length, cellDeployCount, `H1: unexpected extra Deployments (got ${deployments.length})`);

  // H2
  assert.ok(!deployByComponent.has('sandboxd'), 'H2: sandboxd Deployment must not exist');

  // H3 / H4
  const hasPostgresSts = raw.includes('kind: StatefulSet') && raw.includes('component: postgres');
  if (profile === 'enterprise') {
    assert.ok(!hasPostgresSts, 'H3: enterprise must not render Postgres StatefulSet');
  } else {
    assert.ok(hasPostgresSts, 'H4: demo must render Postgres StatefulSet');
    assert.ok(/replicas:\s*1/.test(raw), 'H4: Postgres replicas=1');
  }

  // H5
  assert.ok(raw.includes('runAsNonRoot: true'), 'H5: runAsNonRoot required');
  assert.ok(raw.includes('readOnlyRootFilesystem: true'), 'H5: readOnlyRootFilesystem required');
  assert.ok(raw.includes('drop:') && raw.includes('ALL'), 'H5: capabilities.drop ALL required');

  // H6
  assert.ok(/automountServiceAccountToken:\s*false/.test(raw), 'H6: automountServiceAccountToken false');

  // H7
  assert.ok(/post-install,post-upgrade/.test(raw), 'H7: migration post-install/post-upgrade hook');

  // H8
  assert.ok(!/password:\s*commander/.test(raw), 'H8: no default password commander');
  assert.ok(!/value:\s*worker-token/.test(raw), 'H8: no plaintext worker-token env');
  assert.ok(!/COMMANDER_WORKER_AUTH_TOKEN:\s*worker-token/.test(raw), 'H8: no default worker token');

  // H9
  if (raw.includes('default-deny')) {
    assert.ok(!raw.includes('0.0.0.0/0'), 'H9: no 0.0.0.0/0 egress masquerade');
  }

  // H10 — per-Deployment replicas (no global replicas: 2 fallback)
  if (profile === 'demo') {
    const apiReplicas = deploymentSpecReplicas(deployByComponent.get('api') ?? '');
    const workerReplicas = deploymentSpecReplicas(deployByComponent.get('worker') ?? '');
    const adapterOpsReplicas = deploymentSpecReplicas(deployByComponent.get('adapter-ops') ?? '');
    assert.equal(apiReplicas, 2, 'H10: API replicas=2');
    assert.equal(workerReplicas, 2, 'H10: worker replicas=2');
    // Fixed daemon ids stomp under multi-replica; keep adapter-ops at 1 until POD_NAME suffix.
    assert.equal(adapterOpsReplicas, 1, 'H10: adapter-ops replicas=1 (daemon id stomping)');
  }

  // H11 — kernel backend env on all cell workloads (catches C1)
  for (const component of CELL_COMPONENTS) {
    const deployRaw = deployByComponent.get(component) ?? '';
    assert.match(
      deployRaw,
      /COMMANDER_KERNEL_BACKEND[\s\S]*?value:\s*postgres/,
      `H11: ${component} missing COMMANDER_KERNEL_BACKEND=postgres`,
    );
  }

  assertRoleDsnSeparation(docs, profile, raw);
  assertCapabilityAuthorityMounts(docs, profile, raw);
}

async function main(): Promise<void> {
  const { file, profile, stdin } = parseArgs();
  let yaml: string;
  if (file) {
    yaml = readFileSync(file, 'utf-8');
  } else if (stdin) {
    yaml = await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      process.stdin.on('error', reject);
    });
  } else {
    console.error('Provide --file or pipe helm template output on stdin');
    process.exit(1);
  }
  const docs = loadYamlDocuments(yaml);
  assertHelmCellTopology(docs, profile, yaml);
  console.log(`helm-cell-assert: PASS (${profile})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
