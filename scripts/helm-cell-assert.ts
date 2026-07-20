#!/usr/bin/env tsx
/**
 * Helm cell topology assertions (H1–H11).
 *
 * Usage:
 *   helm template cell-demo deploy/helm/commander -f deploy/helm/commander/values-demo.yaml | tsx scripts/helm-cell-assert.ts --profile demo
 *   tsx scripts/helm-cell-assert.ts --file /tmp/rendered.yaml --profile enterprise
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export type HelmCellProfile = 'demo' | 'enterprise';

const CELL_COMPONENTS = ['api', 'worker', 'kernel-ops', 'adapter-ops'] as const;

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
    assert.equal(apiReplicas, 2, 'H10: API replicas=2');
    assert.equal(workerReplicas, 2, 'H10: worker replicas=2');
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
