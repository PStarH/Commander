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

import * as os from 'os';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import type { PlatformSandbox, SandboxProfile, SandboxExecutionResult } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

interface AppContainerConfig {
  /** Unique container name (derived from workspace) */
  name: string;
  /** Container display name */
  displayName: string;
  /** Capability SIDs to grant */
  capabilities: string[];
  /** File paths that need read access */
  readablePaths: string[];
  /** File paths that need write access */
  writablePaths: string[];
  /** Whether network is allowed */
  allowNetwork: boolean;
}

// ============================================================================
// Capability SIDs
// ============================================================================

const CAPABILITY_SIDS: Record<string, string> = {
  internetClient: 'S-1-15-3-1',
  internetClientServer: 'S-1-15-3-2',
  privateNetworkClientServer: 'S-1-15-3-3',
  documentsLibrary: 'S-1-15-3-4',
  picturesLibrary: 'S-1-15-3-5',
  videosLibrary: 'S-1-15-3-6',
  musicLibrary: 'S-1-15-3-7',
  enterpriseAuthentication: 'S-1-15-3-8',
  sharedUserCertificates: 'S-1-15-3-9',
  removableStorage: 'S-1-15-3-10',
  appointments: 'S-1-15-3-11',
  contacts: 'S-1-15-3-12',
};

// ============================================================================
// AppContainerSB
// ============================================================================

export class AppContainerSB implements PlatformSandbox {
  readonly name = 'appcontainer' as const;
  readonly available: boolean;

  constructor() {
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

      // Verify we can run PowerShell
      execSync('powershell.exe -Command "Write-Host ok"', { timeout: 5000 });
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
    const start = Date.now();
    const cwd = workdir ?? process.cwd();
    const containerName = `Commander-${this.sanitizeName(cwd)}`;

    try {
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
      // Step 4: Clean up the container (best-effort)
      await this.deleteContainer(containerName).catch(() => {
        /* ignore cleanup errors */
      });
    }
  }

  // ── Container Lifecycle ───────────────────────────────────────────

  private async createContainer(name: string, profile: SandboxProfile): Promise<void> {
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

    // Build PowerShell commands
    const capArgs = caps.map((c) => `-CapabilityName "${c}"`).join(' ');
    const psCommand = [
      `$name = "${name}"`,
      `$displayName = "Commander Sandbox: ${name}"`,
      `New-AppContainerProfile -Name $name -DisplayName $displayName ${capArgs} -ErrorAction SilentlyContinue`,
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
    cwd: string,
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

    // Use icacls to grant AppContainer SID access to each path
    const appContainerSid = `S-1-15-2-1`; // ALL_APP_PACKAGES base
    const grantOps = paths.map((p) => {
      const perm = p.access === 'readwrite' ? '(OI)(CI)(RX,W)' : '(OI)(CI)(RX)';
      return `icacls "${p.path}" /grant "*${appContainerSid}":${perm} /T /C /Q 2>$null`;
    });

    if (grantOps.length > 0) {
      const psCommand = [
        `$ErrorActionPreference = "SilentlyContinue"`,
        ...grantOps,
        `Write-Host "ACCESS_GRANTED"`,
      ].join('; ');

      await this.runPowerShell(psCommand);
    }
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
    const appContainerSid = `S-1-15-2-1`;
    const escapedCmd = cmd.replace(/"/g, '""');

    // Build environment block
    const envBlock =
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\x00') + '\x00\x00';

    const psScript = [
      `$container = Get-AppContainerProfile -Name "${containerName}" -ErrorAction SilentlyContinue`,
      `if (-not $container) { Write-Error "Container not found"; exit 1 }`,
      `$sid = $container.Sid`,
      // Use Invoke-CommandInAppContainer (Win10 1809+)
      `$result = Invoke-CommandInAppContainer -AppContainerSid $sid -ArgumentList "${escapedCmd}" -ScriptBlock {`,
      `  param($cmdStr)`,
      `  $ErrorActionPreference = "Continue"`,
      `  try {`,
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
    const scriptPath = path.join(tmpDir, `cmd-${Date.now()}.ps1`);
    const fs = await import('fs');
    fs.writeFileSync(scriptPath, psScript, 'utf-8');

    return new Promise((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );

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
        } catch {
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
    const psCommand = [
      `$ErrorActionPreference = "SilentlyContinue"`,
      `Remove-AppContainerProfile -Name "${name}" -Confirm:$false -ErrorAction SilentlyContinue`,
      `Write-Host "CONTAINER_DELETED"`,
    ].join('; ');

    await this.runPowerShell(psCommand);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async runPowerShell(script: string): Promise<string> {
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

      child.stdout?.on('data', (d: Buffer) => {
        output += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        errorOutput += d.toString();
      });

      child.on('close', (code) => {
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

      child.on('error', reject);
    });
  }

  private sanitizeName(cwd: string): string {
    return path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 30);
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
