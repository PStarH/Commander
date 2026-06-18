"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSagaExamples = listSagaExamples;
exports.getSagaExample = getSagaExample;
const sagaBuilder_1 = require("./sagaBuilder");
const orderFulfillment = {
    name: 'order-fulfillment',
    description: 'Charge a card, reserve inventory, and confirm an order — with full compensation.',
    build() {
        return (0, sagaBuilder_1.createSaga)('order-fulfillment')
            .step('validate-cart', async (ctx) => {
            var _a;
            const input = ctx.input;
            if (!input.orderId)
                throw new Error('orderId is required');
            return { orderId: input.orderId, amount: (_a = input.amount) !== null && _a !== void 0 ? _a : 0 };
        })
            .step('charge-card', async (ctx) => {
            const cart = ctx.results.get('validate-cart');
            return {
                chargeId: `ch_${cart.orderId}_${Date.now()}`,
                amount: cart.amount,
            };
        })
            .compensate(async (charge) => {
            if (!charge)
                return;
            const c = charge;
            if (c.chargeId)
                process.stdout.write(`    ${'\u2192'} refund ${c.chargeId}\n`);
        })
            .step('reserve-inventory', async () => {
            return { reservationId: `rsv_${Date.now()}` };
        })
            .compensate(async (reservation) => {
            if (!reservation)
                return;
            const r = reservation;
            if (r.reservationId)
                process.stdout.write(`    ${'\u2192'} release ${r.reservationId}\n`);
        })
            .step('confirm-order', async (ctx) => {
            const cart = ctx.results.get('validate-cart');
            return { orderId: cart.orderId, confirmedAt: new Date().toISOString() };
        })
            .build();
    },
};
const refundApproval = {
    name: 'refund-approval',
    description: 'Validate, refund, and notify — pauses for human approval on refunds > $500.',
    build() {
        return (0, sagaBuilder_1.createSaga)('refund-approval')
            .step('validate-refund', async (ctx) => {
            var _a, _b;
            const input = ctx.input;
            if (!input.refundId)
                throw new Error('refundId is required');
            return {
                refundId: input.refundId,
                amount: (_a = input.amount) !== null && _a !== void 0 ? _a : 0,
                requiresApproval: ((_b = input.amount) !== null && _b !== void 0 ? _b : 0) > 500,
            };
        })
            .step('create-refund', async (ctx) => {
            const v = ctx.results.get('validate-refund');
            return { refundId: v.refundId, status: 'created' };
        })
            .compensate(async (refund) => {
            if (!refund)
                return;
            const r = refund;
            if (r.refundId)
                process.stdout.write(`    ${'\u2192'} void refund ${r.refundId}\n`);
        })
            .approval('finance-team', { timeoutMs: 5 * 60 * 1000, onTimeout: 'reject' })
            .step('notify-customer', async (ctx) => {
            const r = ctx.results.get('create-refund');
            return { refundId: r.refundId, notified: true, channel: 'email' };
        })
            .build();
    },
};
const fileProcessing = {
    name: 'file-processing',
    description: 'Validate, transform, and persist a file — demonstrates retry policy + parallel branches.',
    build() {
        const validateStage = (0, sagaBuilder_1.createSaga)('validate')
            .step('check-format', async (ctx) => {
            const input = ctx.input;
            return { filename: input.filename, valid: !!input.filename };
        })
            .build();
        const transformStage = (0, sagaBuilder_1.createSaga)('transform')
            .step('normalize', async (ctx) => {
            var _a;
            const input = ctx.input;
            return { filename: ((_a = input.filename) !== null && _a !== void 0 ? _a : '').toLowerCase(), lines: 42 };
        })
            .build();
        const persistStage = (0, sagaBuilder_1.createSaga)('persist')
            .step('write', async (ctx) => {
            const input = ctx.input;
            return { path: `/tmp/${input.filename}`, bytes: 1024 };
        }, {
            retryPolicy: {
                maxAttempts: 3,
                backoff: 'exponential',
                initialDelayMs: 10,
                maxDelayMs: 100,
                jitter: 'none',
            },
        })
            .build();
        return (0, sagaBuilder_1.createSaga)('file-processing')
            .parallel([validateStage, transformStage, persistStage], { failFast: false })
            .build();
    },
};
const examples = [orderFulfillment, refundApproval, fileProcessing];
function listSagaExamples() {
    return examples;
}
function getSagaExample(name) {
    return examples.find((e) => e.name === name);
}
