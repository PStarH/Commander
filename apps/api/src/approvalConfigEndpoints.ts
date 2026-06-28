/**
 * approvalConfigEndpoints — Unified approval configuration API.
 *
 * Closes GAP-06: The framework has two approval systems (ApprovalSystem sandbox
 * modes + ToolApproval policy engine) that overlap conceptually. This endpoint
 * provides a unified read/write interface so the frontend can present a single
 * coherent configuration panel.
 *
 * Endpoints:
 *   GET  /api/approval/config       — unified approval config (sandbox mode + tool policies)
 *   PUT  /api/approval/sandbox-mode  — update sandbox approval mode
 *   PUT  /api/approval/policy/:pattern — update a specific tool policy
 *   POST /api/approval/policy         — add a new tool policy
 *   DELETE /api/approval/policy/:pattern — remove a tool policy
 *   GET  /api/approval/audit-log      — recent approval decisions audit log
 */
import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { toErrorMessage } from './routeHelpers';
import { validateBody } from './validationMiddleware';

const APPROVAL_MODE_FILE = path.join(process.cwd(), '.commander', 'approval-mode.json');
const AUDIT_LOG_FILE = path.join(process.cwd(), '.commander', 'security-audit.jsonl');

// ── Types ───────────────────────────────────────────────────────────────
type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto' | 'read-only' | 'plan';
type ApprovalLevel = 'auto' | 'semi_auto' | 'manual';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface ToolPolicy {
  pattern: string;
  level: ApprovalLevel;
  riskLevel: RiskLevel;
  description: string;
  autoApproveIf?: Record<string, unknown>;
}

interface UnifiedApprovalConfig {
  sandboxMode: ApprovalMode;
  sandboxModeDescription: string;
  toolPolicies: ToolPolicy[];
  failClosed: boolean;
  lastUpdated: string;
}

// ── Sandbox mode descriptions ───────────────────────────────────────────
const SANDBOX_MODE_DESC: Record<ApprovalMode, string> = {
  suggest: 'Agent suggests actions; user approves each one',
  'auto-edit': 'File edits auto-approved; shell/exec still requires approval',
  'full-auto': 'All actions auto-approved (dangerous — sandbox only)',
  'read-only': 'Agent can only read; no writes or executions',
  plan: 'Agent can analyze and plan; no writes or executions',
};

// ── Default policies (mirrors core DEFAULT_APPROVAL_POLICIES) ───────────
const DEFAULT_POLICIES: ToolPolicy[] = [
  { pattern: 'shell_execute', level: 'manual', riskLevel: 'critical', description: 'Shell command execution requires manual approval' },
  { pattern: 'python_execute', level: 'semi_auto', riskLevel: 'high', description: 'Python code execution' },
  { pattern: 'file_write', level: 'semi_auto', riskLevel: 'medium', description: 'File modification requires approval for system paths' },
  { pattern: 'file_edit', level: 'semi_auto', riskLevel: 'medium', description: 'File editing requires approval' },
  { pattern: 'file_read', level: 'auto', riskLevel: 'low', description: 'File read is safe to auto-approve' },
  { pattern: 'web_search', level: 'auto', riskLevel: 'low', description: 'Web search is safe to auto-approve' },
  { pattern: 'web_fetch', level: 'auto', riskLevel: 'low', description: 'Web fetch is safe to auto-approve' },
  { pattern: 'browser_search', level: 'auto', riskLevel: 'low', description: 'Browser search is safe to auto-approve' },
  { pattern: 'memory_*', level: 'auto', riskLevel: 'low', description: 'Memory operations are safe' },
  { pattern: 'agent', level: 'semi_auto', riskLevel: 'high', description: 'Sub-agent spawning requires approval' },
  { pattern: 'git_push', level: 'manual', riskLevel: 'critical', description: 'Git push requires explicit approval' },
  { pattern: 'git_commit', level: 'semi_auto', riskLevel: 'medium', description: 'Git commit is semi-automatic' },
  { pattern: 'git', level: 'auto', riskLevel: 'low', description: 'Git read operations are auto-approved' },
];

// ── Persistence: custom policies stored in .commander/custom-policies.json ─
const CUSTOM_POLICIES_FILE = path.join(process.cwd(), '.commander', 'custom-policies.json');

interface CustomPolicyStore {
  policies: ToolPolicy[];
  lastUpdated: string;
}

function loadCustomPolicies(): CustomPolicyStore {
  try {
    const raw = fs.readFileSync(CUSTOM_POLICIES_FILE, 'utf-8');
    return JSON.parse(raw) as CustomPolicyStore;
  } catch {
    return { policies: [], lastUpdated: new Date().toISOString() };
  }
}

function saveCustomPolicies(store: CustomPolicyStore): void {
  const dir = path.dirname(CUSTOM_POLICIES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CUSTOM_POLICIES_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function getAllPolicies(): ToolPolicy[] {
  const custom = loadCustomPolicies();
  // Custom policies override defaults with the same pattern
  const customPatterns = new Set(custom.policies.map((p) => p.pattern));
  const defaults = DEFAULT_POLICIES.filter((p) => !customPatterns.has(p.pattern));
  return [...defaults, ...custom.policies];
}

function readSandboxMode(): ApprovalMode {
  try {
    const raw = fs.readFileSync(APPROVAL_MODE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return (data.mode as ApprovalMode) ?? 'auto-edit';
  } catch {
    return 'auto-edit';
  }
}

function writeSandboxMode(mode: ApprovalMode): void {
  const dir = path.dirname(APPROVAL_MODE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(APPROVAL_MODE_FILE, JSON.stringify({ mode }, null, 2), 'utf-8');
}

// ── Audit log reading ───────────────────────────────────────────────────
interface AuditEntry {
  timestamp: string;
  event: string;
  toolName?: string;
  decision?: string;
  reason?: string;
  riskLevel?: string;
}

function readAuditLog(limit: number): AuditEntry[] {
  try {
    const raw = fs.readFileSync(AUDIT_LOG_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (parsed.event?.includes('approval') || parsed.decision) {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────
const sandboxModeSchema = z.object({
  mode: z.enum(['suggest', 'auto-edit', 'full-auto', 'read-only', 'plan']),
});

const addPolicySchema = z.object({
  pattern: z.string().min(1).max(128),
  level: z.enum(['auto', 'semi_auto', 'manual']),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  description: z.string().max(256),
  autoApproveIf: z.record(z.string(), z.unknown()).optional(),
});

const updatePolicySchema = z.object({
  level: z.enum(['auto', 'semi_auto', 'manual']).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  description: z.string().max(256).optional(),
  autoApproveIf: z.record(z.string(), z.unknown()).optional(),
});

// ── Router ──────────────────────────────────────────────────────────────
export function createApprovalConfigRouter(): Router {
  const router = Router();

  // GET /api/approval/config — unified config
  router.get('/api/approval/config', (_req: Request, res: Response) => {
    try {
      const config: UnifiedApprovalConfig = {
        sandboxMode: readSandboxMode(),
        sandboxModeDescription: SANDBOX_MODE_DESC[readSandboxMode()],
        toolPolicies: getAllPolicies(),
        failClosed: true, // Framework default — always fail-closed
        lastUpdated: loadCustomPolicies().lastUpdated,
      };
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // PUT /api/approval/sandbox-mode — update sandbox mode
  router.put('/api/approval/sandbox-mode', validateBody(sandboxModeSchema), (req: Request, res: Response) => {
    try {
      const mode = req.body.mode as ApprovalMode;
      writeSandboxMode(mode);
      res.json({
        status: 'updated',
        mode,
        description: SANDBOX_MODE_DESC[mode],
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // POST /api/approval/policy — add custom policy
  router.post('/api/approval/policy', validateBody(addPolicySchema), (req: Request, res: Response) => {
    try {
      const newPolicy = req.body as ToolPolicy;
      const store = loadCustomPolicies();

      // Check if pattern already exists
      const existingIdx = store.policies.findIndex((p) => p.pattern === newPolicy.pattern);
      if (existingIdx >= 0) {
        store.policies[existingIdx] = newPolicy;
      } else {
        store.policies.push(newPolicy);
      }
      store.lastUpdated = new Date().toISOString();
      saveCustomPolicies(store);

      res.status(201).json({ status: 'added', policy: newPolicy });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // PUT /api/approval/policy/:pattern — update existing policy
  router.put('/api/approval/policy/:pattern', validateBody(updatePolicySchema), (req: Request, res: Response) => {
    try {
      const pattern = decodeURIComponent(String(req.params.pattern));
      const updates = req.body as Partial<ToolPolicy>;
      const store = loadCustomPolicies();

      // Find in custom policies
      let policy = store.policies.find((p) => p.pattern === pattern);
      if (!policy) {
        // Find in defaults and copy to custom
        const defaultPolicy = DEFAULT_POLICIES.find((p) => p.pattern === pattern);
        if (!defaultPolicy) {
          return res.status(404).json({ error: 'Policy not found' });
        }
        policy = { ...defaultPolicy };
        store.policies.push(policy);
      }

      // Apply updates
      if (updates.level) policy.level = updates.level;
      if (updates.riskLevel) policy.riskLevel = updates.riskLevel;
      if (updates.description) policy.description = updates.description;
      if (updates.autoApproveIf !== undefined) policy.autoApproveIf = updates.autoApproveIf;

      store.lastUpdated = new Date().toISOString();
      saveCustomPolicies(store);

      res.json({ status: 'updated', policy });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // DELETE /api/approval/policy/:pattern — remove custom policy
  router.delete('/api/approval/policy/:pattern', (req: Request, res: Response) => {
    try {
      const pattern = decodeURIComponent(String(req.params.pattern));
      const store = loadCustomPolicies();
      const before = store.policies.length;
      store.policies = store.policies.filter((p) => p.pattern !== pattern);

      if (store.policies.length === before) {
        return res.status(404).json({ error: 'Custom policy not found' });
      }

      store.lastUpdated = new Date().toISOString();
      saveCustomPolicies(store);
      res.json({ status: 'removed', pattern });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  // GET /api/approval/audit-log — recent approval decisions
  router.get('/api/approval/audit-log', (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const entries = readAuditLog(limit);
      res.json({ entries, total: entries.length });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  return router;
}
