# harmful-content-rules

Built-in rule pack for detecting direct requests for harmful content.

## Categories

- `malware` — ransomware, trojans, keyloggers, exploits, RCE
- `weapons` — explosives, firearms, ricin, silencers
- `self_harm` — suicide instructions, self-harm methods
- `drugs` — fentanyl, darknet markets, drug trafficking
- `child_safety` — grooming, soliciting minors
- `hate_speech` — incitement to violence, ethnic cleansing
- `phishing` — fake login pages, credential harvesting
- `financial_fraud` — fake invoices, wire-transfer fraud
- `doxxing` — exposing personal information
- `election_interference` — misinformation, deepfakes, voter suppression

## Enabling

The host loads this pack automatically when the plugin is enabled. For the
security benchmark defender, pass `--with-harmful`:

```bash
npx tsx scripts/benchmark-agentdojo.ts --all --with-harmful
```

## Adding Rules

Edit `rules.ts` and add a new `{ category, severity, pattern }` entry. Keep
patterns specific to avoid false positives.
