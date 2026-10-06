import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { checkoutIntegrity, sha256 } from '../../src/modules/payments/wompi.js';

const wompiConfig = {
  enabled: true,
  environment: 'sandbox',
  publicKey: 'pub_test_public',
  privateKey: 'prv_test_private',
  integritySecret: 'integrity_secret',
  eventsSecret: 'events_secret',
};

function event({ id = 'evt_1', environment = 'test', eventName = 'transaction.updated', status = 'APPROVED' } = {}) {
  const value = {
    id,
    environment,
    event: eventName,
    timestamp: 1700000000,
    data: { transaction: {
      id: 'tx_1', reference: 'RC-BKG-901-abc', amount_in_cents: 2700000, currency: 'COP', status,
      finalized_at: '2026-09-24T14:30:00.000Z', payment_method_type: 'CARD',
    } },
    signature: { properties: ['transaction.id', 'transaction.amount_in_cents'] },
  };
  value.signature.checksum = sha256('tx_127000001700000000events_secret');
  return value;
}

function createFixture({ settlePayment = async () => ({ confirmed: false }), findTransaction, refunds,
  wompiEnvironment = 'sandbox' } = {}) {
  const booking = {
    async createPaymentAttempt() {
      return { amountMinor: 2700000, expiresAt: '2026-09-24T15:00:00.000Z' };
    },
    settlePayment,
    async getLatestWompiTransaction() { return 'tx_latest'; },
  };
  return createApp({
    booking,
    environment: 'test',
    findActiveUserById: async (id) => (id === '7' ? { id: '7', roles: ['USUARIO'] } : null),
    logger: { error() {} },
    wompi: { config: { ...wompiConfig, environment: wompiEnvironment }, provider: { findTransaction }, refunds,
      redirectUrl: 'http://localhost:5173/reservas/pago' },
  });
}

describe('Wompi HTTP contract', () => {
  it('settles only a signed Sandbox refund.updated event with exact provider facts', async () => {
    const received = [];
    const app = createFixture({ refunds: { recordWebhook: async (facts) => received.push(facts) } });
    const refundEvent = event({ eventName: 'refund.updated' });
    refundEvent.data = { refund: { refund_id: 'v2_ref_123', transaction_id: 'tx_1',
      amount_in_cents: 2700000, currency: 'COP', status: 'APPROVED' } };
    refundEvent.signature.properties = ['refund.refund_id', 'refund.status'];
    refundEvent.signature.checksum = sha256('v2_ref_123APPROVED1700000000events_secret');
    await request(app).post('/api/v1/webhooks/wompi').send(refundEvent).expect(200);
    assert.deepEqual(received, [{ id: 'v2_ref_123', transactionId: 'tx_1',
      amountInCents: 2700000, currency: 'COP', status: 'APPROVED' }]);
    refundEvent.data.refund.amount_in_cents += 1;
    refundEvent.signature.properties = ['refund.amount_in_cents'];
    await request(app).post('/api/v1/webhooks/wompi').send(refundEvent).expect(401);
    assert.equal(received.length, 1);
  });
  it('returns the exact signed checkout configuration without server secrets', async () => {
    const app = createFixture();
    const response = await request(app)
      .post('/api/v1/bookings/901/payments/wompi/checkout')
      .set('X-User-Id', '7')
      .expect(201);

    const { reference } = response.body.config;
    const expected = {
      publicKey: 'pub_test_public', currency: 'COP', amountInCents: 2700000, reference,
      signature: { integrity: checkoutIntegrity({ reference, amountInCents: 2700000, expirationTime: '2026-09-24T15:00:00.000Z', integritySecret: 'integrity_secret' }) },
      expirationTime: '2026-09-24T15:00:00.000Z', redirectUrl: 'http://localhost:5173/reservas/pago',
    };
    assert.match(reference, /^RC-BKG-901-[a-f0-9]{24}$/);
    assert.deepEqual(response.body, { config: expected });
    const serialized = JSON.stringify(response.body);
    for (const secret of ['integrity_secret', 'events_secret', 'prv_test_private']) assert.equal(serialized.includes(secret), false);
  });

  it('settles one valid approved webhook event', async () => {
    const settled = [];
    const app = createFixture({ settlePayment: async (input) => { settled.push(input); return { confirmed: true }; } });
    await request(app).post('/api/v1/webhooks/wompi').send(event()).expect(200);
    assert.deepEqual(settled, [{
      provider: 'WOMPI', eventId: 'evt_1', facts: {
        id: 'tx_1', reference: 'RC-BKG-901-abc', amountInCents: 2700000, currency: 'COP', status: 'APPROVED',
        finalizedAt: '2026-09-24T14:30:00.000Z', paymentMethodType: 'CARD',
      },
    }]);
  });

  it('passes duplicate deliveries to the idempotent settlement boundary with the same event id', async () => {
    const settled = [];
    const app = createFixture({ settlePayment: async (input) => { settled.push(input); return { ignored: settled.length > 1 }; } });
    const duplicate = event({ id: 'evt_duplicate' });
    await request(app).post('/api/v1/webhooks/wompi').send(duplicate).expect(200);
    await request(app).post('/api/v1/webhooks/wompi').send(duplicate).expect(200);
    assert.equal(settled.length, 2);
    assert.ok(settled.every((input) => input.eventId === 'evt_duplicate'));
  });

  it('rejects a dynamic checksum mismatch without settling', async () => {
    let settled = 0;
    const app = createFixture({ settlePayment: async () => { settled += 1; } });
    const invalid = event();
    invalid.data.transaction.amount_in_cents = 2700001;
    await request(app).post('/api/v1/webhooks/wompi').send(invalid)
      .expect(401)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_signature'));
    assert.equal(settled, 0);
  });

  it('acknowledges valid irrelevant events and wrong environments without settling', async () => {
    let settled = 0;
    const app = createFixture({ settlePayment: async () => { settled += 1; } });
    await request(app).post('/api/v1/webhooks/wompi').send(event({ eventName: 'transaction.created' })).expect(200);
    await request(app).post('/api/v1/webhooks/wompi').send(event({ environment: 'prod' })).expect(200);
    assert.equal(settled, 0);
  });

  it('accepts webhook environments by WOMPI_ENVIRONMENT, independently of app runtime', async () => {
    const sandboxSettled = [];
    const sandbox = createFixture({ settlePayment: async (input) => sandboxSettled.push(input) });
    await request(sandbox).post('/api/v1/webhooks/wompi').send(event({ environment: 'prod' })).expect(200);
    await request(sandbox).post('/api/v1/webhooks/wompi').send(event()).expect(200);
    assert.equal(sandboxSettled.length, 1);
    const productionSettled = [];
    const production = createFixture({ wompiEnvironment: 'production',
      settlePayment: async (input) => productionSettled.push(input) });
    await request(production).post('/api/v1/webhooks/wompi').send(event()).expect(200);
    await request(production).post('/api/v1/webhooks/wompi').send(event({ environment: 'prod' })).expect(200);
    assert.equal(productionSettled.length, 1);
  });

  for (const status of ['DECLINED', 'ERROR']) {
    it(`settles ${status} webhooks through the unified boundary`, async () => {
      const settled = [];
      const app = createFixture({ settlePayment: async (input) => { settled.push(input); return { confirmed: false }; } });
      await request(app).post('/api/v1/webhooks/wompi').send(event({ status })).expect(200);
      assert.equal(settled.length, 1);
      assert.equal(settled[0].facts.status, status);
    });
  }

  it('reconciles provider facts through the same settlement boundary', async () => {
    const facts = { id: 'tx_1', reference: 'RC-BKG-901-abc', amountInCents: 2700000, currency: 'COP', status: 'APPROVED' };
    const providerCalls = [];
    const settled = [];
    const app = createFixture({
      findTransaction: async (transactionId) => { providerCalls.push(transactionId); return facts; },
      settlePayment: async (input) => { settled.push(input); return { confirmed: true }; },
    });
    await request(app).post('/api/v1/bookings/901/payments/wompi/reconcile').set('X-User-Id', '7')
      .send({ transactionId: 'tx_reconcile' }).expect(200, { reconciled: true });
    assert.deepEqual(providerCalls, ['tx_reconcile']);
    assert.deepEqual(settled, [{ provider: 'WOMPI', facts }]);
  });
});
