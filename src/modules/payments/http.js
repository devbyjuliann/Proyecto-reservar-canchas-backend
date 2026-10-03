import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { bookingError } from '../booking/errors.js';
import { checkoutIntegrity, normalizeWompiTransaction, verifyWebhookSignature } from './wompi.js';
import { wompiAmountInCentsFromMinor } from './money.js';

export function createPaymentsRouter({ booking, wompi, requireIdentity }) {
  const router = Router();
  if (!wompi?.config?.enabled) return router;
  router.post('/api/v1/bookings/:bookingId/payments/wompi/checkout', requireIdentity, async (request, response) => {
    if (request.body && Object.keys(request.body).length) throw bookingError('invalid_request');
    const bookingId = canonicalId(request.params.bookingId);
    const reference = `RC-BKG-${bookingId}-${randomBytes(12).toString('hex')}`;
    const attempt = await booking.createPaymentAttempt({ actor: request.context.user, bookingId, provider: 'WOMPI', reference });
    const amountInCents = wompiAmountInCentsFromMinor(attempt.amountMinor);
    const expirationTime = attempt.expiresAt;
    response.status(201).json({ config: { publicKey: wompi.config.publicKey, currency: 'COP', amountInCents,
      reference, integrity: checkoutIntegrity({ reference, amountInCents, expirationTime,
        integritySecret: wompi.config.integritySecret }), expirationTime, redirectUrl: wompi.redirectUrl } });
  });
  router.post('/api/v1/bookings/:bookingId/payments/wompi/reconcile', requireIdentity, async (request, response) => {
    if (request.body && (Object.keys(request.body).join(',') !== 'transactionId' || typeof request.body.transactionId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(request.body.transactionId))) throw bookingError('invalid_request');
    const bookingId = canonicalId(request.params.bookingId);
    const transactionId = request.body?.transactionId
      ?? await booking.getLatestWompiTransaction({ actor: request.context.user, bookingId });
    if (!transactionId) throw bookingError('invalid_booking_state');
    const facts = await wompi.provider.findTransaction(transactionId);
    if (facts) await booking.settlePayment({ provider: 'WOMPI', facts });
    response.json({ reconciled: true });
  });
  return router;
}

export function createWompiWebhookRouter({ booking, wompi }) {
  const router = Router();
  if (!wompi?.config?.enabled) return router;
  router.post('/api/v1/webhooks/wompi', async (request, response) => {
    const event = request.body;
    const header = request.get('X-Event-Checksum') ?? request.get('X-Signature');
    if (!verifyWebhookSignature({ event, eventsSecret: wompi.config.eventsSecret, headerSignature: header })) {
      response.status(401).json({ error: { code: 'invalid_signature', message: 'Invalid signature' } }); return;
    }
    if (event.environment !== 'test' || event.event !== 'transaction.updated') { response.status(200).end(); return; }
    const facts = normalizeWompiTransaction(event.data?.transaction);
    if (!facts?.id || !facts.reference || facts.amountInCents == null || facts.currency !== 'COP') { response.status(200).end(); return; }
    await booking.settlePayment({ provider: 'WOMPI', facts, eventId: typeof event.id === 'string' ? event.id : null });
    response.status(200).end();
  });
  return router;
}

function canonicalId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw bookingError('invalid_request');
  return value;
}
