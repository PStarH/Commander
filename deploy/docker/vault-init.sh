#!/bin/sh
# =============================================================================
# vault-init.sh — WS9 live-fire Vault bootstrap.
# Populates the dev Vault with per-tenant test secrets at the paths expected by
# EncryptedSecretsVault and ws9-env-check. Run as a one-shot container after
# the vault service is healthy.
#
# NOT for production: dev root token is "root". Secrets here are test fixtures.
# =============================================================================
set -eu

: "${VAULT_ADDR:=http://vault:8200}"
: "${VAULT_TOKEN:=root}"
export VAULT_ADDR VAULT_TOKEN

echo "[vault-init] Waiting for Vault at ${VAULT_ADDR} ..."
i=0
until vault status >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[vault-init] Vault not reachable after 60s; aborting." >&2
    exit 1
  fi
  sleep 1
done
echo "[vault-init] Vault reachable (unsealed). Initializing secrets engine ..."

# KV v2 at secret/. In dev mode Vault already mounts secret/ as KV v2, so this
# is a safety net for non-dev servers; the error on a pre-existing mount is
# ignored so the script stays idempotent.
vault secrets enable -path=secret/ -version=2 kv 2>/dev/null || true

echo "[vault-init] Writing commander tenant + audit secrets ..."

# Per-tenant provider API keys (resolved from Vault, never process.env).
vault kv put secret/commander/tenant-a/openai-api-key    key="sk-test-key-tenant-a-xxxxx"
vault kv put secret/commander/tenant-a/anthropic-api-key key="sk-ant-test-key-tenant-a-xxxxx"
vault kv put secret/commander/tenant-b/openai-api-key    key="sk-test-key-tenant-b-xxxxx"
vault kv put secret/commander/tenant-b/anthropic-api-key key="sk-ant-test-key-tenant-b-xxxxx"

# 64-char hex HMAC / signing keys (injected via Vault, never stored in env).
vault kv put secret/commander/audit-chain-key \
  key="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
vault kv put secret/commander/manifest-key \
  key="fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

echo "[vault-init] Done. Wrote 6 secrets under secret/commander/."
