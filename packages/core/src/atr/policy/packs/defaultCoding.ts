export const DEFAULT_CODING_PACK = `package atr.policy.coding

import data.atr.builtins as b

# Defaults: fail-closed
default allow = false
default require_approval = false

# === Read-only tools are always allowed ===
allow {
  input.tool.isReadOnly == true
}

# === Always allow tool probing / heartbeat ===
allow {
  input.tool.category == "compute"
  input.action.callSite == "scheduler"
}

# === Shell is denied by default unless tenant allows it ===
deny_class = "deny_shell" {
  input.tool.category == "shell"
  input.tenant.config.allowShell == false
}

# === Network is denied unless tenant allows it ===
deny_class = "deny_network" {
  input.tool.category == "network"
  input.tenant.config.allowNetwork == false
  input.run.metadata.bypassNetwork != true
}

# === Force push is always denied ===
deny_class = "deny_force_push" {
  input.tool.name == "github_merge_pr"
  input.action.args.force == true
}

# === Payment tools always require approval ===
require_approval {
  input.tool.externalSystem == "stripe"
}

# === Destructive tools above cost threshold require approval ===
require_approval {
  input.tool.destructive == true
  input.metrics.estimatedCostUsd > 5
}

# === Production environment requires approval for any external system ===
require_approval {
  input.run.metadata.environment == "production"
  input.tool.externalSystem != null
}

# === Per-run action cap ===
deny {
  input.metrics.actionsThisRun > input.tenant.config.maxActionsPerRun
}

# === Token budget hard cap ===
deny {
  input.metrics.tokensUsedThisRun > input.tenant.config.tokenBudget
}

# === Read of secret file paths is denied ===
deny_class = "deny_secret_read" {
  input.tool.category == "file_read"
  b.b_path_matches_secret(input.action.args.path)
}

# === Destructive must be idempotent ===
deny {
  input.tool.destructive == true
  input.tool.isIdempotent == false
}

# === Off-hours kill switch (00:00-06:00 UTC) ===
deny {
  input.time.hourOfDay < 6
  input.tool.destructive == true
  input.run.metadata.offHoursBypass != true
}
`;

export const READ_ONLY_PACK = `package atr.policy.readonly

default allow = false
default require_approval = false

allow {
  input.tool.isReadOnly == true
}

deny_class = "deny_delete" {
  input.tool.category == "file_write"
}

deny_class = "deny_network" {
  input.tool.category == "network"
}

deny_class = "deny_shell" {
  input.tool.category == "shell"
}
`;

export const DESTRUCTIVE_OPS_PACK = `package atr.policy.destructive

default allow = false
default require_approval = true

# Read-only first
allow {
  input.tool.isReadOnly == true
}

# All destructive ops require approval
require_approval {
  input.tool.destructive == true
}

# Force-push is denied
deny_class = "deny_force_push" {
  input.tool.name == "github_merge_pr"
  input.action.args.force == true
}

# All payments require approval
require_approval {
  input.tool.externalSystem == "stripe"
}
`;

export const LEGACY_EXEC_PACK = `package atr.policy.legacyexec

default allow = false
default require_approval = false

# Safe read-only commands
allow {
  input.tool.category == "shell"
  b.b_contains_string(input.action.args.command, "ls")
}

allow {
  input.tool.category == "shell"
  b.b_contains_string(input.action.args.command, "cat")
}

# Network requires approval
require_approval {
  input.tool.category == "network"
}

# Banned shell patterns
deny_class = "deny_shell" {
  input.tool.category == "shell"
  b.b_is_shell_denied(input.action.args.command)
}

# Destructive commands
require_approval {
  input.tool.category == "shell"
  b.b_is_destructive_command(input.action.args.command)
}

# Force push
deny_class = "deny_force_push" {
  input.tool.name == "github_merge_pr"
  input.action.args.force == true
}
`;
