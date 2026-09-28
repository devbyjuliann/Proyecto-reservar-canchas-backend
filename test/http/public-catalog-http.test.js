import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { createPublicCatalogModule } from '../../src/modules/public-catalog/index.js';
import { appError } from '../../src/shared/errors.js';

const ORIGIN = 'https://app.example.test';
const facility = {
  id: '3', name: 'Centro Deportivo', city: 'Bogotá', address: 'Calle 1',
  description: 'Canchas cubiertas', image: null,
};
const court = {
  id: '12', name: 'Cancha Central', sportCode: 'FUTBOL_5', description: 'Cubierta',
  facility: { id: '3', name: facility.name, city: facility.city }, image: null,
};

function fixture({ pricesReady = true } = {}) {
  const calls = [];
  const adapter = {
    async pricingReady() { return pricesReady; },
    async list(input) {
      calls.push(input);
      const rows = input.kind === 'facilities' ? [facility, { ...facility, id: '4' }] : [court, { ...court, id: '13' }];
      return input.position ? rows.slice(1) : rows;
    },
    async getFacility(id) { return id === '3' ? facility : null; },
    async getCourt(id) { return id === '12' ? court : null; },
    async publish() { return false; },
    async unpublish() { return { changed: false }; },
  };
  let availabilityCalls = 0;
  let confirmationCalls = 0;
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    booking: {
      async getAvailability() { availabilityCalls += 1; return { options: [] }; },
      async confirmBooking() {
        confirmationCalls += 1;
        if (!pricesReady) throw appError('resource_not_found', 'The requested resource was not found');
        return { booking: {}, replayed: false };
      },
    },
    facilities: {
      async getFacility() { return { ...facility, publicationState: 'DRAFT' }; },
    },
    catalog: createPublicCatalogModule({
      adapter, clock: { now: () => '2026-09-25T12:00:00.000000Z' },
    }),
    auth: {
      async resolveSession(token) {
        const roles = token === 'admin' ? ['USUARIO', 'ADMINISTRADOR']
          : token === 'owner' ? ['USUARIO', 'PROPIETARIO'] : ['USUARIO'];
        return token ? { sessionId: '1', user: { id: '7', roles } } : null;
      },
      async register() {}, async login() {}, async revokeSession() {},
    },
    findActiveUserById: async () => null,
    logger: { error() {} },
  });
  return { app, calls, get availabilityCalls() { return availabilityCalls; },
    get confirmationCalls() { return confirmationCalls; } };
}

describe('public catalog HTTP contract', () => {
  it('serves five routes without a session and binds cursors to normalized filters', async () => {
    const { app, calls } = fixture();
    const first = await request(app)
      .get('/api/v1/facilities?limit=1&q=Centro&city=BOGOTÁ&sport=FUTBOL_5').expect(200);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.items[0].membershipRole, undefined);
    assert.equal(first.body.items[0].publishedByUserId, undefined);
    assert.equal(calls[0].filters.city, 'bogotá');
    const next = await request(app)
      .get(`/api/v1/facilities?limit=1&q=Centro&city=BOGOTÁ&sport=FUTBOL_5&cursor=${first.body.page.nextCursor}`)
      .expect(200);
    assert.equal(next.body.items[0].id, '4');
    await request(app)
      .get(`/api/v1/facilities?limit=1&q=Otro&city=BOGOTÁ&sport=FUTBOL_5&cursor=${first.body.page.nextCursor}`)
      .expect(400);
    await request(app).get('/api/v1/facilities/3').expect(200);
    await request(app).get('/api/v1/facilities/3/courts?sport=FUTBOL_5').expect(200);
    await request(app).get('/api/v1/courts?q=Cancha&city=Bogotá&sport=FUTBOL_5').expect(200);
    await request(app).get('/api/v1/courts/12').expect(200)
      .expect(({ body }) => assert.equal(body.court.sportCode, 'FUTBOL_5'));
    await request(app).get('/api/v1/courts/99').expect(404);
    await request(app).get('/api/v1/courts?date=2026-09-28').expect(400);
    await request(app).get('/api/v1/facilities?minPriceMinor=1&maxPriceMinor=9000000').expect(200);
    await request(app).get('/api/v1/facilities?minPriceMinor=9000001&maxPriceMinor=1').expect(400);
    await request(app).get('/api/v1/facilities?minPriceMinor=0').expect(400);
  });

  it('blocks public routes and booking when pricing is unavailable', async () => {
    const fixture_ = fixture({ pricesReady: false });
    const { app } = fixture_;
    await request(app).get('/api/v1/facilities').expect(200)
      .expect(({ body }) => assert.deepEqual(body.items, []));
    await request(app).get('/api/v1/courts').expect(200)
      .expect(({ body }) => assert.deepEqual(body.items, []));
    await request(app).get('/api/v1/facilities/3').expect(404);
    await request(app).get('/api/v1/courts/12').expect(404);
    await request(app).get('/api/v1/courts/12/availability?date=2026-09-28').expect(404);
    await request(app).post('/api/v1/bookings').set('Origin', ORIGIN)
      .set('Cookie', '__Host-reserva_session=user')
      .set('Idempotency-Key', 'catalog-hidden-court')
      .send({ courtId: '12', localDate: '2026-09-28', startTime: '16:00:00',
        durationMinutes: 60, expectedPriceMinor: 9000000, currency: 'COP' })
      .expect(404);
    assert.equal(fixture_.availabilityCalls, 0);
    assert.equal(fixture_.confirmationCalls, 1);
  });

  it('requires ADMINISTRADOR to publish and blocks even a complete draft without price', async () => {
    const { app } = fixture({ pricesReady: false });
    const url = '/api/v1/admin/facilities/3/publication';
    await request(app).post(url).set('Origin', ORIGIN).expect(401);
    await request(app).post(url).set('Origin', ORIGIN)
      .set('Cookie', '__Host-reserva_session=user').expect(403);
    await request(app).post(url).set('Origin', ORIGIN)
      .set('Cookie', '__Host-reserva_session=owner').expect(403);
    await request(app).post(url).set('Origin', ORIGIN)
      .set('Cookie', '__Host-reserva_session=admin').expect(409)
      .expect(({ body }) => assert.equal(body.error.code, 'facility_not_publishable'));
    await request(app).delete(url).set('Origin', ORIGIN)
      .set('Cookie', '__Host-reserva_session=admin').expect(200)
      .expect(({ body }) => assert.equal(body.operation.changed, false));
  });
});
