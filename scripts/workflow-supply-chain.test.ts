// LM-13 static gate — Action supply-chain pinning and least privilege.
//
// This gate parses the *real* `.github/workflows/*.yml` tree (plus fixture YAML, so the
// detector itself is proven able to fail) and rejects:
//
//   1. a mutable remote `uses:` ref (tag or branch instead of a 40-hex commit SHA),
//   2. a container action not pinned by digest,
//   3. a workflow without an explicit `permissions:` block,
//   4. a `permissions:` block that grants everything (`write-all`) or only write scopes,
//   5. a secret-bearing context reachable from an untrusted trigger.
//
// Fixture assertions deliberately run first: a gate that cannot fail is not a gate.
//
// Run: node --import tsx --test scripts/workflow-supply-chain.test.ts
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so a pre-fix snapshot of the tree can be audited without touching the shared
// working tree (used to capture red-before evidence).
const workflowDir = resolve(
  process.env.WORKFLOW_SUPPLY_CHAIN_DIR ?? resolve(root, '.github/workflows'),
);

/** 40 lowercase hex characters — the only acceptable immutable ref. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A trailing human-readable ref comment, e.g. `# v6` or `# release/v1`. */
const REF_COMMENT = /#\s*\S+/;

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Job = {
  permissions?: Record<string, string> | string;
  environment?: unknown;
  if?: string;
  steps?: Step[];
  secrets?: unknown;
  uses?: string;
};

type Workflow = {
  name?: string;
  on?: Record<string, unknown> | string[] | string;
  permissions?: Record<string, string> | string;
  jobs?: Record<string, Job>;
};

type Finding = { workflow: string; where: string; detail: string };

export type WorkflowFile = { file: string; source: string; doc: Workflow };

export function parseWorkflowSource(file: string, source: string): WorkflowFile {
  const doc = loadYaml(source) as Workflow;
  // js-yaml (YAML 1.1) may coerce the `on:` key to the boolean true; normalise it.
  const raw = doc as unknown as Record<string, unknown>;
  if (raw.on === undefined && raw.true !== undefined) raw.on = raw.true;
  return { file, source, doc };
}

export function loadRealWorkflowTree(): WorkflowFile[] {
  return readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => parseWorkflowSource(f, readFileSync(resolve(workflowDir, f), 'utf8')));
}

function triggerNames(wf: Workflow): string[] {
  const on = wf.on;
  if (on === undefined || on === null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

/**
 * Workflow files whose raw source contains a `uses:` line that is not local and not
 * pinned to a 40-hex commit SHA. Line-based on purpose: `uses:` always appears in a
 * plain step mapping, and this keeps the check independent of YAML anchor/merge support.
 */
export function findMutableRemoteRefs({ file, source }: WorkflowFile): Finding[] {
  const findings: Finding[] = [];
  source.split('\n').forEach((line, index) => {
    const match = line.match(/^(\s*(?:- )?uses:\s*)(\S+)\s*(#.*)?$/);
    if (!match) return;
    const ref = match[2];
    const comment = match[3] ?? '';
    if (ref.startsWith('./')) return; // local composite action: bound to the candidate tree
    const where = `${file}:${index + 1}`;
    if (ref.startsWith('docker://')) {
      if (!ref.includes('@sha256:')) {
        findings.push({
          workflow: file,
          where,
          detail: `container action not pinned by digest: ${ref}`,
        });
      }
      return;
    }
    const at = ref.lastIndexOf('@');
    if (at === -1) {
      findings.push({ workflow: file, where, detail: `remote action without a ref: ${ref}` });
      return;
    }
    const sha = ref.slice(at + 1);
    if (!COMMIT_SHA.test(sha)) {
      findings.push({ workflow: file, where, detail: `mutable remote ref: ${ref}` });
      return;
    }
    if (!REF_COMMENT.test(comment)) {
      findings.push({
        workflow: file,
        where,
        detail: `pinned ref must keep the human-readable ref as a trailing comment: ${ref}`,
      });
    }
  });
  return findings;
}

/** A permissions block is unacceptable when it is missing, `write-all`, or all-write. */
export function inspectPermissions(
  file: string,
  where: string,
  permissions: Record<string, string> | string | undefined,
): Finding[] {
  const findings: Finding[] = [];
  if (permissions === undefined) {
    findings.push({ workflow: file, where, detail: 'missing explicit permissions block' });
    return findings;
  }
  if (typeof permissions === 'string') {
    if (permissions === 'write-all') {
      findings.push({
        workflow: file,
        where,
        detail: 'permissions: write-all grants every write scope',
      });
    }
    return findings;
  }
  const entries = Object.entries(permissions);
  if (entries.length === 0) return findings; // `{}` — no scope at all, acceptable
  for (const [scope, access] of entries) {
    if (access === 'write-all') {
      findings.push({ workflow: file, where, detail: `scope ${scope}: write-all` });
    }
  }
  if (entries.every(([, access]) => access === 'write')) {
    findings.push({ workflow: file, where, detail: 'permissions block grants write scopes only' });
  }
  return findings;
}

/** Any `secrets.*` reference anywhere in the job body. */
function referencesSecrets(job: Job): boolean {
  return JSON.stringify(job).includes('secrets.');
}

const SECRET_BEARING_JOB_KEYS = ['environment', 'secrets'];

/** A job `if:` that pins the job to a trusted event or ref, making PR contexts unreachable. */
const TRUSTED_ONLY_IF = [
  /github\.event_name\s*==\s*['"](workflow_dispatch|schedule|release|push)['"]/,
  /github\.event_name\s*!=\s*['"]pull_request['"]/,
  /startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\//,
  /github\.ref\s*==\s*['"]refs\/heads\/(master|main)['"]/,
];

/**
 * Untrusted-trigger rule: a job reachable from `pull_request` / `pull_request_target`
 * must not be able to read release secrets. A job that pins itself to a trusted event
 * (`workflow_dispatch`, `schedule`, `release`, a protected branch, or a tag) or to the
 * protected `environment:` gate is not reachable from an untrusted PR. `pull_request_target`
 * is only trusted when the job performs no checkout of the untrusted head
 * (`github.event.pull_request.head`).
 */
export function findUntrustedSecretReach(
  { file, doc }: WorkflowFile,
  jobName: string,
  job: Job,
): Finding[] {
  const triggers = triggerNames(doc);
  const untrusted = triggers.includes('pull_request') || triggers.includes('pull_request_target');
  if (!untrusted) return [];
  const condition = typeof job.if === 'string' ? job.if : '';
  if (TRUSTED_ONLY_IF.some((pattern) => pattern.test(condition))) return [];
  const findings: Finding[] = [];
  const where = `${file}#${jobName}`;
  const hasEnv = SECRET_BEARING_JOB_KEYS.some(
    (k) => (job as Record<string, unknown>)[k] !== undefined,
  );
  if (hasEnv && referencesSecrets(job)) {
    findings.push({
      workflow: file,
      where,
      detail: `job is reachable from an untrusted trigger and reads secrets: ${JSON.stringify(
        SECRET_BEARING_JOB_KEYS.filter((k) => (job as Record<string, unknown>)[k] !== undefined),
      )}`,
    });
  }
  if (triggers.includes('pull_request_target')) {
    for (const step of job.steps ?? []) {
      const uses = step.uses ?? '';
      if (/actions\/checkout@/.test(uses)) {
        const withBlock = JSON.stringify(step.with ?? {});
        const refs = `${step.with?.ref ?? ''} ${withBlock}`;
        if (/head\.ref|head\.sha|head\.repo|github\.event\.pull_request\.head/.test(refs)) {
          findings.push({
            workflow: file,
            where: `${where}/${step.name ?? uses}`,
            detail: 'pull_request_target executes untrusted head code via checkout ref',
          });
        }
      }
    }
  }
  return findings;
}

/** The complete LM-13 policy applied to one workflow file. */
export function auditWorkflow(wf: WorkflowFile): Finding[] {
  const findings: Finding[] = [...findMutableRemoteRefs(wf)];
  findings.push(...inspectPermissions(wf.file, `${wf.file}#workflow`, wf.doc.permissions));
  for (const [jobName, job] of Object.entries(wf.doc.jobs ?? {})) {
    if (job.permissions !== undefined) {
      findings.push(...inspectPermissions(wf.file, `${wf.file}#${jobName}`, job.permissions));
    }
    findings.push(...findUntrustedSecretReach(wf, jobName, job));
  }
  return findings;
}

export function auditWorkflowTree(files: WorkflowFile[]): Finding[] {
  return files.flatMap(auditWorkflow);
}

const GOOD_FIXTURE = `
name: Fixture Good
on:
  push:
    branches: [master]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - run: pnpm install --frozen-lockfile
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: ./local-composite-action
`;

const TAG_REF_FIXTURE = GOOD_FIXTURE.replace(
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  'actions/checkout@v6',
);
const SHORT_SHA_FIXTURE = GOOD_FIXTURE.replace(
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af80 # v6',
);
const UNCOMMENTED_SHA_FIXTURE = GOOD_FIXTURE.replace(' # v6', '');
const MISSING_PERMISSIONS_FIXTURE = GOOD_FIXTURE.replace('permissions:\n  contents: read\n', '');
const WRITE_ALL_FIXTURE = GOOD_FIXTURE.replace(
  'permissions:\n  contents: read',
  'permissions: write-all',
);
const ALL_WRITE_FIXTURE = GOOD_FIXTURE.replace(
  'permissions:\n  contents: read',
  'permissions:\n  contents: write\n  packages: write',
);
const CONTAINER_FIXTURE = GOOD_FIXTURE.replace(
  '- uses: ./local-composite-action',
  '- uses: docker://ghcr.io/example/tool:latest',
);
const UNTRUSTED_SECRET_FIXTURE = `
name: Fixture Untrusted
on:
  pull_request:
    branches: [master]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
      - env:
          KEY: \${{ secrets.PROD_KEY }}
        run: ./deploy.sh
`;
const PR_TARGET_HEAD_FIXTURE = `
name: Fixture PRTarget
on:
  pull_request_target:
    branches: [master]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          ref: \${{ github.event.pull_request.head.sha }}
`;

const TRUSTED_ONLY_UNTRUSTED_WORKFLOW_FIXTURE = `
name: Fixture Trusted Only
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
permissions:
  contents: read
jobs:
  dr-proof:
    if: github.event_name == 'workflow_dispatch' && inputs.run_dr_live_proof
    runs-on: ubuntu-latest
    environment: cd-live-proof
    steps:
      - env:
          KEY: \${{ secrets.PROD_KEY }}
        run: ./proof.sh
`;

const fixture = (name: string, source: string): WorkflowFile =>
  parseWorkflowSource(`fixture-${name}.yml`, source);

describe('workflow supply-chain gate — detector fixtures', () => {
  it('accepts a pinned ref that keeps the human-readable ref as a trailing comment', () => {
    assert.deepEqual(auditWorkflow(fixture('good', GOOD_FIXTURE)), []);
  });

  it('rejects a mutable tag ref', () => {
    const findings = findMutableRemoteRefs(fixture('tag', TAG_REF_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /mutable remote ref: actions\/checkout@v6/);
  });

  it('rejects a ref that merely looks like a SHA', () => {
    const findings = findMutableRemoteRefs(fixture('short', SHORT_SHA_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /mutable remote ref/);
  });

  it('rejects a pinned SHA without the human-readable ref comment', () => {
    const findings = findMutableRemoteRefs(fixture('nocomment', UNCOMMENTED_SHA_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /trailing comment/);
  });

  it('rejects an unpinned container action', () => {
    const findings = findMutableRemoteRefs(fixture('container', CONTAINER_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /not pinned by digest/);
  });

  it('rejects a workflow without an explicit permissions block', () => {
    const findings = auditWorkflow(fixture('noperms', MISSING_PERMISSIONS_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /missing explicit permissions block/);
  });

  it('rejects permissions: write-all', () => {
    const findings = auditWorkflow(fixture('writeall', WRITE_ALL_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /write-all/);
  });

  it('rejects a permissions block that only grants write scopes', () => {
    const findings = auditWorkflow(fixture('allwrite', ALL_WRITE_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /write scopes only/);
  });

  it('rejects a secret-bearing environment reachable from pull_request', () => {
    const findings = auditWorkflow(fixture('untrusted', UNTRUSTED_SECRET_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /reachable from an untrusted trigger/);
  });

  it('rejects pull_request_target that checks out the untrusted head', () => {
    const findings = auditWorkflow(fixture('prtarget', PR_TARGET_HEAD_FIXTURE));
    assert.equal(findings.length, 1);
    assert.match(findings[0].detail, /untrusted head code/);
  });

  it('exempts a secret-bearing job that pins itself to a trusted event', () => {
    const findings = auditWorkflow(fixture('trustedonly', TRUSTED_ONLY_UNTRUSTED_WORKFLOW_FIXTURE));
    assert.deepEqual(findings, []);
  });
});

describe('workflow supply-chain gate — real workflow tree', () => {
  const files = loadRealWorkflowTree();

  it('discovers the whole workflow tree', () => {
    assert.ok(files.length >= 20, `expected the full workflow tree, saw ${files.length} files`);
    for (const wf of files) {
      assert.ok(wf.doc.jobs && Object.keys(wf.doc.jobs).length > 0, `${wf.file}: no jobs parsed`);
    }
  });

  it('pins every remote action to an immutable commit SHA', () => {
    const findings = files.flatMap(findMutableRemoteRefs);
    assert.deepEqual(findings, []);
  });

  it('declares an explicit least-privilege permissions block in every workflow', () => {
    const findings = files.flatMap((wf) =>
      inspectPermissions(wf.file, `${wf.file}#workflow`, wf.doc.permissions),
    );
    assert.deepEqual(findings, []);
  });

  it('grants no write scope to benchmark execution jobs', () => {
    const violations: string[] = [];
    for (const { file, doc } of files) {
      for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
        if (!/^bench-/.test(jobName)) continue;
        const perms = job.permissions;
        if (perms === undefined) continue; // inherits the workflow's read-only default
        if (typeof perms === 'string' || Object.values(perms).some((v) => v === 'write')) {
          violations.push(`${file}#${jobName}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it('keeps release secrets out of untrusted-trigger jobs', () => {
    const findings = files.flatMap((wf) =>
      Object.entries(wf.doc.jobs ?? {}).flatMap(([jobName, job]) =>
        findUntrustedSecretReach(wf, jobName, job),
      ),
    );
    assert.deepEqual(findings, []);
  });

  it('never executes untrusted code from pull_request_target', () => {
    const offenders: string[] = [];
    for (const { file, source } of files) {
      if (!/pull_request_target/.test(source)) continue;
      if (/pull_request_target[\s\S]*?github\.event\.pull_request\.(head|merge)/.test(source)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('reports the full audit as clean', () => {
    const findings = auditWorkflowTree(files);
    assert.deepEqual(
      findings,
      [],
      `supply-chain findings:\n${findings.map((f) => `${f.where}: ${f.detail}`).join('\n')}`,
    );
  });
});
