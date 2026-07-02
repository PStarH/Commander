// packages/core/src/chaos/l2ToolLayer.ts

export type FailureMode =
  | 'http_5xx'
  | 'http_timeout'
  | 'http_4xx'
  | 'disk_full'
  | 'oom'
  | 'process_crash'
  | 'state_corrupt'
  | 'dependency_unavailable'
  | 'time_drift'
  | 'auth_expired';

export interface L2FaultConfig {
  tool: string;
  mode: FailureMode;
  statusCode?: number;
  delayMs?: number;
}

export class L2ToolLayer {
  private rules: L2FaultConfig[] = [];

  arm(fault: L2FaultConfig): void {
    this.rules.push(fault);
  }

  disarm(): void {
    this.rules = [];
  }

  getActiveFaults(tool: string): L2FaultConfig[] {
    return this.rules.filter((r) => r.tool === tool);
  }

  async intercept<T>(tool: string, _args: unknown, handler: () => Promise<T>): Promise<T> {
    const rule = this.rules.find((r) => r.tool === tool);
    if (!rule) {
      return handler();
    }

    if (rule.delayMs) {
      await new Promise((r) => setTimeout(r, rule.delayMs));
    }

    switch (rule.mode) {
      case 'http_5xx':
        throw new Error(`Tool ${tool} returned ${rule.statusCode ?? 500}`);
      case 'http_4xx':
        throw new Error(`Tool ${tool} returned ${rule.statusCode ?? 400}`);
      case 'http_timeout':
        throw new Error(`Tool ${tool} timed out`);
      case 'disk_full':
        throw new Error(`Tool ${tool} failed: ENOSPC: no space left on device`);
      case 'oom':
        throw new Error(`Tool ${tool} failed: JavaScript heap out of memory`);
      case 'process_crash':
        throw new Error(`Tool ${tool} failed: process exited unexpectedly`);
      case 'state_corrupt':
        throw new Error(`Tool ${tool} failed: state file is corrupt`);
      case 'dependency_unavailable':
        throw new Error(`Tool ${tool} failed: required dependency unavailable`);
      case 'time_drift':
        throw new Error(`Tool ${tool} failed: clock drift exceeds threshold`);
      case 'auth_expired':
        throw new Error(`Tool ${tool} failed: authentication token expired`);
      default:
        return handler();
    }
  }
}
