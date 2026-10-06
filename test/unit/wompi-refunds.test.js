import assert from 'node:assert/strict';
import test from 'node:test';

import { createWompiProvider } from '../../src/modules/payments/wompi.js';

test('Wompi V2 refund uses Sandbox, backend key, merchant and stable idempotency reference', async () => {
  let calls = 0;
  const config = { enabled: true, environment: 'sandbox', privateKey: 'prv_test_private', merchantId: 'merchant_123', refundScenario: 'approved' };
  const provider = createWompiProvider({ config, fetchImpl: async (url, request) => {
    calls += 1;
    assert.equal(url, 'https://sandbox.wompi.co/v1/refunds');
    assert.equal(request.headers.Authorization, 'Bearer prv_test_private');
    assert.deepEqual(JSON.parse(request.body), {
      idempotency_key: 'RC-REF-1-abc', transaction_id: 'tx1', merchant_id: 'merchant_123', region: 'CO',
      currency: 'COP', amount_in_cents: 2500000, fee_in_cents: 0, fee_vat_in_cents: 0,
      total_freeze_amount: 2500000, references: ['RC-REF-1-abc'], reference: 'RC-REF-1-abc', reason: 'OWNER_CANCELLATION',
      test_scenario: 'approved',
    });
    return { status: calls === 1 ? 202 : 409, json: async () => ({ refund_id: 'ref_1', status: 'PENDING' }) };
  } });
  const input = { transactionId: 'tx1', amountInCents: 2500000,
    reference: 'RC-REF-1-abc', reason: 'OWNER_CANCELLATION' };
  assert.deepEqual(await provider.createRefund(input), { id: 'ref_1', status: 'PENDING' });
  assert.deepEqual(await provider.createRefund(input), { id: 'ref_1', status: 'PENDING' });
});

test('refund adapter refuses unconfigured merchant ID before contacting Wompi', async () => {
  const provider = createWompiProvider({ config: { enabled: true, environment: 'sandbox', privateKey: 'prv_test_private' },
    fetchImpl: () => { throw new Error('must not send'); } });
  await assert.rejects(provider.createRefund({}), /WOMPI_MERCHANT_ID/);
});

test('Sandbox V2 201 response uses v2_refund_id and final status', async () => {
  const provider = createWompiProvider({ config: { enabled: true, environment: 'sandbox', privateKey: 'prv_test_key', merchantId: 'm' },
    fetchImpl: async () => ({ status: 201, json: async () => ({ data: {
      id: 123, v2_refund_id: 'v2_refund_abc', status: 'APPROVED', amount_in_cents: 2500000,
      transaction_id: 'tx1', currency: 'COP',
    } }) }) });
  assert.deepEqual(await provider.createRefund({ amountInCents: 2500000, transactionId: 'tx1', reference: 'ref' }),
    { id: 'v2_refund_abc', status: 'APPROVED', amount_in_cents: 2500000, transaction_id: 'tx1', currency: 'COP' });
});

test('provider URL selection follows WOMPI_ENVIRONMENT and never uses a Sandbox URL for production', async () => {
  const paths = [];
  for (const environment of ['sandbox', 'production']) {
    const provider = createWompiProvider({ config: { enabled: true, environment,
      privateKey: environment === 'sandbox' ? 'prv_test_placeholder' : 'prv_prod_placeholder', merchantId: 'example' },
    fetchImpl: async (url, options) => {
      paths.push(url);
      if (options?.method === 'POST') return { status: 201, json: async () => ({ data: {
        v2_refund_id: 'refund_1', status: 'APPROVED', transaction_id: 'tx_1',
        amount_in_cents: 100, currency: 'COP',
      } }) };
      return { ok: true, json: async () => ({ data: { id: 'tx_1' } }) };
    } });
    await provider.findTransaction('tx_1');
    await provider.createRefund({ transactionId: 'tx_1', amountInCents: 100,
      reference: 'RC-REF-test', reason: 'LATE_PAYMENT' });
    await provider.findRefund('refund_1');
  }
  assert.deepEqual(paths, ['https://sandbox.wompi.co/v1/transactions/tx_1',
    'https://sandbox.wompi.co/v1/refunds',
    'https://sandbox.wompi.co/v1/refunds/refund_1',
    'https://production.wompi.co/v1/transactions/tx_1',
    'https://production.wompi.co/v1/refunds',
    'https://production.wompi.co/v1/refunds/refund_1']);
  assert.throws(() => createWompiProvider({ config: { enabled: true, environment: 'production',
    refundScenario: 'approved' } }), /require Sandbox/);
});
