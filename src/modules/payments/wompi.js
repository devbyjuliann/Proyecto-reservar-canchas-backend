import { createHash, timingSafeEqual } from 'node:crypto';

export const WOMPI_SANDBOX_BASE_URL = 'https://sandbox.wompi.co/v1';
export const WOMPI_PRODUCTION_BASE_URL = 'https://production.wompi.co/v1';

export function wompiBaseUrl(environment) {
  if (environment === 'sandbox') return WOMPI_SANDBOX_BASE_URL;
  if (environment === 'production') return WOMPI_PRODUCTION_BASE_URL;
  throw new Error('Unsupported Wompi environment');
}

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function checkoutIntegrity({ reference, amountInCents, expirationTime, integritySecret }) {
  return sha256(`${reference}${amountInCents}COP${expirationTime}${integritySecret}`);
}

export function verifyWebhookSignature({ event, eventsSecret, headerSignature }) {
  const signature = event?.signature;
  const properties = signature?.properties;
  if (!Array.isArray(properties) || !properties.every((item) => typeof item === 'string')) return false;
  const values = [];
  for (const property of properties) {
    let value = event.data;
    for (const part of property.split('.')) value = value?.[part];
    if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
    values.push(String(value));
  }
  const timestamp = event.timestamp;
  if (!['string', 'number'].includes(typeof timestamp)) return false;
  const expected = sha256(`${values.join('')}${timestamp}${eventsSecret}`).toLowerCase();
  const candidates = [signature.checksum, ...(headerSignature === undefined ? [] : [headerSignature])];
  return candidates.length > 0 && candidates.every((candidate) => {
    const supplied = String(candidate ?? '').toLowerCase();
    return /^[a-f0-9]{64}$/.test(supplied)
      && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
  });
}

export function normalizeWompiTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return null;
  return {
    id: typeof transaction.id === 'string' ? transaction.id : null,
    reference: typeof transaction.reference === 'string' ? transaction.reference : null,
    amountInCents: Number.isSafeInteger(transaction.amount_in_cents) ? transaction.amount_in_cents : null,
    currency: transaction.currency,
    status: transaction.status,
    finalizedAt: transaction.finalized_at ?? null,
    paymentMethodType: transaction.payment_method_type ?? transaction.payment_method?.type ?? null,
  };
}

export function createWompiProvider({ config, fetchImpl = globalThis.fetch }) {
  if (!config?.enabled) return null;
  const baseUrl = wompiBaseUrl(config.environment);
  if (config.refundScenario && config.environment !== 'sandbox') {
    throw new Error('Wompi refund test scenarios require Sandbox');
  }
  return Object.freeze({
    async findTransaction(transactionId) {
      const response = await fetchImpl(`${baseUrl}/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${config.privateKey}` },
      });
      if (!response.ok) throw new Error(`Wompi transaction lookup failed: ${response.status}`);
      const body = await response.json();
      return normalizeWompiTransaction(body.data);
    },
    async createRefund({ transactionId, amountInCents, reference, reason }) {
      if (!config.merchantId) throw new Error('WOMPI_MERCHANT_ID is required for refunds');
      const response = await fetchImpl(`${baseUrl}/refunds`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.privateKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: reference, transaction_id: transactionId,
          merchant_id: config.merchantId, region: 'CO', currency: 'COP', amount_in_cents: amountInCents,
          fee_in_cents: 0, fee_vat_in_cents: 0, total_freeze_amount: amountInCents,
          references: [reference], reference, reason,
          ...(config.refundScenario ? { test_scenario: config.refundScenario } : {}) }),
      });
      const body = await response.json();
      // A replay of the same key returns 409 with the existing refund, not a second refund.
      const refund = body.data ?? body.refund ?? body;
      const id = refund.v2_refund_id ?? refund.refund_id;
      if (![201, 202].includes(response.status) && !(response.status === 409 && typeof id === 'string')) {
        throw new Error(`Wompi refund creation failed: ${response.status}`);
      }
      if (typeof id !== 'string' || !['PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'CANCELLED'].includes(refund.status)) {
        throw new Error('Wompi refund response is invalid');
      }
      if (refund.status === 'APPROVED' && (refund.transaction_id !== transactionId
        || refund.amount_in_cents !== amountInCents || refund.currency !== 'COP')) {
        throw new Error('Wompi approved refund facts do not match the captured payment');
      }
      return { id, status: refund.status,
        ...(refund.transaction_id ? { transaction_id: refund.transaction_id } : {}),
        ...(refund.amount_in_cents != null ? { amount_in_cents: refund.amount_in_cents } : {}),
        ...(refund.currency ? { currency: refund.currency } : {}) };
    },
    async findRefund(refundId) {
      const response = await fetchImpl(`${baseUrl}/refunds/${encodeURIComponent(refundId)}`, {
        headers: { Authorization: `Bearer ${config.privateKey}` },
      });
      if (!response.ok) throw new Error(`Wompi refund lookup failed: ${response.status}`);
      const body = await response.json();
      return body.data ?? body;
    },
  });
}
