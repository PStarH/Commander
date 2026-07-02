# Shadow Traffic Runbook

## Enabling Shadow Traffic

```bash
# 1. Create config
cat > .commander/shadow-config.json <<EOF
{
  "enabled": true,
  "endpoint": "http://localhost:9999",
  "sampleRate": 0.1
}
EOF

# 2. Start shadow runner
npx tsx packages/core/src/cli/commands/shadow.ts runner --port=9999 &

# 3. Enable proxy in production
export COMMANDER_SHADOW_ENABLED=true
npx tsx packages/core/src/cli/index.ts serve
```

## Viewing Drift

```bash
npx tsx packages/core/src/cli/commands/shadow.ts drift
```

## PII Scrubbing

Forced redacted headers (always redacted, not user-overridable): `Authorization`, `x-api-key`, `x-auth-token`, `cookie`.

Body PII patterns (delegated to `UniversalSanitizer` in `packages/core/src/security/securityPrimitives.ts`):

- API keys: OpenAI (`sk-`), Anthropic (`sk-ant-`), Stripe (`sk_live_`), Slack (`xox*`), GitHub (`ghp_*`), AWS (`AKIA*`)
- Secrets: JWT tokens, PEM private keys (RSA/EC/OpenSSH/DSA), SSN (`XXX-XX-XXXX`), passwords (`password=...`)
- Personal: email addresses, phone numbers
- XSS: `<script>` tags, event handlers, `javascript:` URLs, `data:text/html`

## Troubleshooting

- **Shadow returns 502**: Runner not started. Check process is alive on port 9999.
- **No drift reports**: `sampleRate` may be too low. Set to 1.0 for testing.
- **PII leaking**: Check `.commander/shadow-config.json` `ignoreFields` list.
