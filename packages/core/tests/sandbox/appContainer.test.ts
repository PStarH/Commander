/**
 * AppContainerSB Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AppContainerSB,
  buildAppContainerAclGrantScript,
  buildAppContainerAclRollbackScript,
} from '../../src/sandbox/appContainer';

function decodeScriptPayload(script: string): Record<string, unknown> {
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  if (!encoded) throw new Error('PowerShell payload not found');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('buildAppContainerAclGrantScript', () => {
  it('grants access only to the named AppContainer identity', () => {
    const script = buildAppContainerAclGrantScript('Commander-workspace', [
      { path: 'C:\\workspace', access: 'read' },
      { path: 'C:\\workspace\\output', access: 'readwrite' },
    ]);

    expect(script).toContain(
      '$container = Get-AppContainerProfile -Name ([string]$payload.containerName) -ErrorAction Stop',
    );
    expect(script).toContain('$appContainerSid = [string]$container.Sid');
    expect(script).toContain("$identity = '*' + $appContainerSid + ':' + $perm");
    expect(script).toContain('icacls.exe ([string]$entry.path) /grant $identity');
    expect(decodeScriptPayload(script)).toEqual({
      containerName: 'Commander-workspace',
      paths: [
        { path: 'C:\\workspace', access: 'read' },
        { path: 'C:\\workspace\\output', access: 'readwrite' },
      ],
    });
    expect(script).not.toContain('S-1-15-2-1');
    expect(script).not.toContain('ALL_APP_PACKAGES');
  });

  it('keeps malicious container names and paths out of executable PowerShell syntax', () => {
    const marker = 'APP_CONTAINER_PWNED';
    const script = buildAppContainerAclGrantScript('Commander-safe', [
      {
        path: `C:\\workspace\"; Write-Output ${marker}; #`,
        access: 'readwrite',
      },
    ]);

    expect(script).not.toContain(marker);
    expect(script).not.toContain('C:\\workspace');
    expect(script).toContain('FromBase64String');
    expect(script).toContain('icacls.exe ([string]$entry.path) /grant $identity');
    expect(() =>
      buildAppContainerAclGrantScript(`Commander-safe\nWrite-Output ${marker}`, []),
    ).toThrow(/container name/i);
    expect(() =>
      buildAppContainerAclGrantScript('Commander-safe', [
        { path: `C:\\workspace\nWrite-Output ${marker}`, access: 'read' },
      ]),
    ).toThrow(/path/i);
  });
});

describe('AppContainerSB', () => {
  let sb: AppContainerSB;
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-appcontainer-acl-'));
    sb = new AppContainerSB({ aclJournalDir: stateDir });
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('has name appcontainer', () => {
    expect(sb.name).toBe('appcontainer');
  });

  it('reports availability (false on non-Windows)', () => {
    // On macOS/Linux, AppContainer is never available
    expect(typeof sb.available).toBe('boolean');
    // On non-Windows, it should be false
    if (process.platform !== 'win32') {
      expect(sb.available).toBe(false);
    }
  });

  it('returns a result even when unavailable', async () => {
    // execute should not throw, even when unavailable
    const result = await sb.execute('echo test', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: ['/tmp'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });
    expect(result).toBeDefined();
    expect(typeof result.exitCode).toBe('number');
    expect(result.sandboxMechanism).toBe('appcontainer');
  });

  it('handles empty commands gracefully', async () => {
    const result = await sb.execute('', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: [],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });
    expect(result).toBeDefined();
  });

  it('generates a precise-SID ACL rollback command after profile deletion', () => {
    const script = buildAppContainerAclRollbackScript('S-1-15-2-123-456', [
      { path: 'C:\\workspace', access: 'read' },
    ]);

    expect(script).toContain("$identity = '*' + [string]$payload.sid");
    expect(script).toContain('icacls.exe ([string]$entry.path) /remove $identity');
    expect(decodeScriptPayload(script)).toEqual({
      sid: 'S-1-15-2-123-456',
      paths: [{ path: 'C:\\workspace', access: 'read' }],
    });
    expect(script).toContain('ACL_ROLLED_BACK');
    expect(script).not.toContain('ALL_APP_PACKAGES');
  });

  it('keeps rollback path data out of executable PowerShell syntax', () => {
    const marker = 'APP_CONTAINER_ROLLBACK_PWNED';
    const script = buildAppContainerAclRollbackScript('S-1-15-2-123-456', [
      { path: `C:\\workspace\"; Write-Output ${marker}; #`, access: 'read' },
    ]);

    expect(script).not.toContain(marker);
    expect(script).not.toContain('C:\\workspace');
    expect(script).toContain('FromBase64String');
    expect(script).toContain('icacls.exe ([string]$entry.path) /remove $identity');
  });

  it('rolls back journaled ACLs when execution is interrupted', async () => {
    const calls: string[] = [];
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    const internal = sb as unknown as {
      createContainer: () => Promise<void>;
      grantFileAccess: (containerName: string) => Promise<void>;
      executeInContainer: () => Promise<never>;
      deleteContainer: () => Promise<void>;
      rollbackFileAccess: (record: { containerName: string }) => Promise<void>;
    };
    internal.createContainer = async () => undefined;
    internal.grantFileAccess = async (containerName) => {
      fs.writeFileSync(
        journalPath,
        JSON.stringify({
          version: 1,
          records: [
            {
              containerName,
              sid: 'S-1-15-2-123-456',
              paths: [{ path: 'C:\\workspace', access: 'read' }],
            },
          ],
        }),
      );
      throw new Error('interrupted');
    };
    internal.executeInContainer = async () => {
      throw new Error('must not execute');
    };
    internal.deleteContainer = async () => {
      calls.push('delete-profile');
      throw new Error('profile already removed');
    };
    internal.rollbackFileAccess = async (record) => {
      calls.push(`rollback-acl:${record.containerName}`);
    };

    const result = await sb.execute(
      'echo test',
      {
        mode: 'read-only',
        network: 'blocked',
        filesystem: {
          readablePaths: [],
          writablePaths: [],
          protectedPaths: [],
          useStagingDir: false,
        },
      },
      path.join(stateDir, 'workspace'),
    );

    expect(result.exitCode).toBe(-1);
    expect(calls[0]).toBe('delete-profile');
    expect(calls[1]).toMatch(/^rollback-acl:Commander-workspace-/);
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('atomically persists cleanup state before invoking the ACL grant', async () => {
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    const internal = sb as unknown as {
      grantFileAccess: (
        containerName: string,
        profile: {
          mode: 'read-only';
          filesystem: {
            readablePaths: string[];
            writablePaths: string[];
          };
        },
        cwd: string,
      ) => Promise<void>;
      resolveContainerSid: () => Promise<string>;
      runPowerShell: (script: string) => Promise<string>;
    };
    internal.resolveContainerSid = async () => 'S-1-15-2-123-456';
    internal.runPowerShell = async (script) => {
      expect(script).toContain('ACCESS_GRANTED');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
        records: Array<{ containerName: string; sid: string }>;
      };
      expect(journal.records).toEqual([
        expect.objectContaining({
          containerName: 'Commander-workspace',
          sid: 'S-1-15-2-123-456',
        }),
      ]);
      expect(fs.readdirSync(stateDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      return 'ACCESS_GRANTED';
    };

    await internal.grantFileAccess(
      'Commander-workspace',
      {
        mode: 'read-only',
        filesystem: {
          readablePaths: ['C:\\workspace'],
          writablePaths: [],
        },
      },
      'C:\\workspace',
    );
  });

  it('recovers a previous process ACL journal before creating a new profile', async () => {
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        records: [
          {
            containerName: 'Commander-previous',
            sid: 'S-1-15-2-123-456',
            paths: [{ path: 'C:\\previous-workspace', access: 'read' }],
          },
        ],
      }),
    );
    const SandboxWithOptions = AppContainerSB as unknown as new (options: {
      aclJournalDir: string;
    }) => AppContainerSB;
    const recovered = new SandboxWithOptions({ aclJournalDir: stateDir });
    const calls: string[] = [];
    const internal = recovered as unknown as {
      createContainer: (name: string) => Promise<void>;
      grantFileAccess: () => Promise<void>;
      executeInContainer: () => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        durationMs: number;
        sandboxMechanism: 'appcontainer';
      }>;
      deleteContainer: () => Promise<void>;
      rollbackFileAccess: (record: { containerName: string }) => Promise<void>;
    };
    internal.rollbackFileAccess = async (record) => {
      calls.push(`rollback:${record.containerName}`);
    };
    internal.createContainer = async (name) => {
      calls.push(`create:${name}`);
    };
    internal.grantFileAccess = async () => undefined;
    internal.executeInContainer = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      sandboxMechanism: 'appcontainer',
    });
    internal.deleteContainer = async () => undefined;

    await recovered.execute(
      'echo ok',
      {
        mode: 'read-only',
        network: 'blocked',
        filesystem: {
          readablePaths: [],
          writablePaths: [],
          protectedPaths: [],
          useStagingDir: false,
        },
      },
      path.join(stateDir, 'workspace'),
    );

    expect(calls[0]).toBe('rollback:Commander-previous');
    expect(calls[1]).toMatch(/^create:Commander-workspace-/);
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('retains a previous process journal when rollback fails', async () => {
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        records: [
          {
            containerName: 'Commander-previous',
            sid: 'S-1-15-2-123-456',
            paths: [{ path: 'C:\\previous-workspace', access: 'read' }],
          },
        ],
      }),
    );
    const SandboxWithOptions = AppContainerSB as unknown as new (options: {
      aclJournalDir: string;
    }) => AppContainerSB;
    const recovered = new SandboxWithOptions({ aclJournalDir: stateDir });
    const calls: string[] = [];
    const internal = recovered as unknown as {
      createContainer: () => Promise<void>;
      rollbackFileAccess: () => Promise<void>;
    };
    internal.rollbackFileAccess = async () => {
      throw new Error('icacls failed');
    };
    internal.createContainer = async () => {
      calls.push('create');
    };

    const result = await recovered.execute('echo blocked', {
      mode: 'read-only',
      network: 'blocked',
      filesystem: {
        readablePaths: [],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    });

    expect(result.exitCode).toBe(-1);
    expect(calls).toEqual([]);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  it('retries a failed lifecycle rollback before the next profile is created', async () => {
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    const profile = {
      mode: 'read-only' as const,
      network: 'blocked' as const,
      filesystem: {
        readablePaths: ['C:\\workspace'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    };
    const events: string[] = [];
    const created: string[] = [];
    let rollbackAttempts = 0;
    const internal = sb as unknown as {
      createContainer: (name: string) => Promise<void>;
      resolveContainerSid: (name: string) => Promise<string>;
      runPowerShell: () => Promise<string>;
      executeInContainer: (name: string) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        durationMs: number;
        sandboxMechanism: 'appcontainer';
      }>;
      deleteContainer: (name: string) => Promise<void>;
      rollbackFileAccess: (record: { containerName: string }) => Promise<void>;
    };
    internal.createContainer = async (name) => {
      created.push(name);
      events.push(`create:${name}`);
    };
    internal.resolveContainerSid = async (name) => `S-1-15-2-${created.indexOf(name) + 100}`;
    internal.runPowerShell = async () => 'ACCESS_GRANTED';
    internal.executeInContainer = async (name) => {
      events.push(`execute:${name}`);
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        sandboxMechanism: 'appcontainer',
      };
    };
    internal.deleteContainer = async (name) => {
      events.push(`delete:${name}`);
    };
    internal.rollbackFileAccess = async (record) => {
      events.push(`rollback:${record.containerName}`);
      rollbackAttempts += 1;
      if (rollbackAttempts === 1) throw new Error('transient icacls failure');
    };

    const cwd = path.join(stateDir, 'workspace');
    await sb.execute('echo first', profile, cwd);
    const retained = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      records: Array<{ containerName: string }>;
    };
    expect(retained.records).toHaveLength(1);
    const firstContainer = retained.records[0]!.containerName;

    await sb.execute('echo second', profile, cwd);

    const secondContainer = created[1]!;
    expect(events).toEqual([
      `create:${firstContainer}`,
      `execute:${firstContainer}`,
      `delete:${firstContainer}`,
      `rollback:${firstContainer}`,
      `rollback:${firstContainer}`,
      `create:${secondContainer}`,
      `execute:${secondContainer}`,
      `delete:${secondContainer}`,
      `rollback:${secondContainer}`,
    ]);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it('serializes same-workdir lifecycles without reusing identities or journal records', async () => {
    const journalPath = path.join(stateDir, 'appcontainer-acl-cleanup.json');
    const profile = {
      mode: 'read-only' as const,
      network: 'blocked' as const,
      filesystem: {
        readablePaths: ['C:\\workspace'],
        writablePaths: [],
        protectedPaths: [],
        useStagingDir: false,
      },
    };
    const created: string[] = [];
    const journalSnapshots: Array<{
      containerName: string;
      sid: string;
    }> = [];
    const rolledBack: Array<{ containerName: string; sid: string }> = [];
    let recoveries = 0;
    let activeLifecycles = 0;
    let maxActiveLifecycles = 0;
    let executionCount = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const internal = sb as unknown as {
      recoverPendingAclGrants: () => Promise<void>;
      createContainer: (name: string) => Promise<void>;
      resolveContainerSid: (name: string) => Promise<string>;
      runPowerShell: () => Promise<string>;
      executeInContainer: (name: string) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        durationMs: number;
        sandboxMechanism: 'appcontainer';
      }>;
      deleteContainer: () => Promise<void>;
      rollbackFileAccess: (record: { containerName: string; sid: string }) => Promise<void>;
    };
    internal.recoverPendingAclGrants = async () => {
      recoveries += 1;
    };
    internal.createContainer = async (name) => {
      created.push(name);
      activeLifecycles += 1;
      maxActiveLifecycles = Math.max(maxActiveLifecycles, activeLifecycles);
    };
    internal.resolveContainerSid = async (name) => `S-1-15-2-${created.indexOf(name) + 100}`;
    internal.runPowerShell = async () => 'ACCESS_GRANTED';
    internal.executeInContainer = async (name) => {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
        records: Array<{ containerName: string; sid: string }>;
      };
      expect(journal.records).toHaveLength(1);
      journalSnapshots.push(journal.records[0]!);
      executionCount += 1;
      if (executionCount === 1) {
        markFirstStarted();
        await firstRelease;
      }
      return {
        stdout: name,
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        sandboxMechanism: 'appcontainer',
      };
    };
    internal.deleteContainer = async () => {
      activeLifecycles -= 1;
    };
    internal.rollbackFileAccess = async (record) => {
      rolledBack.push(record);
    };

    const cwd = path.join(stateDir, 'same-workspace');
    const first = sb.execute('echo first', profile, cwd);
    await firstStarted;
    const second = sb.execute('echo second', profile, cwd);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(recoveries).toBe(1);
    expect(created).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toEqual({
      version: 1,
      records: [journalSnapshots[0]],
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(maxActiveLifecycles).toBe(1);
    expect(created).toHaveLength(2);
    expect(new Set(created).size).toBe(2);
    expect(journalSnapshots).toEqual([
      expect.objectContaining({ containerName: created[0], sid: 'S-1-15-2-100' }),
      expect.objectContaining({ containerName: created[1], sid: 'S-1-15-2-101' }),
    ]);
    expect(rolledBack).toEqual(journalSnapshots);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'does not execute a malicious rollback path in Windows PowerShell',
    () => {
      const marker = path.join(stateDir, 'acl-injection-marker.txt');
      const maliciousPath = `C:\\missing\"; Set-Content -Path '${marker}' -Value PWNED; #`;
      const script = buildAppContainerAclRollbackScript('S-1-15-2-123-456', [
        { path: maliciousPath, access: 'read' },
      ]);

      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 10_000 },
      );
      expect(fs.existsSync(marker)).toBe(false);
    },
  );
});
