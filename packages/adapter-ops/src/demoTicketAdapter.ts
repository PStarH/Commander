import type { ActionAdapter } from '@commander/action-adapters';

export function createDemoTicketCompensationAdapter(): ActionAdapter {
  return {
    descriptor: {
      schema: 'commander.action-adapter/v1',
      adapterId: 'demo.ticket.create',
      adapterVersion: 'demo-ticket/v1',
      effectType: 'demo.ticket.create',
      toolName: 'ticket.create',
      compensationEffectType: 'compensate.demo.ticket.create',
      destinationPattern: 'demo://tickets/approval',
      defaultGatewayEffect: 'require_approval',
      reversible: true,
      evidenceResponseSummaryKeys: ['status'],
      compensationPatchKeys: ['targetIdempotencyKey'],
    },

    async execute() {
      throw new Error('DEMO_TICKET_FORWARD_EXECUTION_UNSUPPORTED');
    },

    async queryOutcome() {
      return {
        status: 'UNKNOWN',
        error: {
          code: 'DEMO_TICKET_REMOTE_STATE_LOCAL_TO_WORKER',
          message: 'Demo ticket forward state is local to the worker process.',
        },
      };
    },

    async compensate(input) {
      const ticketId = input.forwardResponse.ticketId;
      const title = input.forwardResponse.title;
      if (
        typeof ticketId !== 'string' ||
        typeof title !== 'string' ||
        input.forwardResponse.status !== 'open' ||
        typeof input.compensationPatch.targetIdempotencyKey !== 'string'
      ) {
        throw new Error('INVALID_DEMO_TICKET_COMPENSATION');
      }
      return { ticketId, title, status: 'closed' };
    },

    async queryCompensationOutcome(input) {
      return input.compensationResponse?.status === 'closed'
        ? { status: 'APPLIED', response: input.compensationResponse }
        : {
            status: 'UNKNOWN',
            error: {
              code: 'DEMO_TICKET_COMPENSATION_NOT_CONFIRMED',
              message: 'Demo ticket compensation receipt is not terminal.',
            },
          };
    },
  };
}
