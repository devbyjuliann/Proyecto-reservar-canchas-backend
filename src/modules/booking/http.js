import { Router } from 'express';

import { bookingError } from './errors.js';
import {
  validateAvailabilityRequest,
  validateCancellationRequest,
  validateConfirmationRequest,
  validateIdempotencyKey,
  validateOwnBookingsRequest,
} from './validation.js';

export function createBookingRouter({ booking, requireIdentity }) {
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
    response.status(result.replayed ? 200 : 201).json({ booking: result.booking });
  });

  router.get('/api/v1/me/bookings', requireIdentity, async (request, response) => {
    const input = validateOwnBookingsRequest(request.query);
    response.json(await booking.listOwnBookings({
      actor: request.context.user,
      ...input,
    }));
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
      }));
    },
  );

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
