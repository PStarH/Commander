/**
 * exec1-gvisor-harness.ts — WS9 EXEC-1 adversarial gVisor isolation helpers.
 *
 * Spec §4.2 EXEC-1: tenant A in gVisor tries nsenter / /proc/1/root / cross-container
 * access → blocked; tenant B unaffected.
 *
 * Live path uses `docker --runtime=runsc` (same mechanism as GVisorSB). Helpers accept
 * an injectable runner so unit tests can mock spawn without writing live evidence.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { timeout?: number },
) => CommandResult;

/** Default image: prefer a locally cached alpine-family image to avoid Hub flakes. */
export const DEFAULT_EXEC1_IMAGE =
  process.env.COMMANDER_WS9_EXEC1_IMAGE?.trim() || 'nginx:alpine';

export type EscapeProbeId = 'nsenter' | 'proc-1-root-host-marker' | 'cross-container-canary';

export interface EscapeProbeResult {
  id: EscapeProbeId;
  blocked: boolean;
  detail: string;
  status: number | null;
  output: string;
}

export interface Exec1LiveResult {
  /** True when all probes blocked and B unaffected. */
  ok: boolean;
  details: string;
  probes: EscapeProbeResult[];
  bUnaffected: boolean;
  image: string;
  /**
   * Set when docker/runsc/image cannot run the live attempt.
   * Callers MUST NOT write evidence (honesty: missing ≠ fake PASS/FAIL).
   */
  infraError?: string;
}

export function defaultCommandRunner(
  command: string,
  args: string[],
  opts?: { timeout?: number },
): CommandResult {
  const res = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: opts?.timeout ?? 60_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error?.message,
  };
}

/** Combined stdout+stderr for assertion parsing. */
export function combinedOutput(result: CommandResult): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`;
}

/**
 * Decide whether an adversarial probe was blocked.
 * Pure function — safe for unit tests with synthetic CommandResult.
 */
export function isEscapeBlocked(
  probeId: EscapeProbeId,
  result: CommandResult,
  secrets: { hostMarker: string; canaryB: string },
): { blocked: boolean; detail: string } {
  const out = combinedOutput(result);
  const status = result.status;

  if (probeId === 'nsenter') {
    const denied =
      status !== 0 ||
      /operation not permitted|permission denied|cannot|can't reassociate|not found|no such file/i.test(
        out,
      );
    return {
      blocked: denied && !/\buid=\d+/.test(out),
      detail: `nsenter status=${status}; denied=${denied}; out=${out.slice(0, 200)}`,
    };
  }

  if (probeId === 'proc-1-root-host-marker') {
    const leaked = out.includes(secrets.hostMarker);
    const blocked = !leaked && status !== 0;
    return {
      blocked,
      detail: `host-marker via /proc/1/root leaked=${leaked} status=${status}`,
    };
  }

  // cross-container-canary
  const leaked = out.includes(secrets.canaryB);
  const blocked = !leaked && status !== 0;
  return {
    blocked,
    detail: `B canary leaked=${leaked} status=${status}`,
  };
}

export function evaluateExec1Isolation(
  probes: EscapeProbeResult[],
  bUnaffected: boolean,
): { ok: boolean; reason: string } {
  const failed = probes.filter((p) => !p.blocked);
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `escape not blocked: ${failed.map((p) => p.id).join(', ')}`,
    };
  }
  if (!bUnaffected) {
    return { ok: false, reason: 'tenant B canary altered or unreadable after A probes' };
  }
  if (probes.length < 3) {
    return { ok: false, reason: `incomplete probe set (${probes.length}/3)` };
  }
  return {
    ok: true,
    reason: `all ${probes.length} probes blocked; B unaffected`,
  };
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/**
 * Run the live EXEC-1 adversarial sequence via docker+runsc.
 * Inject `runner` in unit tests; never call writePass from this module.
 */
export function runExec1LiveFire(options?: {
  runner?: CommandRunner;
  image?: string;
}): Exec1LiveResult {
  const runner = options?.runner ?? defaultCommandRunner;
  const image = options?.image ?? DEFAULT_EXEC1_IMAGE;
  const suffix = uniqueSuffix();
  const nameB = `ws9-exec1-b-${suffix}`;
  const hostMarkerName = `ws9-exec1-host-${suffix}`;
  const hostMarkerValue = `HOSTSECRET-${suffix}`;
  const canaryB = `CANARY-B-${suffix}`;

  const cleanup = (): void => {
    runner('docker', ['rm', '-f', nameB], { timeout: 30_000 });
    runner(
      'docker',
      ['run', '--rm', '-v', '/tmp:/tmp', image, '/bin/sh', '-c', `rm -f /tmp/${hostMarkerName}`],
      { timeout: 60_000 },
    );
  };

  // Infra: docker + runsc runtime must be usable with the chosen image.
  const version = runner('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeout: 15_000,
  });
  if (version.status !== 0) {
    return {
      ok: false,
      details: '',
      probes: [],
      bUnaffected: false,
      image,
      infraError: `docker unavailable: ${combinedOutput(version).slice(0, 200)}`,
    };
  }

  const runtimeProbe = runner('docker', ['info', '--format', '{{json .Runtimes}}'], {
    timeout: 15_000,
  });
  if (runtimeProbe.status !== 0 || !combinedOutput(runtimeProbe).includes('runsc')) {
    return {
      ok: false,
      details: '',
      probes: [],
      bUnaffected: false,
      image,
      infraError: 'docker runsc runtime not configured',
    };
  }

  try {
    // Host-only marker on the Docker host (not mounted into gVisor A).
    const markerWrite = runner(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        '/tmp:/tmp',
        image,
        '/bin/sh',
        '-c',
        `echo '${hostMarkerValue}' > /tmp/${hostMarkerName}`,
      ],
      { timeout: 90_000 },
    );
    if (markerWrite.status !== 0) {
      return {
        ok: false,
        details: '',
        probes: [],
        bUnaffected: false,
        image,
        infraError: `failed to write host marker (image pull/start?): ${combinedOutput(markerWrite).slice(0, 240)}`,
      };
    }

    // Tenant B: long-lived gVisor container with canary.
    const startB = runner(
      'docker',
      [
        'run',
        '-d',
        '--name',
        nameB,
        '--runtime',
        'runsc',
        '--network',
        'none',
        image,
        '/bin/sh',
        '-c',
        `echo '${canaryB}' > /tmp/canary-b && sleep 180`,
      ],
      { timeout: 90_000 },
    );
    if (startB.status !== 0) {
      return {
        ok: false,
        details: '',
        probes: [],
        bUnaffected: false,
        image,
        infraError: `failed to start tenant-B runsc container: ${combinedOutput(startB).slice(0, 240)}`,
      };
    }

    let readB: CommandResult = { status: 1, stdout: '', stderr: 'not-tried' };
    for (let attempt = 0; attempt < 10; attempt++) {
      readB = runner('docker', ['exec', nameB, 'cat', '/tmp/canary-b'], { timeout: 30_000 });
      if (readB.status === 0 && combinedOutput(readB).includes(canaryB)) break;
      spawnSync('sleep', ['0.3'], { stdio: 'ignore', timeout: 2_000 });
    }
    if (readB.status !== 0 || !combinedOutput(readB).includes(canaryB)) {
      return {
        ok: false,
        details: '',
        probes: [],
        bUnaffected: false,
        image,
        infraError: `tenant-B canary not readable after start: ${combinedOutput(readB).slice(0, 200)}`,
      };
    }

    // Tenant A: one-shot gVisor adversarial script.
    const adversarialScript = [
      'set +e',
      'echo __NSENTER_BEGIN__',
      'nsenter --target 1 --mount --uts --ipc --net --pid -- /bin/sh -c id',
      'echo __NSENTER_RC=$?',
      'echo __PROC_BEGIN__',
      `cat /proc/1/root/tmp/${hostMarkerName}`,
      'echo __PROC_RC=$?',
      'echo __CROSS_BEGIN__',
      'cat /tmp/canary-b',
      'echo __CROSS_RC=$?',
    ].join('; ');

    const runA = runner(
      'docker',
      [
        'run',
        '--rm',
        '--runtime',
        'runsc',
        '--network',
        'none',
        image,
        '/bin/sh',
        '-c',
        adversarialScript,
      ],
      { timeout: 120_000 },
    );
    const aOut = combinedOutput(runA);

    const nsenterChunk = sliceBetween(aOut, '__NSENTER_BEGIN__', '__NSENTER_RC=');
    const nsenterRc = parseTaggedRc(aOut, '__NSENTER_RC=');
    const procChunk = sliceBetween(aOut, '__PROC_BEGIN__', '__PROC_RC=');
    const procRc = parseTaggedRc(aOut, '__PROC_RC=');
    const crossChunk = sliceBetween(aOut, '__CROSS_BEGIN__', '__CROSS_RC=');
    const crossRc = parseTaggedRc(aOut, '__CROSS_RC=');

    const secrets = { hostMarker: hostMarkerValue, canaryB };
    const probes: EscapeProbeResult[] = [];

    const nsenterDecision = isEscapeBlocked(
      'nsenter',
      { status: nsenterRc, stdout: nsenterChunk, stderr: '' },
      secrets,
    );
    probes.push({
      id: 'nsenter',
      blocked: nsenterDecision.blocked,
      detail: nsenterDecision.detail,
      status: nsenterRc,
      output: nsenterChunk.slice(0, 400),
    });

    const procDecision = isEscapeBlocked(
      'proc-1-root-host-marker',
      { status: procRc, stdout: procChunk, stderr: '' },
      secrets,
    );
    probes.push({
      id: 'proc-1-root-host-marker',
      blocked: procDecision.blocked,
      detail: procDecision.detail,
      status: procRc,
      output: procChunk.slice(0, 400),
    });

    const crossDecision = isEscapeBlocked(
      'cross-container-canary',
      { status: crossRc, stdout: crossChunk, stderr: '' },
      secrets,
    );
    probes.push({
      id: 'cross-container-canary',
      blocked: crossDecision.blocked,
      detail: crossDecision.detail,
      status: crossRc,
      output: crossChunk.slice(0, 400),
    });

    const readBAfter = runner('docker', ['exec', nameB, 'cat', '/tmp/canary-b'], {
      timeout: 30_000,
    });
    const bUnaffected =
      readBAfter.status === 0 && combinedOutput(readBAfter).includes(canaryB);

    const verdict = evaluateExec1Isolation(probes, bUnaffected);
    const details =
      `EXEC-1 gVisor live-fire image=${image}: ${verdict.reason}. ` +
      probes.map((p) => `${p.id}:blocked=${p.blocked}`).join('; ') +
      `; B_unaffected=${bUnaffected}`;

    return {
      ok: verdict.ok,
      details,
      probes,
      bUnaffected,
      image,
    };
  } finally {
    cleanup();
  }
}

function sliceBetween(text: string, startTag: string, endTag: string): string {
  const start = text.indexOf(startTag);
  if (start < 0) return text;
  const from = start + startTag.length;
  const end = text.indexOf(endTag, from);
  if (end < 0) return text.slice(from);
  return text.slice(from, end);
}

function parseTaggedRc(text: string, tag: string): number | null {
  const re = new RegExp(`${tag}(\\d+)`);
  const m = text.match(re);
  if (!m) return null;
  return Number(m[1]);
}
