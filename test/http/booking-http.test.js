import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { appError } from '../../src/shared/errors.js';

const BOOKING = {
  id: '901',
  court: { id: '12', name: 'Cancha 1' },
  facility: { id: '3', name: 'Centro Deportivo' },
  startAt: '2026-09-28T21:00:00.000000Z',
  endAt: '2026-09-28T22:00:00.000000Z',
  timeZone: 'America/Bogota',
  status: 'CONFIRMADA',
  createdAt: '2026-09-24T14:31:00.000000Z',
  cancelledAt: null,
};

function createFixture({ environment = 'test', bookingOverrides = {} } = {}) {
  const attempts = new Map();
  const booking = {
    async getAvailability({ courtId, date }) {
      return {
        court: { id: courtId, timeZone: 'America/Bogota' },
        date,
        generatedAt: '2026-09-24T14:30:00.000000Z',
        options: [{
          startTime: '16:00:00',
          durationMinutes: 60,
          startAt: BOOKING.startAt,
          endAt: BOOKING.endAt,
        }],
      };
    },
    async confirmBooking({ request: input, idempotencyKey }) {
      const fingerprint = JSON.stringify(input);
      const previous = attempts.get(idempotencyKey);
      if (previous && previous !== fingerprint) {
        throw appError(
          'invalid_idempotency_key_reuse',
          'The idempotency key was used for another request',
        );
      }
      attempts.set(idempotencyKey, fingerprint);
      return { booking: BOOKING, replayed: previous !== undefined };
    },
    async listOwnBookings() {
      return { items: [BOOKING], page: { nextCursor: null } };
    },
    async cancelBooking() {
      return {
        booking: {
          ...BOOKING,
          status: 'CANCELADA',
          cancelledAt: '2026-09-25T10:00:00.000000Z',
        },
      };
    },
    ...bookingOverrides,
  };
  return createApp({
    booking,
    environment,
    findActiveUserById: async (id) => (id === '7' ? { id: '7', roles: ['USUARIO'] } : null),
    logger: { error() {} },
  });
}

describe('booking HTTP contract', () => {
  it('serves health and public availability', async () => {
    const app = createFixture();
    await request(app).get('/health').expect(200, { status: 'ok' });
    const response = await request(app)
      .get('/api/v1/courts/12/availability?date=2026-09-28')
      .set('X-User-Id', 'invalid-but-ignored')
      .expect(200);
    assert.equal(response.body.court.id, '12');
    assert.equal(response.body.options[0].durationMinutes, 60);

    await request(app)
      .get('/api/v1/courts/12/availability?date=2026-09-28&courtId=13')
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
  });

  it('maps malformed public ids to invalid_request', async () => {
    const app = createFixture();
    await request(app)
      .get('/api/v1/courts/abc/availability?date=2026-09-28')
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'invalid-court-id')
      .send({
        courtId: '12abc',
        localDate: '2026-09-28',
        startTime: '16:00:00',
        durationMinutes: 60,
      })
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
    await request(app)
      .post('/api/v1/bookings/abc/cancellation')
      .set('X-User-Id', '7')
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
  });

  it('requires an active provisional identity on protected routes', async () => {
    const app = createFixture();
    await request(app)
      .get('/api/v1/me/bookings')
      .expect(401)
      .expect(({ body }) => assert.equal(body.error.code, 'authentication_required'));
    await request(app)
      .get('/api/v1/me/bookings')
      .set('X-User-Id', '99')
      .expect(401);
  });

  for (const environment of ['development', 'test']) {
    it(`accepts provisional identity in ${environment}`, async () => {
      await request(createFixture({ environment }))
        .get('/api/v1/me/bookings')
        .set('X-User-Id', '7')
        .expect(200);
    });
  }

  it('rejects provisional identity in production', async () => {
    await request(createFixture({ environment: 'production' }))
      .get('/api/v1/me/bookings')
      .set('X-User-Id', '7')
      .expect(401)
      .expect(({ body }) => assert.equal(body.error.code, 'authentication_required'));
  });

  it('rejects provisional identity in every unexpected environment', async () => {
    for (const environment of ['', 'staging', 'Development']) {
      await request(createFixture({ environment }))
        .get('/api/v1/me/bookings')
        .set('X-User-Id', '7')
        .expect(401)
        .expect(({ body }) => assert.equal(body.error.code, 'authentication_required'));
    }
  });

  it('returns 201 for confirmation and 200 for an idempotent replay', async () => {
    const app = createFixture();
    const payload = {
      courtId: '12',
      localDate: '2026-09-28',
      startTime: '16:00:00',
      durationMinutes: 60,
    };
    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'attempt-1')
      .send(payload)
      .expect(201);
    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'attempt-1')
      .send(payload)
      .expect(200)
      .expect(({ body }) => assert.equal(body.booking.id, '901'));
  });

  it('rejects reuse of a key for another payload', async () => {
    const app = createFixture();
    const payload = {
      courtId: '12',
      localDate: '2026-09-28',
      startTime: '16:00:00',
      durationMinutes: 60,
    };
    await request(app).post('/api/v1/bookings')
      .set('X-User-Id', '7').set('Idempotency-Key', 'attempt-2')
      .send(payload).expect(201);
    await request(app).post('/api/v1/bookings')
      .set('X-User-Id', '7').set('Idempotency-Key', 'attempt-2')
      .send({ ...payload, durationMinutes: 30 })
      .expect(409)
      .expect(({ body }) => assert.equal(
        body.error.code,
        'invalid_idempotency_key_reuse',
      ));
  });

  it('lists own bookings and cancels without a body', async () => {
    const app = createFixture();
    await request(app)
      .get('/api/v1/me/bookings')
      .set('X-User-Id', '7')
      .expect(200)
      .expect(({ body }) => {
        assert.equal(body.items[0].status, 'CONFIRMADA');
        assert.equal(body.page.nextCursor, null);
      });
    await request(app)
      .post('/api/v1/bookings/901/cancellation')
      .set('X-User-Id', '7')
      .expect(200)
      .expect(({ body }) => assert.equal(body.booking.status, 'CANCELADA'));
  });

  it('rejects unknown confirmation fields and cancellation bodies', async () => {
    const app = createFixture();
    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'attempt-3')
      .send({
        courtId: '12',
        localDate: '2026-09-28',
        startTime: '16:00:00',
        durationMinutes: 60,
        userId: '7',
      })
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
    await request(app)
      .post('/api/v1/bookings/901/cancellation')
      .set('X-User-Id', '7')
      .send({})
      .expect(400);
  });

  it('maps malformed and oversized JSON to invalid_request', async () => {
    const app = createFixture();
    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'attempt-json')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));

    await request(app)
      .post('/api/v1/bookings')
      .set('X-User-Id', '7')
      .set('Idempotency-Key', 'attempt-large')
      .send({ padding: 'x'.repeat(33 * 1024) })
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
  });

  it('maps documented application errors without leaking internals', async () => {
    const booking = {
      async getAvailability() {
        throw appError('resource_not_found', 'The requested resource was not found');
      },
      async confirmBooking() {},
      async listOwnBookings() {},
      async cancelBooking() {},
    };
    const app = createApp({
      booking,
      environment: 'test',
      findActiveUserById: async () => ({ id: '7' }),
      logger: { error() {} },
    });
    await request(app)
      .get('/api/v1/courts/12/availability?date=2026-09-28')
      .expect(404)
      .expect(({ body }) => assert.deepEqual(body, {
        error: {
          code: 'resource_not_found',
          message: 'The requested resource was not found',
        },
      }));
  });

  it('sanitizes unexpected failures as internal_error', async () => {
    const booking = {
      async getAvailability() {
        throw new Error('SQL password and internal details');
      },
      async confirmBooking() {},
      async listOwnBookings() {},
      async cancelBooking() {},
    };
    const app = createApp({
      booking,
      environment: 'test',
      findActiveUserById: async () => ({ id: '7' }),
      logger: { error() {} },
    });
    await request(app)
      .get('/api/v1/courts/12/availability?date=2026-09-28')
      .expect(500)
      .expect(({ body }) => assert.deepEqual(body, {
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred',
        },
      }));
  });

  for (const { code, status } of [
    { code: 'invalid_booking_option', status: 422 },
    { code: 'option_not_available', status: 409 },
    { code: 'booking_conflict', status: 409 },
  ]) {
    it(`maps confirmation error ${code}`, async () => {
      const app = createFixture({
        bookingOverrides: {
          async confirmBooking() {
            throw appError(code, 'Booking rejected');
          },
        },
      });
      await request(app)
        .post('/api/v1/bookings')
        .set('X-User-Id', '7')
        .set('Idempotency-Key', `error-${code}`)
        .send({
          courtId: '12',
          localDate: '2026-09-28',
          startTime: '16:00:00',
          durationMinutes: 60,
        })
        .expect(status)
        .expect(({ body }) => assert.equal(body.error.code, code));
    });
  }

  for (const { code, status } of [
    { code: 'forbidden', status: 403 },
    { code: 'resource_not_found', status: 404 },
    { code: 'booking_already_started', status: 409 },
    { code: 'invalid_booking_state', status: 409 },
  ]) {
    it(`maps cancellation error ${code}`, async () => {
      const app = createFixture({
        bookingOverrides: {
          async cancelBooking() {
            throw appError(code, 'Cancellation rejected');
          },
        },
      });
      await request(app)
        .post('/api/v1/bookings/901/cancellation')
        .set('X-User-Id', '7')
        .expect(status)
        .expect(({ body }) => assert.equal(body.error.code, code));
    });
  }
});
