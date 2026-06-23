#!/usr/bin/env tsx
/**
 * scripts/commander-rotate.ts — Day 7+2 wire-through for keys-rotation.md §2.
 *
 * Audit #7 closeout: keys-rotation.md §2 says
 *   "Use the `commander-rotate <env-var-name> --audit` CLI (to be implemented)
 *    for atomic rotate + audit-linked confirmation."
 *
 * This is the implementation. The script intentionally does NOT touch any
 * secret store (Vault / AWS / GitHub Actions secrets) because the real
 * rotation is operator-mediated; this script's job is to:
 *
 *   1. Validate the env-var name is in the keys-rotation §1 scope list
 *      (refuses unrecognized names; `--force` overrides for incident use).
 *   2. Resolve the cadence from §2 (90d/180d/365d/30d).
 *   3. Emit an operator-level atomic intent record (type
 *      `key_rotation_attempt` or `key_rotation_confirmed`) into the
 *      `AuditChainLedger` when `--audit` is passed.
 *   4. Print a canonical operator playbook: PROVIDER → ROTATION STEPS →
 *      AUDIT CONFIRMATION → 'run commander-rotate with --confirm <id>'.
 *
 * Two phases (`--attempt` + `--confirm`) match the operator reality:
 * Vault/AWS holds back the actual provision, the operator does it.
 * `--attempt` records the intent and the rotation id; `--confirm` records
 * the verification-after-deployment once the operator confirms the new
 * env is live.
 *
 * SECURITY CONTRACT (L4 — never accept the actual secret value):
 *   - The CLI accepts ONLY env-var names.
 *   - The CLI outputs the canonical env-var update template; it does NOT
 *     read, hold, or display any existing secret from the environment.
 *   - Operators must perform the actual rotate via the upstream console
 *     and then assign the result to `process.env.<NAME>` themselves.
 *
 * Exit codes:
 *   0 — success (intent recorded OR confirmation recorded OR dry-run)
 *   1 — validation failure (env-var not in §1 scope, missing flags, etc.)
 *   2 — audit ledger failed (COMMANDER_AUDIT_CHAIN_KEY missing in prod, FS error)
 *
 * Usage:
 *   npx tsx scripts/commander-rotate.ts <env-var-name> --attempt [--audit] [--json]
 *   npx tsx scripts/commander-rotate.ts <env-var-name> --confirm <rotation-id> [--audit] [--json]
 *   npx tsx scripts/commander-rotate.ts <env-var-name> [--force] [--dry-run]
 *
 * Examples:
 *   # Step 1 of the §3 runbook after a HackerOne report:
 *   npx tsx scripts/commander-rotate.ts OPENAI_API_KEY --attempt --audit --json
 *   # Step 4: confirm in Vault:
 *   npx tsx scripts/commander-rotate.ts OPENAI_API_KEY --confirm 2026-06-23T03:53:00Z-ciso --audit
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAuditChainLedger } from '../packages/core/src/security/auditChainLedger';

// ============================================================================
// L1 — Canonical secret table (mirrors docs/security/keys-rotation.md §1 + §2
// verbatim so a CLI invocation never drifts from the published policy).
// ============================================================================

interface SecretClassBinding {
  /** Human-readable class label printed to operators. */
  readonly label: string;
  /** §2 cadence in days. */
  readonly cadenceDays: 30 | 60 | 90 | 180 | 365;
  /** Why this class gets this cadence (operator rationales need dates). */
  readonly justification: string;
  /** Whether the CLI is allowed to skip the §1 scope check. */
  readonly allowForce: boolean;
}

const SECRET_CLASS_TABLE: ReadonlyMap<string, SecretClassBinding> = new Map<
  string,
  SecretClassBinding
>([
  [
    'OPENAI_API_KEY',
    {
      label: 'Production LLM provider keys',
      cadenceDays: 90,
      justification: 'SOC 2 CC6.1',
      allowForce: true,
    },
  ],
  [
    'ANTHROPIC_API_KEY',
    {
      label: 'Production LLM provider keys',
      cadenceDays: 90,
      justification: 'SOC 2 CC6.1',
      allowForce: true,
    },
  ],
  [
    'GOOGLE_API_KEY',
    {
      label: 'Production LLM provider keys',
      cadenceDays: 90,
      justification: 'SOC 2 CC6.1',
      allowForce: true,
    },
  ],
  [
    'DEEPSEEK_API_KEY',
    {
      label: 'Production LLM provider keys',
      cadenceDays: 90,
      justification: 'SOC 2 CC6.1',
      allowForce: true,
    },
  ],
  [
    'AWS_ACCESS_KEY_ID',
    {
      label: 'Production cloud / SaaS tokens',
      cadenceDays: 90,
      justification: 'Same-handle LLM keys',
      allowForce: true,
    },
  ],
  [
    'AWS_SECRET_ACCESS_KEY',
    {
      label: 'Production cloud / SaaS tokens',
      cadenceDays: 90,
      justification: 'Same-handle LLM keys',
      allowForce: true,
    },
  ],
  [
    'GITHUB_TOKEN',
    {
      label: 'Production cloud / SaaS tokens',
      cadenceDays: 90,
      justification: 'Same-handle LLM keys',
      allowForce: true,
    },
  ],
  [
    'SLACK_BOT_TOKEN',
    {
      label: 'Production cloud / SaaS tokens',
      cadenceDays: 90,
      justification: 'Same-handle LLM keys',
      allowForce: true,
    },
  ],
  [
    'COMMANDER_FEDERATION_KEY',
    {
      label: 'Federated identity OIDC private keys',
      cadenceDays: 180,
      justification: 'Cross-org coordination',
      allowForce: true,
    },
  ],
  [
    'COMMANDER_CAPABILITY_TOKEN_KEY',
    {
      label: 'Capability-token HMAC master',
      cadenceDays: 90,
      justification: 'Same-handle consumer credentials',
      allowForce: true,
    },
  ],
  [
    'COMMANDER_AUDIT_CHAIN_KEY',
    {
      label: 'Audit-chain HMAC master',
      cadenceDays: 365,
      justification: 'Long-history HMAC retention',
      allowForce: true,
    },
  ],
  [
    'COMMANDER_DEV_API_KEY',
    {
      label: 'Ephemeral / dev-only secrets',
      cadenceDays: 30,
      justification: 'Short-lived credentials',
      allowForce: true,
    },
  ],
  [
    'COMMANDER_STAGING_API_KEY',
    {
      label: 'Demo / staging credentials',
      cadenceDays: 30,
      justification: 'Per-environment isolation',
      allowForce: true,
    },
  ],
]);

// ============================================================================
// L2 — Parsed CLI surface
// ============================================================================

interface RotateArgs {
  envVar: string;
  action: 'attempt' | 'confirm' | 'dry';
  rotationId?: string;
  force: boolean;
  audit: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): { ok: true; value: RotateArgs } | { ok: false; error: string } {
  let envVar: string | undefined;
  let action: RotateArgs['action'] = 'dry';
  let rotationId: string | undefined;
  let force = false;
  let audit = false;
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--attempt') {
      action = 'attempt';
    } else if (arg === '--confirm') {
      action = 'confirm';
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `--confirm requires a <rotation-id> argument` };
      }
      rotationId = next;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      action = 'dry';
    } else if (arg === '--audit') {
      audit = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--') || arg.startsWith('-')) {
      return { ok: false, error: `unknown flag: ${arg}` };
    } else if (envVar === undefined) {
      envVar = arg;
    } else {
      return { ok: false, error: `unexpected positional argument: ${arg}` };
    }
  }

  if (envVar === undefined) {
    return {
      ok: false,
      error:
        `usage: commander-rotate <env-var-name> [--attempt | --confirm <id> | --dry-run] ` +
        `[--force] [--audit] [--json]`,
    };
  }

  return {
    ok: true,
    value: {
      envVar,
      action,
      rotationId,
      force,
      audit,
      json,
    },
  };
}

// ============================================================================
// L3 — Validation (refuses unknown env-var names without --force)
// ============================================================================

function validateSecret(
  envVar: string,
  force: boolean,
): { ok: true; value: SecretClassBinding; classLabel: string } | { ok: false; error: string } {
  const binding = SECRET_CLASS_TABLE.get(envVar);
  if (binding) {
    return { ok: true, value: binding, classLabel: binding.label };
  }
  if (force) {
    return {
      ok: true,
      value: {
        label: '(forced) — not in keys-rotation.md §1',
        cadenceDays: 90,
        justification: 'forced via --force; not bound to a documented cadence',
        allowForce: true,
      },
      classLabel: 'forced',
    };
  }
  return {
    ok: false,
    error:
      `env-var '${envVar}' is not in keys-rotation.md §1 scope list. ` +
      'Refusing to assume a cadence. Use --force for incident-only exemptions.',
  };
}

// ============================================================================
// L4 — AuditChainLedger writer
//
// SECURITY CONTRACT: we NEVER read the live secret value. We log:
//   - the env-var NAME
//   - the rotation-id (operators generate it; e.g. ISO date + operator handle)
//   - the secret-class binding label (no value, no fingerprint)
//   - the playbook outcome (attempted / confirmed / dry-run)
// ============================================================================

function appendAudit(
  envVar: string,
  binding: SecretClassBinding,
  rotationId: string,
  action: RotateArgs['action'],
): { ok: true; rotationId: string } | { ok: false; error: string } {
  const eventType =
    action === 'attempt'
      ? 'key_rotation_attempt'
      : action === 'confirm'
        ? 'key_rotation_confirmed'
        : 'key_rotation_dry_run';
  try {
    const ledger = getAuditChainLedger();
    const entry = ledger.logEvent({
      type: eventType,
      severity: 'medium',
      source: 'commander-rotate',
      message: `${eventType} for ${envVar}`,
      details: {
        envVar,
        secretClass: binding.label,
        cadenceDays: binding.cadenceDays,
        rotationId,
        // CRITICAL: no secret value is recorded. The ledger is HMAC-chained
        // for tamper-evidence; including a plaintext key into the chain
        // would create a persistent leak artifact.
      },
    });
    return { ok: true, rotationId: entry.id };
  } catch (err) {
    return { ok: false, error: `AuditChainLedger failed: ${(err as Error).message}` };
  }
}

// ============================================================================
// L5 — Operator playbook rendering
// ============================================================================

function renderPlaybook(envVar: string, binding: SecretClassBinding, rotationId: string): string {
  return [
    `⋯ commander-rotate playbook for ${envVar}`,
    `  secret class:  ${binding.label}`,
    `  cadence:       every ${binding.cadenceDays} days`,
    `  justification: ${binding.justification}`,
    `  rotation-id:   ${rotationId}`,
    ``,
    `  Step 1 — Generate replacement`,
    `    - Open the upstream provider console.`,
    `    - Create a fresh ${envVar}.`,
    `    - Capture the generation timestamp (for §3 audit).`,
    ``,
    `  Step 2 — Deploy rotation`,
    `    - Update Vault / AWS Secrets Manager / GitHub Actions secret for ${envVar}.`,
    `    - Deploy to ALL environments SIMULTANEOUSLY per §3 to prevent drift.`,
    ``,
    `  Step 3 — Verify`,
    `    - Run 'pnpm benchmark:verify' (week-2 hardening).`,
    `    - Spot-check a representative fleet run using the new ${envVar}.`,
    ``,
    `  Step 4 — Audit + confirm`,
    `    - Invoke: npx tsx scripts/commander-rotate.ts ${envVar} --confirm ${rotationId} --audit`,
    `    - This appends a key_rotation_confirmed entry to the audit chain.`,
    ``,
    `  SECURITY: the rotation CLI never accepts the secret value. Operators`,
    `  paste the new value into Vault directly without routing it through`,
    `  shell history or this CLI's argv.`,
  ].join('\n');
}

// ============================================================================
// main
// ============================================================================

function main(): number {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    process.stderr.write(`[commander-rotate] ${parsed.error}\n`);
    return 1;
  }
  const args = parsed.value;

  const validation = validateSecret(args.envVar, args.force);
  if (!validation.ok) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          reason: 'validation',
          envVar: args.envVar,
          error: validation.error,
          exitCode: 1,
        }) + '\n',
      );
    } else {
      process.stderr.write(`[commander-rotate] ${validation.error}\n`);
      process.stderr.write(`[commander-rotate] hint: --force overrides for incident use only\n`);
    }
    return 1;
  }
  const binding = validation.value;

  // Cross-phase invariant: --confirm requires an explicit rotation-id
  if (args.action === 'confirm') {
    if (!args.rotationId) {
      process.stderr.write('[commander-rotate] --confirm requires a <rotation-id> argument\n');
      return 1;
    }
  }

  // Synthesize a rotation-id for --attempt unless the operator supplied one.
  // Format: ISO UTC timestamp + operator handle if available.
  const operatorHandle = process.env.COMMANDER_OPERATOR_HANDLE ?? 'unknown';
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const rotationId =
    args.action === 'attempt' ? `${now}-${operatorHandle}` : (args.rotationId as string);

  // Emit audit event only when --audit is explicit (L4 contract).
  let auditRecordId: string | null = null;
  if (args.audit) {
    const a = appendAudit(args.envVar, binding, rotationId, args.action);
    if (!a.ok) {
      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            reason: 'audit',
            envVar: args.envVar,
            rotationId,
            error: a.error,
            exitCode: 2,
          }) + '\n',
        );
      } else {
        process.stderr.write(`[commander-rotate] ${a.error}\n`);
      }
      return 2;
    }
    auditRecordId = a.rotationId;
  }

  const playbook = renderPlaybook(args.envVar, binding, rotationId);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          envVar: args.envVar,
          secretClass: binding.label,
          cadenceDays: binding.cadenceDays,
          rotationId,
          action: args.action,
          auditRecordId,
          playbook,
          exitCode: 0,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(playbook + '\n');
    if (args.audit) {
      process.stdout.write(`\n[commander-rotate] audit record: ${auditRecordId ?? '<unset>'}\n`);
    } else {
      process.stdout.write(
        `\n[commander-rotate] (dry-run / intent-only) re-run with --audit to record to tamper-evident ledger\n`,
      );
    }
  }

  return 0;
}

process.exit(main());
