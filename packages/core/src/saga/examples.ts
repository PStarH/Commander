import type { SagaGraph } from './types'
import { createSaga } from './sagaBuilder'

export interface SagaExample {
  name: string
  description: string
  build(): SagaGraph
}

const orderFulfillment: SagaExample = {
  name: 'order-fulfillment',
  description: 'Charge a card, reserve inventory, and confirm an order — with full compensation.',
  build() {
    return createSaga('order-fulfillment')
      .step('validate-cart', async (ctx) => {
        const input = ctx.input as { orderId?: string; amount?: number }
        if (!input.orderId) throw new Error('orderId is required')
        return { orderId: input.orderId, amount: input.amount ?? 0 }
      })
      .step('charge-card', async (ctx) => {
        const cart = ctx.results.get('validate-cart') as { orderId: string; amount: number }
        return {
          chargeId: `ch_${cart.orderId}_${Date.now()}`,
          amount: cart.amount,
        }
      })
      .compensate(async (charge) => {
        if (!charge) return
        const c = charge as { chargeId?: string }
        if (c.chargeId) console.log(`    ${'\u2192'} refund ${c.chargeId}`)
      })
      .step('reserve-inventory', async () => {
        return { reservationId: `rsv_${Date.now()}` }
      })
      .compensate(async (reservation) => {
        if (!reservation) return
        const r = reservation as { reservationId?: string }
        if (r.reservationId) console.log(`    ${'\u2192'} release ${r.reservationId}`)
      })
      .step('confirm-order', async (ctx) => {
        const cart = ctx.results.get('validate-cart') as { orderId: string }
        return { orderId: cart.orderId, confirmedAt: new Date().toISOString() }
      })
      .build()
  },
}

const refundApproval: SagaExample = {
  name: 'refund-approval',
  description: 'Validate, refund, and notify — pauses for human approval on refunds > $500.',
  build() {
    return createSaga('refund-approval')
      .step('validate-refund', async (ctx) => {
        const input = ctx.input as { refundId?: string; amount?: number }
        if (!input.refundId) throw new Error('refundId is required')
        return { refundId: input.refundId, amount: input.amount ?? 0, requiresApproval: (input.amount ?? 0) > 500 }
      })
      .step('create-refund', async (ctx) => {
        const v = ctx.results.get('validate-refund') as { refundId: string; amount: number }
        return { refundId: v.refundId, status: 'created' }
      })
      .compensate(async (refund) => {
        if (!refund) return
        const r = refund as { refundId?: string }
        if (r.refundId) console.log(`    ${'\u2192'} void refund ${r.refundId}`)
      })
      .approval('finance-team', { timeoutMs: 5 * 60 * 1000, onTimeout: 'reject' })
      .step('notify-customer', async (ctx) => {
        const r = ctx.results.get('create-refund') as { refundId: string }
        return { refundId: r.refundId, notified: true, channel: 'email' }
      })
      .build()
  },
}

const fileProcessing: SagaExample = {
  name: 'file-processing',
  description: 'Validate, transform, and persist a file — demonstrates retry policy + parallel branches.',
  build() {
    const validateStage = createSaga('validate')
      .step('check-format', async (ctx) => {
        const input = ctx.input as { filename?: string }
        return { filename: input.filename, valid: !!input.filename }
      })
      .build()

    const transformStage = createSaga('transform')
      .step('normalize', async (ctx) => {
        const input = ctx.input as { filename?: string }
        return { filename: (input.filename ?? '').toLowerCase(), lines: 42 }
      })
      .build()

    const persistStage = createSaga('persist')
      .step(
        'write',
        async (ctx) => {
          const input = ctx.input as { filename?: string }
          return { path: `/tmp/${input.filename}`, bytes: 1024 }
        },
        {
          retryPolicy: {
            maxAttempts: 3,
            backoff: 'exponential',
            initialDelayMs: 10,
            maxDelayMs: 100,
            jitter: 'none',
          },
        }
      )
      .build()

    return createSaga('file-processing')
      .parallel([validateStage, transformStage, persistStage], { failFast: false })
      .build()
  },
}

const examples: SagaExample[] = [orderFulfillment, refundApproval, fileProcessing]

export function listSagaExamples(): SagaExample[] {
  return examples
}

export function getSagaExample(name: string): SagaExample | undefined {
  return examples.find((e) => e.name === name)
}
