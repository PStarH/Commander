/**
 * sdk-express-server — Minimal Express server wiring Commander SDK.
 *
 * Run:
 *   pnpm install
 *   OPENAI_API_KEY=sk-... node examples/sdk-express-server/index.js
 *   # then POST {"task": "Hello, world!"} to http://localhost:3000/run
 */

const express = require('express');
const { CommanderClient } = require('@commander/sdk');

const app = express();
app.use(express.json());

const client = new CommanderClient({
  // defaultModel falls back to OPENAI_API_KEY auto-detection.
  baseUrl: process.env.COMMANDER_BASE_URL,
});

// Health probe for liveness checks (Kubernetes / load balancers).
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
});

// Main agent endpoint. Streams a single-turn task result back as JSON.
app.post('/run', async (req, res) => {
  const { task, model } = req.body ?? {};
  if (!task || typeof task !== 'string') {
    return res.status(400).json({ error: 'task (string) is required' });
  }
  try {
    const result = await client.run({ task, model });
    res.json({ status: 'ok', result });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Cost report endpoint backed by Commander's local usage ledger.
app.get('/cost', (_req, res) => {
  try {
    const cost = client.cost({ since: process.env.COST_SINCE });
    res.json({ status: 'ok', cost });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`sdk-express-server listening on http://localhost:${port}`);
});
