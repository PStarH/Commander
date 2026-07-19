/**
 * Governed action example — simulate, propose, approve via /v1/actions.
 *
 * Requires a running Commander API with Action Gateway enabled.
 *
 *   COMMANDER_API_URL=http://127.0.0.1:4000 COMMANDER_API_KEY=... \
 *     pnpm exec tsx packages/sdk/examples/governed-action.ts
 */

import { CommanderGatewayClient } from '../src/v1/client.js';

const baseUrl = process.env.COMMANDER_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.COMMANDER_API_KEY;

if (!apiKey) {
  console.error('Set COMMANDER_API_KEY to call /v1/actions');
  process.exit(2);
}

const client = new CommanderGatewayClient({ baseUrl, apiKey });

const actionInput = {
  source: 'sdk-example',
  package: 'demo.package',
  model: 'demo-model',
  tool: 'ticket.create',
  destination: 'demo://tickets/approval',
  effectType: 'demo.ticket.create',
  args: { title: 'Reset password' },
  idempotencyKey: `sdk-example-${Date.now()}`,
};

const { simulation } = await client.simulateAction(actionInput);
console.log('simulate', simulation.effect, simulation.actionDigest);

const { action, accepted } = await client.proposeAction(actionInput);
console.log('propose', action.state, accepted);

if (action.decision.effect === 'require_approval') {
  const approved = await client.approveAction(action.runId, {
    actionDigest: simulation.actionDigest,
    simulationId: simulation.simulationId,
    policySnapshotId: simulation.policySnapshotId,
  });
  console.log('approve', approved.state);
}

const evidence = await client.getActionEvidence(action.runId);
console.log('evidence', evidence.verification);
