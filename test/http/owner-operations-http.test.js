import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { appError } from '../../src/shared/errors.js';

const ORIGIN = 'https://app.example.test';
const PREFIX = '/api/v1/owner';

function fixture() {
  const calls = [];
  const actors = {
    owner: { id: '7', roles: ['USUARIO', 'PROPIETARIO'] },
    other: { id: '8', roles: ['USUARIO', 'PROPIETARIO'] },
    user: { id: '9', roles: ['USUARIO'] },
    admin: { id: '10', roles: ['USUARIO', 'ADMINISTRADOR'] },
  };
  let membershipActive = true;
  const memberships = {
    async requireMembership({ actor, facilityId }) {
      if (!actor.roles.includes('PROPIETARIO') || facilityId !== '3' || !membershipActive) {
        throw appError('resource_not_found', 'The requested resource was not found');
      }
    },
    async requireCourtMembership({ actor, courtId }) {
      if (courtId !== '12') throw appError('resource_not_found', 'The requested resource was not found');
      return this.requireMembership({ actor, facilityId: '3' });
    },
    async requireUnavailabilityMembership({ actor, unavailabilityId }) {
      if (unavailabilityId !== '81') throw appError('resource_not_found', 'The requested resource was not found');
      return this.requireMembership({ actor, facilityId: '3' });
    },
  };
  const facility = { id: '3', name: 'Centro Deportivo' };
  const court = { id: '12', name: 'Cancha 1' };
  const facilities = {
    async listCourts(input) { calls.push(['listCourts', input]); return { items: [court], page: { nextCursor: null } }; },
    async createFacility(input) { calls.push(['createFacility', input]); return { facility, membership: { id: '1' }, operation: { changed: true, changes: [] } }; },
    async updateFacility(input) { calls.push(['updateFacility', input]); return { facility, operation: { changed: true, changes: [] } }; },
    async getCourt(input) { calls.push(['getCourt', input]); return court; },
    async updateCourt(input) { calls.push(['updateCourt', input]); return { court, operation: { changed: true, changes: [] } }; },
  };
  const booking = Object.fromEntries([
    'replaceFacilityBookingPolicy', 'deactivateFacility', 'createCourt',
    'getCourtBookingConfiguration', 'replaceCourtBookingConfiguration',
    'getWeeklySchedule', 'replaceWeeklySchedule', 'listDateExceptions',
    'getDateException', 'putDateException', 'deleteDateException',
    'listUnavailabilities', 'createUnavailability', 'getUnavailability', 'deactivateCourt',
  ].map((method) => [method, async (input) => {
    calls.push([method, input]);
    if (method === 'createCourt') return { court, operation: { changed: true, changes: [] } };
    if (method === 'createUnavailability') return { unavailability: { id: '81' }, operation: { changed: true, changes: [] } };
    if (method === 'getWeeklySchedule') return { courtId: '12', periods: [] };
    if (method === 'getCourtBookingConfiguration') return { courtId: '12' };
    if (method === 'getUnavailability') return { id: '81' };
    if (method === 'listDateExceptions' || method === 'listUnavailabilities') return { items: [], page: { nextCursor: null } };
    return { operation: { changed: true, changes: [] } };
  }]));
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    facilities, booking, memberships,
    auth: {
      async resolveSession(token) { return actors[token] ? { sessionId: token, user: actors[token] } : null; },
      async register() {}, async login() {}, async revokeSession() {},
    },
    findActiveUserById: async () => null,
    logger: { error() {} },
  });
  return { app, calls, revoke() { membershipActive = false; } };
}

const cookie = (identity) => `__Host-reserva_session=${identity}`;

describe('owner operations HTTP contract', () => {
  it('requires owner role and membership for reads and rejects foreign court IDs', async () => {
    const { app, calls, revoke } = fixture();
    await request(app).get(`${PREFIX}/facilities/3/courts`).expect(401);
    await request(app).get(`${PREFIX}/facilities/3/courts`).set('Cookie', cookie('user')).expect(403);
    await request(app).get(`${PREFIX}/courts/12`).set('Cookie', cookie('admin')).expect(403);
    await request(app).get(`${PREFIX}/courts/99`).set('Cookie', cookie('owner')).expect(404);
    await request(app).get(`${PREFIX}/facilities/3/courts`).set('Cookie', cookie('owner')).expect(200);
    await request(app).get(`${PREFIX}/courts/12`).set('Cookie', cookie('owner')).expect(200);
    assert.equal(calls.find(([name]) => name === 'getCourt')[1].actor.ownerScope, true);
    revoke();
    await request(app).get(`${PREFIX}/courts/12`).set('Cookie', cookie('owner')).expect(404);
  });

  it('delegates mutations with owner scope and validates the existing contracts', async () => {
    const { app, calls } = fixture();
    const post = (path, body) => request(app).post(`${PREFIX}${path}`)
      .set('Origin', ORIGIN).set('Cookie', cookie('owner')).send(body);
    const put = (path, body) => request(app).put(`${PREFIX}${path}`)
      .set('Origin', ORIGIN).set('Cookie', cookie('owner')).send(body);
    await post('/facilities/3/courts', {
      name: 'Cancha 1', description: 'Cubierta', sportCode: 'FUTBOL_5',
      minimumSeparationMinutes: 0, startIntervalMinutes: 30, allowedDurationsMinutes: [60],
    }).expect(201).expect('Location', `${PREFIX}/courts/12`);
    await request(app).patch(`${PREFIX}/courts/12`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).send({ name: 'Cancha Norte' }).expect(200);
    await put('/courts/12/booking-configuration', {
      courtId: '12', minimumSeparationMinutes: 0, startIntervalMinutes: 30,
      allowedDurationsMinutes: [60, 90],
    }).expect(200);
    await put('/courts/12/weekly-schedule', {
      periods: [{ weekday: 1, startTime: '10:00:00', endTime: '14:00:00' }],
    }).expect(200);
    await put('/courts/12/date-exceptions/2026-09-28', { mode: 'CLOSED', periods: [] }).expect(200);
    await post('/courts/12/unavailabilities', {
      type: 'BLOQUEO_ADMINISTRATIVO', startAt: '2026-09-28T21:00:00Z',
      endAt: '2026-09-28T22:00:00Z', reason: 'Evento',
    }).expect(201);
    await request(app).get(`${PREFIX}/unavailabilities/81`).set('Cookie', cookie('owner')).expect(200);
    await request(app).get(`${PREFIX}/unavailabilities/99`).set('Cookie', cookie('owner')).expect(404);
    await post('/courts/12/deactivation', {}).expect(400);
    await request(app).post(`${PREFIX}/courts/12/deactivation`).set('Origin', ORIGIN)
      .set('Cookie', cookie('owner')).expect(200);
    assert.equal(calls.every(([, input]) => input.actor.ownerScope === true), true);
    await put('/courts/12/booking-configuration', { courtId: '99',
      minimumSeparationMinutes: 0, startIntervalMinutes: 30, allowedDurationsMinutes: [60] }).expect(400);
  });
});
