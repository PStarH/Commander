import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createDemoTicketCompensationAdapter } from './demoTicketAdapter.js';

describe('demo ticket compensation adapter', () => {
  it('closes the forward demo ticket from the governed receipt', async () => {
    const adapter = createDemoTicketCompensationAdapter();
    const response = await adapter.compensate({
      tenantId: 'tenant-a',
      effectId: 'effect-compensation',
      originalEffectId: 'effect-forward',
      idempotencyKey: 'cmp:effect-forward:demo-ticket/v1',
      destination: '',
      forwardResponse: { ticketId: 'T-1', title: 'Cell compensation E2E', status: 'open' },
      compensationPatch: { targetIdempotencyKey: 'cell-comp-1' },
      signal: new AbortController().signal,
    });

    assert.equal(adapter.descriptor.adapterVersion, 'demo-ticket/v1');
    assert.deepEqual(response, {
      ticketId: 'T-1',
      title: 'Cell compensation E2E',
      status: 'closed',
    });
  });

  it('is registered only for the explicit demo cell tier', () => {
    const wiring = readFileSync(new URL('./wiring.ts', import.meta.url), 'utf8');
    assert.match(
      wiring,
      /process\.env\.COMMANDER_CELL_TIER === 'demo' \? \[createDemoTicketCompensationAdapter\(\)\] : \[\]/,
    );
  });
});
