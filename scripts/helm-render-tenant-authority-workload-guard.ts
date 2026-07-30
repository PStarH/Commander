#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { dump } from 'js-yaml';
import { pathToFileURL } from 'node:url';
import { verifyChartContentDigest } from './chart-content-digest.js';
import {
  loadTask1PrerequisiteContext,
  renderTask1AdmissionPair,
  type Task1PrerequisiteCommandRequest,
} from './task1-helm-prerequisite-command.js';

const NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const SUBJECT =
  /^system:serviceaccount:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export function parseWorkloadGuardRenderArgs(
  args: readonly string[],
): Omit<Task1PrerequisiteCommandRequest, 'valuesPath' | 'stage'> {
  if (
    args.length !== 6 ||
    args[0] !== '--namespace' ||
    args[2] !== '--release' ||
    args[4] !== '--migration-operator-subject' ||
    !NAME.test(args[1] ?? '') ||
    !NAME.test(args[3] ?? '') ||
    !SUBJECT.test(args[5] ?? '')
  ) {
    throw new Error('TENANT_POLICY_CLI_ARGUMENT_INVALID');
  }
  return {
    namespace: args[1]!,
    release: args[3]!,
    migrationOperatorSubject: args[5]!,
  };
}

function helmValues(namespace: string, release: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'helm',
      ['get', 'values', release, '--namespace', namespace, '--all', '--output', 'yaml'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error('TENANT_POLICY_VALUES_UNREADABLE')) : resolve(stdout),
    );
  });
}

async function main(): Promise<void> {
  const request = parseWorkloadGuardRenderArgs(process.argv.slice(2));
  const context = loadTask1PrerequisiteContext(
    { ...request, valuesPath: '/helm-release-values', stage: 'workload' },
    await helmValues(request.namespace, request.release),
    verifyChartContentDigest('deploy/helm/commander'),
  );
  const pair = renderTask1AdmissionPair(context, 'workload');
  process.stdout.write(
    [pair.policy, pair.binding]
      .map((value) => dump(value, { noRefs: true, lineWidth: -1 }))
      .join('---\n'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'TENANT_POLICY_RENDER_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
}
