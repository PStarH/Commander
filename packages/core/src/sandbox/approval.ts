import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecPolicyEngine } from './execPolicy';
import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto' | 'read-only' | 'plan';
export type ApprovalCategory =
  | 'sandbox_escape'
  | 'network'
  | 'file_write'
  | 'file_read'
  | 'shell_exec'
  | 'destructive'
  | 'mcp';

export interface ApprovalGate {
  category: ApprovalCategory;
  action: string;
  reason?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface ApprovalRequest {
  id: string;
  timestamp: number;
  gate: ApprovalGate;
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentId: string;
  runId: string;
}

export type ApprovalDecision =
  | 'approved'
  | 'denied'
  | 'approved_once'
  | 'approved_session'
  | 'denied_forever';

export interface ApprovalCallback {
  (request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class ApprovalSystem {
  private mode: ApprovalMode = 'suggest';
  private callback: ApprovalCallback | null = null;
  private sessionApprovals: Set<string> = new Set();
  private deniedForever: Map<string, number> = new Map();
  private static readonly MAX_CACHE_SIZE = 5000;
  private execPolicy: ExecPolicyEngine;
  private static readonly DENIED_THRESHOLD = 3;
  private persistFile: string;

  constructor(execPolicy?: ExecPolicyEngine, persistDir?: string) {
    this.execPolicy = execPolicy ?? new ExecPolicyEngine();
    this.persistFile = path.join(persistDir ?? process.cwd(), '.commander', 'approval-mode.json');
    this.loadMode();
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
    this.persistMode();
  }

  getMode(): ApprovalMode {
    return this.mode;
  }

  private persistMode(): void {
    try {
      const dir = path.dirname(this.persistFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistFile, JSON.stringify({ mode: this.mode }), 'utf-8');
    } catch (e) {
      getGlobalLogger().debug('ApprovalSystem', 'Failed to persist mode', {
        error: (e as Error)?.message,
      });
    }
  }

  private loadMode(): void {
    try {
      if (fs.existsSync(this.persistFile)) {
        const data = JSON.parse(fs.readFileSync(this.persistFile, 'utf-8'));
        const validModes: ApprovalMode[] = [
          'suggest',
          'auto-edit',
          'full-auto',
          'read-only',
          'plan',
        ];
        if (validModes.includes(data.mode)) {
          this.mode = data.mode;
        }
      }
    } catch (e) {
      getGlobalLogger().debug('ApprovalSystem', 'Failed to load persisted mode, using default', {
        error: (e as Error)?.message,
      });
    }
  }

  setCallback(cb: ApprovalCallback): void {
    this.callback = cb;
  }

  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
  }

  async evaluate(req: ApprovalRequest): Promise<{ decision: ApprovalDecision; reason: string }> {
    const audit = getSecurityAuditLogger();
    const cacheKey = `${req.toolName}:${JSON.stringify(req.toolArgs)}`;

    if (this.sessionApprovals.has(cacheKey)) {
      return { decision: 'approved_session', reason: 'Previously approved for session' };
    }

    const denyCount = this.deniedForever.get(cacheKey) ?? 0;
    if (denyCount >= ApprovalSystem.DENIED_THRESHOLD) {
      audit.logExecPolicyForbidden(
        'ApprovalSystem',
        `Blocked after ${denyCount} consecutive denials`,
        {
          toolName: req.toolName,
          category: req.gate.category,
          denyCount,
        },
      );
      return { decision: 'denied', reason: `Blocked after ${denyCount} consecutive denials` };
    }

    const policyResult = this.evaluatePolicy(req);
    if (policyResult.decision === 'forbidden') {
      audit.logExecPolicyForbidden('ApprovalSystem', policyResult.reason, {
        toolName: req.toolName,
        category: req.gate.category,
      });
      return { decision: 'denied', reason: policyResult.reason };
    }

    const modeResult = this.evaluateMode(req);
    if (modeResult.decision === 'approved') {
      return { decision: 'approved', reason: modeResult.reason };
    }

    if (modeResult.decision === 'denied') {
      audit.logApprovalDenied('ApprovalSystem', modeResult.reason, {
        toolName: req.toolName,
        category: req.gate.category,
        mode: this.mode,
      });
      return { decision: 'denied', reason: modeResult.reason };
    }

    if (this.callback) {
      const cbDecision = await this.callback(req);
      if (cbDecision === 'approved_once') {
        return { decision: 'approved_once', reason: 'Approved by callback' };
      }
      if (cbDecision === 'approved_session') {
        this.sessionApprovals.add(cacheKey);
        if (this.sessionApprovals.size > ApprovalSystem.MAX_CACHE_SIZE) {
          const first = this.sessionApprovals.values().next().value;
          if (first) this.sessionApprovals.delete(first);
        }
        return { decision: 'approved_session', reason: 'Approved for session' };
      }
      if (cbDecision === 'denied_forever') {
        this.deniedForever.set(cacheKey, denyCount + 1);
        if (this.deniedForever.size > ApprovalSystem.MAX_CACHE_SIZE) {
          const first = this.deniedForever.keys().next().value;
          if (first) this.deniedForever.delete(first);
        }
        audit.logApprovalDenied('ApprovalSystem', 'Permanently denied by user callback', {
          toolName: req.toolName,
          category: req.gate.category,
        });
        return { decision: 'denied', reason: 'Denied by callback' };
      }
      return { decision: cbDecision, reason: 'Callback decision' };
    }
    // No callback and mode defers: safe default is deny
    if (modeResult.decision === 'defer') {
      audit.logApprovalDenied('ApprovalSystem', `No approval callback: ${modeResult.reason}`, {
        toolName: req.toolName,
        category: req.gate.category,
        mode: this.mode,
      });
      return { decision: 'denied', reason: `No approval callback available: ${modeResult.reason}` };
    }
    return { decision: 'approved', reason: 'No approval required' };
  }

  private evaluatePolicy(req: ApprovalRequest): {
    decision: 'allow' | 'forbidden' | 'prompt';
    reason: string;
  } {
    const action = `${req.toolName} ${JSON.stringify(req.toolArgs)}`;
    const result = this.execPolicy.evaluate(action);
    if (result.decision === 'forbidden') {
      return {
        decision: 'forbidden',
        reason: `Blocked by policy: ${result.rule?.justification ?? 'Dangerous operation'}`,
      };
    }
    if (result.decision === 'prompt') {
      return {
        decision: 'prompt',
        reason: `Policy requires review: ${result.rule?.justification ?? 'Needs approval'}`,
      };
    }
    return { decision: 'allow', reason: 'Allowed by policy' };
  }

  private evaluateMode(req: ApprovalRequest): {
    decision: 'approved' | 'denied' | 'defer';
    reason: string;
  } {
    const isWrite = req.gate.category === 'file_write' || req.gate.category === 'shell_exec';
    const isDestructive = req.gate.category === 'destructive';
    const isNetwork = req.gate.category === 'network';
    const isSandboxEscape = req.gate.category === 'sandbox_escape';

    switch (this.mode) {
      case 'read-only':
        if (isWrite || isDestructive || isNetwork || isSandboxEscape) {
          return {
            decision: 'denied',
            reason: `Blocked by ${this.mode} mode: ${req.gate.category} not allowed`,
          };
        }
        return { decision: 'approved', reason: `${this.mode} mode allows reads` };

      case 'plan':
        if (isWrite || isDestructive) {
          return { decision: 'denied', reason: `Blocked by plan mode: no modifications allowed` };
        }
        return { decision: 'approved', reason: 'Plan mode allows analysis' };

      case 'suggest':
        if (isDestructive || isSandboxEscape) {
          return {
            decision: 'defer',
            reason: `${this.mode} mode: user approval needed for ${req.gate.category}`,
          };
        }
        return { decision: 'approved', reason: `${this.mode} mode allows this action` };

      case 'auto-edit':
        if (isSandboxEscape) {
          return {
            decision: 'defer',
            reason: `Sandbox escape needs approval even in auto-edit mode`,
          };
        }
        if (isDestructive) {
          return { decision: 'defer', reason: `Destructive operations need approval` };
        }
        return { decision: 'approved', reason: `Auto-edit mode allows ${req.gate.category}` };

      case 'full-auto':
        return { decision: 'approved', reason: 'Full-auto mode' };

      default:
        return { decision: 'defer', reason: `Unknown mode ${this.mode}, deferring` };
    }
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

const approvalSingleton = createTenantAwareSingleton(() => new ApprovalSystem(), {
  allowGlobalFallback: true,
});

export function getApprovalSystem(): ApprovalSystem {
  return approvalSingleton.get();
}

export function resetApprovalSystem(): void {
  approvalSingleton.reset();
}
