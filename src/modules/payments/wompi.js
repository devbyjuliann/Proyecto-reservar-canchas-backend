import { createHash, timingSafeEqual } from 'node:crypto';

export const WOMPI_SANDBOX_BASE_URL = 'https://sandbox.wompi.co/v1';

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
  return Object.freeze({
    async findTransaction(transactionId) {
      const response = await fetchImpl(`${WOMPI_SANDBOX_BASE_URL}/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${config.privateKey}` },
      });
      if (!response.ok) throw new Error(`Wompi transaction lookup failed: ${response.status}`);
      const body = await response.json();
      return normalizeWompiTransaction(body.data);
    },
  });
}
