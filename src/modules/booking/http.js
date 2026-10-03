import { Router } from 'express';

import { bookingError } from './errors.js';
import {
  validateAvailabilityRequest,
  validateCancellationRequest,
  validateConfirmationRequest,
  validateFacilityCreditRequest,
  validateIdempotencyKey,
  validateOwnBookingsRequest,
  validateRescheduleRequest,
  validateExceptionRequest,
} from './validation.js';

export function createBookingRouter({ booking, requireIdentity, catalog }) {
  if (!booking || typeof requireIdentity !== 'function') {
    throw new TypeError('booking and requireIdentity are required');
  }

  const router = Router();

  router.get('/api/v1/courts/:courtId/availability', async (request, response) => {
    if (Object.keys(request.query).some((key) => key !== 'date')) {
      throw bookingError('invalid_request');
    }
    const input = validateAvailabilityRequest({
      courtId: request.params.courtId,
      date: request.query.date,
    });
    if (catalog && !await catalog.isCourtVisible(input.courtId)) {
      throw bookingError('resource_not_found');
    }
    response.json(await booking.getAvailability(input));
  });

  router.post('/api/v1/bookings', requireIdentity, async (request, response) => {
    const idempotencyKey = validateIdempotencyKey(singleHeader(request, 'idempotency-key'));
    const input = validateConfirmationRequest(request.body);
    const result = await booking.confirmBooking({
      actor: request.context.user,
      request: input,
      idempotencyKey,
    });
    response.status(result.replayed ? 200 : 201).json({ booking: result.booking, checkout: result.checkout });
  });

  if (process.env.NODE_ENV === 'test') {
    router.post('/api/v1/test/bookings/:bookingId/payments/approve', async (request, response) => {
      const { bookingId } = validateCancellationRequest({ bookingId: request.params.bookingId });
      const body = request.body;
      if (!body || Object.keys(body).sort().join(',') !== 'amountMinor,providerReference'
        || typeof body.providerReference !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(body.providerReference)
        || !Number.isSafeInteger(body.amountMinor) || body.amountMinor < 1) throw bookingError('invalid_request');
      response.json(await booking.approveTestPayment({ bookingId, providerReference: body.providerReference,
        amountMinor: body.amountMinor }));
    });
  }

  router.get('/api/v1/me/bookings', requireIdentity, async (request, response) => {
    const input = validateOwnBookingsRequest(request.query);
    response.json(await booking.listOwnBookings({
      actor: request.context.user,
      ...input,
    }));
  });

  router.get('/api/v1/me/facilities/:facilityId/credit', requireIdentity, async (request, response) => {
    const { facilityId } = validateFacilityCreditRequest({ facilityId: request.params.facilityId });
    response.json(await booking.getFacilityCredit({ actor: request.context.user, facilityId }));
  });

  router.post(
    '/api/v1/bookings/:bookingId/cancellation',
    requireIdentity,
    async (request, response) => {
      if (hasBody(request)) throw bookingError('invalid_request');
      const input = validateCancellationRequest({ bookingId: request.params.bookingId });
      response.json(await booking.cancelBooking({
        actor: request.context.user,
        bookingId: input.bookingId,
        expectedStartAt: request.get('X-Booking-Start-At'),
      }));
    },
  );

  router.post('/api/v1/bookings/:bookingId/reschedule', requireIdentity, async (request, response) => {
    const bookingId = validateCancellationRequest({ bookingId: request.params.bookingId }).bookingId;
    const idempotencyKey = validateIdempotencyKey(singleHeader(request, 'idempotency-key'));
    const result = await booking.rescheduleBooking({ actor: request.context.user, bookingId,
      request: validateRescheduleRequest(request.body), idempotencyKey });
    response.json({ booking: result.booking });
  });

  router.get('/api/v1/bookings/:bookingId/changes', requireIdentity, async (request, response) => {
    const { bookingId } = validateCancellationRequest({ bookingId: request.params.bookingId });
    response.json(await booking.listBookingChanges({ actor: request.context.user, bookingId }));
  });

  router.post('/api/v1/bookings/:bookingId/exception-requests', requireIdentity, async (request, response) => {
    const { bookingId } = validateCancellationRequest({ bookingId: request.params.bookingId });
    response.status(201).json(await booking.requestBookingException({ actor: request.context.user, bookingId,
      ...validateExceptionRequest(request.body) }));
  });

  router.post('/api/v1/bookings/:bookingId/exception-cancellation', requireIdentity, async (request, response) => {
    if (hasBody(request)) throw bookingError('invalid_request');
    const { bookingId } = validateCancellationRequest({ bookingId: request.params.bookingId });
    response.json(await booking.cancelExceptionBooking({ actor: request.context.user, bookingId }));
  });

  return router;
}

function singleHeader(request, name) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function hasBody(request) {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  return contentLength > 0 || request.headers['transfer-encoding'] !== undefined;
}
