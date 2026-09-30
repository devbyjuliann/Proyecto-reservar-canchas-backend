import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createErrorHandler } from '../../src/app/error-handler.js';
import { createAdminRouter } from '../../src/modules/admin/index.js';
import { appError } from '../../src/shared/errors.js';

const BASE = '/api/v1/admin';
function fixture(user = { id: '7', roles: ['ADMINISTRADOR'] }) {
  const calls = [];
  const fake = (name, result) => async () => { calls.push(name); return result; };
  const facility = { id: '3', name: 'Centro', state: 'active' };
  const facilities = {
    listFacilities: fake('listFacilities', { items: [facility], page: { nextCursor: null } }),
    getFacility: fake('getFacility', facility),
    listCourts: fake('listCourts', { items: [], page: { nextCursor: null } }),
    getCourt: fake('getCourt', { id: '12', facility: { id: '3' } }),
    reactivateFacility: fake('reactivateFacility', { facility, operation: { changed: true, changes: [] } }),
  };
  const booking = {
    deactivateFacility: fake('deactivateFacility', { facility, operation: { changed: true, changes: [] } }),
    getCourtBookingConfiguration: fake('getCourtBookingConfiguration', { courtId: '12' }),
    getWeeklySchedule: fake('getWeeklySchedule', { courtId: '12', periods: [] }),
    listDateExceptions: fake('listDateExceptions', { items: [], page: { nextCursor: null } }),
    listUnavailabilities: fake('listUnavailabilities', { items: [], page: { nextCursor: null } }),
    listOperationalConflicts: fake('listOperationalConflicts', { items: [], page: { nextCursor: null } }),
  };
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter({ facilities, booking, requireIdentity(req, _res, next) {
    if (!user) return next(appError('authentication_required', 'Authentication is required'));
    req.context = { user }; next();
  } }));
  app.use(createErrorHandler({ logger: { error() {} } }));
  return { app, calls };
}

describe('admin moderation HTTP contract', () => {
  it('permits global read-only inspection and facility moderation', async () => {
    const { app, calls } = fixture();
    for (const path of ['/facilities', '/facilities/3', '/facilities/3/courts', '/courts/12',
      '/courts/12/booking-configuration', '/courts/12/weekly-schedule',
      '/courts/12/date-exceptions', '/courts/12/unavailabilities', '/operational-conflicts']) {
      await request(app).get(`${BASE}${path}`).expect(200);
    }
    await request(app).post(`${BASE}/facilities/3/deactivation`).expect(200);
    await request(app).post(`${BASE}/facilities/3/reactivation`).expect(200);
    assert.equal(calls.includes('reactivateFacility'), true);
  });
  it('forbids all business writes before they reach use cases', async () => {
    const { app, calls } = fixture();
    const writes = [
      ['post', '/facilities'], ['patch', '/facilities/3'], ['put', '/facilities/3/booking-policy'],
      ['post', '/facilities/3/courts'], ['patch', '/courts/12'],
      ['put', '/courts/12/booking-configuration'], ['put', '/courts/12/weekly-schedule'],
      ['put', '/courts/12/date-exceptions/2026-09-28'],
      ['delete', '/courts/12/date-exceptions/2026-09-28'],
      ['post', '/courts/12/unavailabilities'], ['post', '/courts/12/deactivation'],
    ];
    for (const [method, path] of writes) {
      await request(app)[method](`${BASE}${path}`).expect(403)
        .expect(({ body }) => assert.equal(body.error.code, 'forbidden'));
    }
    assert.deepEqual(calls, []);
  });
  it('validates moderation requests and requires administrator identity', async () => {
    await request(fixture(null).app).post(`${BASE}/facilities/3/reactivation`).expect(401);
    await request(fixture({ id: '44', roles: ['PROPIETARIO'] }).app)
      .post(`${BASE}/facilities/3/reactivation`).expect(403);
    const { app, calls } = fixture();
    await request(app).post(`${BASE}/facilities/3/reactivation`).send({}).expect(400);
    await request(app).post(`${BASE}/facilities/0/reactivation`).expect(400);
    assert.deepEqual(calls, []);
  });
});
