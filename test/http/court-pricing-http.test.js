import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { bookingError } from '../../src/modules/booking/errors.js';
import { createCourtPricingModule } from '../../src/modules/court-pricing/index.js';
import { appError } from '../../src/shared/errors.js';

const ORIGIN = 'https://app.example.test';
const ADMIN = '/api/v1/admin/courts/12/prices';
const OWNER = '/api/v1/owner/courts/12/prices';

function fixture() {
  let member = true;
  let priceMinor = null;
  const actors = {
    admin: { id: '1', roles: ['USUARIO', 'ADMINISTRADOR'] },
    owner: { id: '2', roles: ['USUARIO', 'PROPIETARIO'] },
    user: { id: '3', roles: ['USUARIO'] },
  };
  const pricing = createCourtPricingModule({
    memberships: {
      async requireMembership({ facilityId }) {
        if (!member || facilityId !== '3') throw appError('resource_not_found', 'Not found');
      },
    },
    adapter: {
      async getCourt() { return { facilityId: '3' }; },
      async listPrices() { return [{ courtId: '12', durationMinutes: 60, priceMinor, currency: priceMinor ? 'COP' : null }]; },
      async setPrice(input) {
        if (input.durationMinutes !== 60) return 'invalid_operational_configuration';
        const changed = priceMinor !== input.priceMinor;
        priceMinor = input.priceMinor;
        return { price: { courtId: input.courtId, durationMinutes: 60,
          priceMinor, currency: 'COP' }, changed };
      },
      async removePrice() {
        const changed = priceMinor !== null;
        priceMinor = null;
        return { price: null, changed };
      },
    },
  });
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    pricing,
    auth: {
      async resolveSession(token) {
        return actors[token] ? { sessionId: '5', user: actors[token] } : null;
      },
      async register() {}, async login() {}, async revokeSession() {},
    },
    booking: { async getAvailability() { return { options: [] }; },
      async confirmBooking() {
        throw bookingError('booking_price_changed', {
          details: { currentPriceMinor: 9500000, currency: 'COP' },
        });
      } },
    findActiveUserById: async () => null,
    logger: { error() {} },
  });
  return { app, revoke() { member = false; } };
}

const cookie = (identity) => `__Host-reserva_session=${identity}`;

describe('court pricing HTTP contract', () => {
  it('requires active owner membership and keeps administrator pricing read-only', async () => {
    const { app, revoke } = fixture();
    await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .send({ priceMinor: 9000000, currency: 'COP' }).expect(401);
    await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('user')).send({ priceMinor: 9000000, currency: 'COP' }).expect(403);
    await request(app).put(`${ADMIN}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 9000000, currency: 'COP' }).expect(403);
    const created = await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 9000000, currency: 'COP' }).expect(200);
    assert.equal(created.body.price.currency, 'COP');
    await request(app).get(OWNER).set('Cookie', cookie('owner')).expect(200)
      .expect(({ body }) => assert.equal(body.items[0].priceMinor, 9000000));
    revoke();
    await request(app).get(OWNER).set('Cookie', cookie('owner')).expect(404);
    await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 9100000, currency: 'COP' }).expect(404);
    await request(app).get(ADMIN).set('Cookie', cookie('admin')).expect(200);
    await request(app).put(`${ADMIN}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).send({ priceMinor: 9200000, currency: 'COP' }).expect(403);
    await request(app).delete(`${ADMIN}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('admin')).expect(403);
  });

  it('rejects zero, negative, wrong currency, extra fields, and disallowed durations', async () => {
    const { app } = fixture();
    for (const priceMinor of [0, -1]) {
      await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
        .set('Cookie', cookie('owner')).send({ priceMinor, currency: 'COP' }).expect(400);
    }
    await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 500, currency: 'USD' }).expect(400);
    await request(app).put(`${OWNER}/60`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 500, currency: 'COP', courtId: '12' }).expect(400);
    await request(app).put(`${OWNER}/90`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ priceMinor: 500, currency: 'COP' }).expect(422)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_operational_configuration'));
  });

  it('returns stable booking_price_changed details in the existing HTTP envelope', async () => {
    const { app } = fixture();
    await request(app).post('/api/v1/bookings').set('Origin', ORIGIN)
      .set('Cookie', cookie('user')).set('Idempotency-Key', 'new-price-attempt')
      .send({ courtId: '12', localDate: '2026-09-28', startTime: '16:00:00',
        durationMinutes: 60, expectedPriceMinor: 9000000, currency: 'COP' })
      .expect(409).expect(({ body }) => {
        assert.equal(body.error.code, 'booking_price_changed');
        assert.deepEqual(body.error.details, { currentPriceMinor: 9500000, currency: 'COP' });
      });
  });
});
