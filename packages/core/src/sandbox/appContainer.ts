/**
 * AppContainerSB — Windows AppContainer sandbox.
 *
 * Implements PlatformSandbox using Windows AppContainer isolation (Windows 8+).
 *
 * AppContainer provides:
 *   - Capability-based access control (capability SIDs)
 *   - Network isolation (per-container firewall rules)
 *   - File system isolation (AppContainer-specific directories)
 *   - Registry isolation
 *   - Process integrity level (Low IL by default)
 *
 * Based on:
 *   - Windows AppContainer Isolation (MSDN)
 *   - Chromium sandbox (sandbox/win/src/app_container)
 *   - Codex CLI's Windows sandbox research
 *
 * Implementation uses PowerShell + icacls to:
 *   1. Create an AppContainer profile with specific capabilities
 *   2. Grant file access to workspace directories
 *   3. Launch commands inside the AppContainer
 *   4. Clean up the container after execution
 *
 * Required capabilities (minimum set):
 *   - internetClient (if network allowed)
 *   - privateNetworkClientServer (if network allowed)
 *   - documentsLibrary (if workspace-write mode)
 *
 * Note: Only available on Windows 8+ (build 9200+).
 * On non-Windows platforms, available = false.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import type { PlatformSandbox, SandboxProfile, SandboxExecutionResult } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// ============================================================================
// AppContainerSB
// ============================================================================

type AppContainerAclPath = { path: string; access: 'read' | 'readwrite' };

function validateContainerName(containerName: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(containerName)) {
    throw new Error('Invalid AppContainer container name');
  }
}

function validateAclPaths(paths: ReadonlyArray<AppContainerAclPath>): void {
  for (const entry of paths) {
    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      /[\0\r\n]/.test(entry.path) ||
      (entry.access !== 'read' && entry.access !== 'readwrite')
    ) {
      throw new Error('Invalid AppContainer ACL path');
    }
  }
}

function normalizeAclPaths(paths: ReadonlyArray<AppContainerAclPath>): AppContainerAclPath[] {
  validateAclPaths(paths);
  const normalized = new Map<string, AppContainerAclPath>();
  for (const entry of paths) {
    const existing = normalized.get(entry.path);
    if (!existing || entry.access === 'readwrite') normalized.set(entry.path, { ...entry });
  }
  return Array.from(normalized.values());
}

function encodePowerShellPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function buildAppContainerAclGrantScript(
  containerName: string,
  paths: ReadonlyArray<AppContainerAclPath>,
): string {
  validateContainerName(containerName);
  const normalizedPaths = normalizeAclPaths(paths);
  const payload = encodePowerShellPayload({ containerName, paths: normalizedPaths });

  return [
    `$ErrorActionPreference = "Stop"`,
    `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    `$payload = $payloadJson | ConvertFrom-Json`,
    `$container = Get-AppContainerProfile -Name ([string]$payload.containerName) -ErrorAction Stop`,
    `if (-not $container -or -not $container.Sid) { throw "AppContainer SID not found" }`,
    `$appContainerSid = [string]$container.Sid`,
    `$ErrorActionPreference = "SilentlyContinue"`,
    `$aclFailed = $false`,
    `foreach ($entry in @($payload.paths)) {`,
    `  $perm = if ([string]$entry.access -eq 'readwrite') { '(OI)(CI)(RX,W)' } else { '(OI)(CI)(RX)' }`,
    `  $identity = '*' + $appContainerSid + ':' + $perm`,
    `  & icacls.exe ([string]$entry.path) /grant $identity /T /C /Q 2>$null`,
    `  if ($LASTEXITCODE -ne 0) { $aclFailed = $true }`,
    `}`,
    `if ($aclFailed) { Write-Error "One or more AppContainer ACL grants failed"; exit 1 }`,
    `Write-Host "ACCESS_GRANTED"`,
  ].join('; ');
}

export function buildAppContainerAclRollbackScript(
  sid: string,
  paths: ReadonlyArray<AppContainerAclPath>,
): string {
  if (!/^S-\d+(?:-\d+)+$/i.test(sid)) {
    throw new Error('Invalid AppContainer SID');
  }
  const normalizedPaths = normalizeAclPaths(paths).sort(
    (left, right) => right.path.length - left.path.length,
  );
  const payload = encodePowerShellPayload({ sid, paths: normalizedPaths });
  return [
    `$ErrorActionPreference = "SilentlyContinue"`,
    `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    `$payload = $payloadJson | ConvertFrom-Json`,
    `$identity = '*' + [string]$payload.sid`,
    `$aclFailed = $false`,
    `foreach ($entry in @($payload.paths)) {`,
    `  & icacls.exe ([string]$entry.path) /remove $identity /T /C /Q 2>$null`,
    `  if ($LASTEXITCODE -ne 0) { $aclFailed = $true }`,
    `}`,
    `if ($aclFailed) { Write-Error "One or more AppContainer ACL rollbacks failed"; exit 1 }`,
    `Write-Host "ACL_ROLLED_BACK"`,
  ].join('; ');
}

interface AppContainerAclRecord {
  containerName: string;
  sid: string;
  paths: AppContainerAclPath[];
}

interface AppContainerAclJournal {
  version: 1;
  records: AppContainerAclRecord[];
}

export interface AppContainerSBOptions {
  /** Operator-owned state outside the workspace. */
  aclJournalDir?: string;
}

export class AppContainerSB implements PlatformSandbox {
  readonly name = 'appcontainer' as const;
  readonly available: boolean;
  private readonly aclJournalPath: string;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private journalQueue: Promise<void> = Promise.resolve();
  private aclRecovery?: Promise<void>;
  private aclCleanupRetryNeeded = false;

  constructor(options: AppContainerSBOptions = {}) {
    const operatorStateDir =
      options.aclJournalDir ??
      process.env.COMMANDER_OPERATOR_STATE_DIR ??
      path.join(os.homedir(), '.commander', 'operator-state');
    this.aclJournalPath = path.join(operatorStateDir, 'appcontainer-acl-cleanup.json');
    this.available = this.checkAvailability();
  }

  private checkAvailability(): boolean {
    if (os.platform() !== 'win32') return false;
    try {
      // Check if running on Windows 8+ (build 9200)
      const release = os.release();
      const build = parseInt(release.split('.').pop() ?? '0', 10);
      if (build < 9200) {
        getGlobalLogger().debug('AppContainerSB', `Windows build ${build} < 9200 (Win8 required)`);
        return false;
      }

      // Verify we can run PowerShell and that the AppContainer cmdlets exist
      execSync(
        'powershell.exe -NoProfile -Command "if (-not (Get-Command New-AppContainerProfile -ErrorAction SilentlyContinue)) { exit 1 }"',
        { timeout: 5000 },
      );

      // Functional smoke test: create and delete a test container. Some Windows
      // environments (e.g. GitHub Actions runners) expose the cmdlet but block
      // the operation or the subsequent icacls grant.
      const testName = `Commander-SmokeTest-${process.pid}`;
      execSync(
        `powershell.exe -NoProfile -Command "` +
          `$ErrorActionPreference = 'Stop'; ` +
          `New-AppContainerProfile -Name '${testName}' -DisplayName 'Commander Smoke Test'; ` +
          `Remove-AppContainerProfile -Name '${testName}' -Confirm:$false -ErrorAction SilentlyContinue;"`,
        { timeout: 10000 },
      );

      return true;
    } catch (e) {
      getGlobalLogger().debug('AppContainerSB', 'AppContainer unavailable', {
        error: (e as Error)?.message,
      });
      return false;
    }
  }

  async execute(
    cmd: string,
    profile: SandboxProfile,
    workdir?: string,
  ): Promise<SandboxExecutionResult> {
    const result = this.lifecycleQueue.then(
      () => this.executeLifecycle(cmd, profile, workdir),
      () => this.executeLifecycle(cmd, profile, workdir),
    );
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeLifecycle(
    cmd: string,
    profile: SandboxProfile,
    workdir?: string,
  ): Promise<SandboxExecutionResult> {
    const start = Date.now();
    const cwd = workdir ?? process.cwd();
    const containerName = this.createContainerName(cwd);

    try {
      // Recover durable cleanup work left by a prior crash/SIGKILL before
      // granting any new host filesystem access. This promise is intentionally
      // sticky: a failed recovery blocks later lifecycles on this instance.
      await this.prepareAclJournalForLifecycle();

      // Step 1: Create AppContainer profile
      await this.createContainer(containerName, profile);

      // Step 2: Grant file system access
      await this.grantFileAccess(containerName, profile, cwd);

      // Step 3: Execute command inside the container
      const result = await this.executeInContainer(containerName, cmd, profile, cwd, start);

      return result;
    } catch (err) {
      getGlobalLogger().error('AppContainerSB', 'Execution failed', err as Error);
      return {
        stdout: '',
        stderr: (err as Error)?.message ?? 'Unknown AppContainer error',
        exitCode: -1,
        durationMs: Date.now() - start,
        sandboxMechanism: 'appcontainer',
      };
    } finally {
      // Step 4: Delete the profile, then remove its precise SID ACEs. The SID
      // remains usable after profile deletion, so rollback must not depend on
      // looking the profile up again.
      await this.deleteContainer(containerName).catch(() => {
        /* still attempt ACL rollback when profile deletion fails */
      });
      await this.withJournalLock(() => this.cleanupAclForContainer(containerName)).catch((err) => {
        // Keep the durable record for the next process/execution retry.
        this.aclCleanupRetryNeeded = true;
        reportSilentFailure(err, 'appContainer:aclRollback');
      });
    }
  }

  // ── Container Lifecycle ───────────────────────────────────────────

  private async createContainer(name: string, profile: SandboxProfile): Promise<void> {
    validateContainerName(name);
    const caps: string[] = [];

    // Network capabilities
    if (profile.network === 'full' || profile.network === 'proxy') {
      caps.push('internetClient');
      caps.push('privateNetworkClientServer');
    }

    // File system capabilities
    if (profile.mode !== 'read-only') {
      caps.push('documentsLibrary');
    }

    const payload = encodePowerShellPayload({ name, capabilities: caps });
    const psCommand = [
      `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      `$payload = $payloadJson | ConvertFrom-Json`,
      `$name = [string]$payload.name`,
      `$params = @{ Name = $name; DisplayName = ('Commander Sandbox: ' + $name); ErrorAction = 'SilentlyContinue' }`,
      `if (@($payload.capabilities).Count -gt 0) { $params.CapabilityName = @($payload.capabilities) }`,
      `New-AppContainerProfile @params`,
      `Write-Host "CONTAINER_CREATED"`,
    ].join('; ');

    await this.runPowerShell(psCommand);
    getGlobalLogger().debug('AppContainerSB', `Container ${name} created`, {
      capabilities: caps,
    });
  }

  private async grantFileAccess(
    containerName: string,
    profile: SandboxProfile,
    _cwd: string,
  ): Promise<void> {
    // Build list of paths to grant access
    const paths: Array<{ path: string; access: 'read' | 'readwrite' }> = [];

    for (const rp of profile.filesystem.readablePaths) {
      paths.push({ path: path.resolve(rp), access: 'read' });
    }

    if (profile.mode !== 'read-only') {
      for (const wp of profile.filesystem.writablePaths) {
        paths.push({ path: path.resolve(wp), access: 'readwrite' });
      }
    }

    // Grant temp directory access
    paths.push({ path: path.resolve(os.tmpdir()), access: 'readwrite' });

    if (paths.length > 0) {
      const sid = await this.resolveContainerSid(containerName);
      const normalizedPaths = normalizeAclPaths(paths);
      await this.withJournalLock(() =>
        this.appendAclRecord({ containerName, sid, paths: normalizedPaths }),
      );
      await this.runPowerShell(buildAppContainerAclGrantScript(containerName, normalizedPaths));
    }
  }

  private async resolveContainerSid(containerName: string): Promise<string> {
    validateContainerName(containerName);
    const payload = encodePowerShellPayload({ containerName });
    const output = await this.runPowerShell(
      [
        `$ErrorActionPreference = "Stop"`,
        `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
        `$payload = $payloadJson | ConvertFrom-Json`,
        `$container = Get-AppContainerProfile -Name ([string]$payload.containerName) -ErrorAction Stop`,
        `if (-not $container -or -not $container.Sid) { throw "AppContainer SID not found" }`,
        `Write-Output "APP_CONTAINER_SID=$([string]$container.Sid)"`,
      ].join('; '),
    );
    const sid = output.match(/APP_CONTAINER_SID=(S-\d+(?:-\d+)+)/i)?.[1];
    if (!sid) throw new Error('PowerShell did not return the AppContainer SID');
    return sid;
  }

  private async rollbackFileAccess(acl: AppContainerAclRecord): Promise<void> {
    if (acl.paths.length === 0) return;
    await this.runPowerShell(buildAppContainerAclRollbackScript(acl.sid, acl.paths));
  }

  private async executeInContainer(
    containerName: string,
    cmd: string,
    profile: SandboxProfile,
    cwd: string,
    startMs: number,
  ): Promise<SandboxExecutionResult> {
    const env = this.filterEnv(profile);

    // Use PowerShell to launch with AppContainer context.
    // Invoke-CommandInAppContainer requires Windows 10 1809+.
    // Fallback: use START /APPCONTAINER.
    // Base64-encode the command so PowerShell metacharacters cannot break out
    // of the ScriptBlock argument list.
    validateContainerName(containerName);
    const b64Cmd = Buffer.from(cmd, 'utf-8').toString('base64');
    const payload = encodePowerShellPayload({ containerName, command: b64Cmd });

    const psScript = [
      `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      `$payload = $payloadJson | ConvertFrom-Json`,
      `$container = Get-AppContainerProfile -Name ([string]$payload.containerName) -ErrorAction SilentlyContinue`,
      `if (-not $container) { Write-Error "Container not found"; exit 1 }`,
      `$sid = $container.Sid`,
      // Use Invoke-CommandInAppContainer (Win10 1809+)
      `$result = Invoke-CommandInAppContainer -AppContainerSid $sid -ArgumentList ([string]$payload.command) -ScriptBlock {`,
      `  param($b64CmdStr)`,
      `  $ErrorActionPreference = "Continue"`,
      `  try {`,
      `    $cmdStr = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64CmdStr))`,
      `    $out = cmd /c "$cmdStr" 2>&1`,
      `    Write-Host $out`,
      `    exit $LASTEXITCODE`,
      `  } catch {`,
      `    Write-Error $_.Exception.Message`,
      `    exit 1`,
      `  }`,
      `}`,
    ].join('\n');

    // Write PowerShell script to temp file
    const tmpDir = this.getTempDir();
    const scriptPath = path.join(tmpDir, `cmd-${randomBytes(16).toString('hex')}.ps1`);
    const fs = await import('fs');
    await fs.promises.writeFile(scriptPath, psScript, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
      } catch (err) {
        try {
          fs.unlinkSync(scriptPath);
        } catch (err) {
          reportSilentFailure(err, 'appContainer:300');
          /* ignore */
        }
        resolve({
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: -1,
          durationMs: Date.now() - startMs,
          sandboxMechanism: 'appcontainer',
        });
        return;
      }

      let stdout = '',
        stderr = '';
      let stdoutTruncated = false,
        stderrTruncated = false;
      const MAX_OUTPUT = 10 * 1024 * 1024;

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT) {
            stdout = stdout.slice(0, MAX_OUTPUT);
            stdoutTruncated = true;
          }
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT) {
            stderr = stderr.slice(0, MAX_OUTPUT);
            stderrTruncated = true;
          }
        }
      });

      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, profile.timeout ?? 120000);
      killTimer.unref();

      const finalize = () => {
        clearTimeout(killTimer);
        try {
          fs.unlinkSync(scriptPath);
        } catch (err) {
          reportSilentFailure(err, 'appContainer:350');
          /* ignore */
        }
      };

      child.on('close', (ec) => {
        finalize();
        resolve({
          stdout: stdoutTruncated ? stdout + '\n[truncated]' : stdout,
          stderr: stderrTruncated ? stderr + '\n[truncated]' : stderr,
          exitCode: timedOut ? 137 : (ec ?? -1),
          durationMs: Date.now() - startMs,
          sandboxMechanism: 'appcontainer',
        });
      });

      child.on('error', (err) => {
        finalize();
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: -1,
          durationMs: Date.now() - startMs,
          sandboxMechanism: 'appcontainer',
        });
      });
    });
  }

  private async deleteContainer(name: string): Promise<void> {
    validateContainerName(name);
    const payload = encodePowerShellPayload({ name });
    const psCommand = [
      `$ErrorActionPreference = "SilentlyContinue"`,
      `$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      `$payload = $payloadJson | ConvertFrom-Json`,
      `Remove-AppContainerProfile -Name ([string]$payload.name) -Confirm:$false -ErrorAction SilentlyContinue`,
      `Write-Host "CONTAINER_DELETED"`,
    ].join('; ');

    await this.runPowerShell(psCommand);
  }

  private withJournalLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.journalQueue.then(operation, operation);
    this.journalQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private recoverPendingAclGrantsOnce(): Promise<void> {
    this.aclRecovery ??= this.withJournalLock(() => this.recoverPendingAclGrants());
    return this.aclRecovery;
  }

  private async prepareAclJournalForLifecycle(): Promise<void> {
    await this.recoverPendingAclGrantsOnce();
    if (!this.aclCleanupRetryNeeded) return;
    await this.withJournalLock(() => this.recoverPendingAclGrants());
    this.aclCleanupRetryNeeded = false;
  }

  private async readAclJournal(): Promise<AppContainerAclJournal> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.aclJournalPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Invalid AppContainer ACL cleanup journal; refusing new ACL grants');
    }
    const candidate = parsed as Partial<AppContainerAclJournal>;
    if (candidate.version !== 1 || !Array.isArray(candidate.records)) {
      throw new Error('Invalid AppContainer ACL cleanup journal; refusing new ACL grants');
    }
    for (const record of candidate.records) {
      validateContainerName(record.containerName);
      if (!/^S-\d+(?:-\d+)+$/i.test(record.sid)) {
        throw new Error('Invalid AppContainer ACL cleanup journal SID');
      }
      if (!Array.isArray(record.paths)) {
        throw new Error('Invalid AppContainer ACL cleanup journal paths');
      }
      validateAclPaths(record.paths);
    }
    return { version: 1, records: candidate.records };
  }

  private async writeAclJournal(journal: AppContainerAclJournal): Promise<void> {
    const dir = path.dirname(this.aclJournalPath);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.aclJournalPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let tmpFile: fsp.FileHandle | undefined;
    try {
      tmpFile = await fsp.open(tmpPath, 'wx', 0o600);
      await tmpFile.writeFile(JSON.stringify(journal), 'utf8');
      await tmpFile.sync();
      await tmpFile.close();
      tmpFile = undefined;
      await fsp.rename(tmpPath, this.aclJournalPath);
      if (journal.records.length === 0) {
        await fsp.unlink(this.aclJournalPath);
      }
    } catch (err) {
      await tmpFile?.close().catch(() => undefined);
      await fsp.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  private async appendAclRecord(record: AppContainerAclRecord): Promise<void> {
    const journal = await this.readAclJournal();
    if (journal.records.some((existing) => existing.containerName === record.containerName)) {
      throw new Error('Duplicate AppContainer ACL cleanup journal record');
    }
    journal.records.push(record);
    await this.writeAclJournal(journal);
  }

  private async recoverPendingAclGrants(): Promise<void> {
    const journal = await this.readAclJournal();
    while (journal.records.length > 0) {
      const record = journal.records[0]!;
      await this.rollbackFileAccess(record);
      journal.records.shift();
      await this.writeAclJournal(journal);
    }
  }

  private async cleanupAclForContainer(containerName: string): Promise<void> {
    const journal = await this.readAclJournal();
    const record = journal.records.find((candidate) => candidate.containerName === containerName);
    if (!record) return;
    await this.rollbackFileAccess(record);
    journal.records = journal.records.filter((candidate) => candidate !== record);
    await this.writeAclJournal(journal);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async runPowerShell(script: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

      let output = '';
      let errorOutput = '';
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`PowerShell timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        errorOutput += d.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (
          code === 0 ||
          output.includes('CONTAINER_CREATED') ||
          output.includes('ACCESS_GRANTED') ||
          output.includes('CONTAINER_DELETED')
        ) {
          resolve(output);
        } else {
          reject(new Error(errorOutput || `PowerShell exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (!settled) reject(err);
      });
    });
  }

  private sanitizeName(cwd: string): string {
    const sanitized = path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 25);
    return sanitized || 'workspace';
  }

  private createContainerName(cwd: string): string {
    return `Commander-${this.sanitizeName(cwd)}-${randomBytes(12).toString('hex')}`;
  }

  private getTempDir(): string {
    return os.tmpdir();
  }

  private filterEnv(profile: SandboxProfile): Record<string, string> {
    const env: Record<string, string> = {};
    const denyList = (profile.envVarDenyList ?? []).map((x) => x.toUpperCase());
    const allowList = profile.envVarAllowList ?? [];

    const SECRETS = [
      'API_KEY',
      'TOKEN',
      'SECRET',
      'PASSWORD',
      'CREDENTIAL',
      'PRIVATE_KEY',
      'SIGNING_KEY',
      'ENCRYPTION_KEY',
      'DATABASE_URL',
      'REDIS_URL',
      'CONNECTION_STRING',
    ];

    for (const [k, v] of Object.entries(process.env)) {
      const upper = k.toUpperCase();
      if (allowList.length > 0 && !allowList.includes(k)) continue;
      if (denyList.some((d) => upper.includes(d))) continue;
      if (SECRETS.some((s) => upper.includes(s))) continue;
      if (k.startsWith('DOCKER_') || k.startsWith('SSH_')) continue;
      if (v !== undefined) env[k] = v;
    }

    return env;
  }
}
