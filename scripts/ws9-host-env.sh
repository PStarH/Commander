#!/usr/bin/env bash
# WS9 host-side environment for Colima + live-fire (TESTING ONLY).
# Usage: source scripts/ws9-host-env.sh
set -a
export PATH="${HOME}/.local/bin:${PATH}"

export COMMANDER_DB_HOST=localhost
export COMMANDER_DB_PORT=5433
export COMMANDER_DB_NAME=commander
export COMMANDER_DB_USER=commander_app
export COMMANDER_DB_PASSWORD=commander_app

export COMMANDER_VAULT_ADDR=http://localhost:8200
export COMMANDER_VAULT_TOKEN=root

export COMMANDER_API_HOST=localhost
export COMMANDER_API_PORT=3000
export COMMANDER_WS9_API_KEY_A=ws9-tenant-a-api-key-test-only

# Drop common LLM provider env keys so keypath gate does not FAIL on host shell.
unset OPENAI_API_KEY ANTHROPIC_API_KEY AZURE_OPENAI_API_KEY GEMINI_API_KEY \
  GROQ_API_KEY DEEPSEEK_API_KEY MISTRAL_API_KEY TOGETHER_API_KEY \
  FIREWORKS_API_KEY PERPLEXITY_API_KEY COHERE_API_KEY HUGGINGFACE_API_KEY \
  XAI_API_KEY CLAUDE_API_KEY STEPFUN_API_KEY GOOGLE_API_KEY GITHUB_TOKEN \
  STRIPE_SECRET_KEY SLACK_BOT_TOKEN AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID \
  OPENROUTER_API_KEY CODEX_API_KEY CURSOR_ASKPASS_SECRET \
  2>/dev/null || true

set +a
echo "WS9 host env ready (Colima/docker context should be active)."
