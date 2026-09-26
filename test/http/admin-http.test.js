import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import express from 'express';
import request from 'supertest';

import { createErrorHandler } from '../../src/app/error-handler.js';
import { createAdminRouter } from '../../src/modules/admin/index.js';
import { appError } from '../../src/shared/errors.js';

const ADMIN = Object.freeze({ id: '7', roles: ['ADMINISTRADOR'] });
const FACILITY = Object.freeze({ id: '3', name: 'Centro Deportivo', state: 'active' });
const COURT = Object.freeze({ id: '12', name: 'Cancha 1', state: 'active' });
const OPERATION = Object.freeze({ changed: true, changes: [] });
const BOOKING_CONFIGURATION = Object.freeze({
  courtId: '12',
  minimumSeparationMinutes: 10,
  startIntervalMinutes: 30,
  allowedDurationsMinutes: [30, 60, 90],
});
const WEEKLY_SCHEDULE = Object.freeze({
  courtId: '12',
  periods: [{ weekday: 1, startTime: '08:00:00', endTime: '12:00:00' }],
});
const DATE_EXCEPTION = Object.freeze({
  courtId: '12',
  localDate: '2026-09-28',
  mode: 'CLOSED',
  periods: [],
});
const UNAVAILABILITY = Object.freeze({
  id: '81',
  courtId: '12',
  type: 'BLOQUEO_ADMINISTRATIVO',
  startAt: '2026-09-28T21:00:00.000000Z',
  endAt: '2026-09-29T02:00:00.000000Z',
  reason: null,
});
const CONFLICT = Object.freeze({ id: '701', detectedAt: '2026-09-24T15:00:00.000000Z' });

function createFixture({ user = ADMIN } = {}) {
  const calls = [];
  const fake = (name, result) => async (input) => {
    calls.push({ name, input });
    return result;
  };
  const facilities = {
    listFacilities: fake('listFacilities', { items: [FACILITY], page: { nextCursor: null } }),
    createFacility: fake('createFacility', { facility: FACILITY, operation: OPERATION }),
    getFacility: fake('getFacility', FACILITY),
    updateFacility: fake('updateFacility', { facility: FACILITY, operation: OPERATION }),
    listCourts: fake('listCourts', { items: [COURT], page: { nextCursor: null } }),
    getCourt: fake('getCourt', COURT),
    updateCourt: fake('updateCourt', { court: COURT, operation: OPERATION }),
  };
  const booking = {
    replaceFacilityBookingPolicy: fake(
      'replaceFacilityBookingPolicy',
      { facility: FACILITY, operation: OPERATION },
    ),
    deactivateFacility: fake('deactivateFacility', { facility: FACILITY, operation: OPERATION }),
    createCourt: fake('createCourt', { court: COURT, operation: OPERATION }),
    getCourtBookingConfiguration: fake(
      'getCourtBookingConfiguration',
      BOOKING_CONFIGURATION,
    ),
    replaceCourtBookingConfiguration: fake(
      'replaceCourtBookingConfiguration',
      { bookingConfiguration: BOOKING_CONFIGURATION, operation: OPERATION },
    ),
    getWeeklySchedule: fake('getWeeklySchedule', WEEKLY_SCHEDULE),
    replaceWeeklySchedule: fake(
      'replaceWeeklySchedule',
      { weeklySchedule: WEEKLY_SCHEDULE, operation: OPERATION },
    ),
    listDateExceptions: fake(
      'listDateExceptions',
      { items: [DATE_EXCEPTION], page: { nextCursor: null } },
    ),
    getDateException: fake('getDateException', DATE_EXCEPTION),
    putDateException: fake(
      'putDateException',
      { dateException: DATE_EXCEPTION, operation: OPERATION },
    ),
    deleteDateException: fake(
      'deleteDateException',
      { dateException: null, operation: OPERATION },
    ),
    listUnavailabilities: fake(
      'listUnavailabilities',
      { items: [UNAVAILABILITY], page: { nextCursor: null } },
    ),
    createUnavailability: fake(
      'createUnavailability',
      { unavailability: UNAVAILABILITY, operation: OPERATION },
    ),
    getUnavailability: fake('getUnavailability', UNAVAILABILITY),
    deactivateCourt: fake('deactivateCourt', { court: COURT, operation: OPERATION }),
    listOperationalConflicts: fake(
      'listOperationalConflicts',
      { items: [CONFLICT], page: { nextCursor: null } },
    ),
    getOperationalConflict: fake('getOperationalConflict', CONFLICT),
  };
  const requireIdentity = (incoming, _response, next) => {
    if (!user) {
      next(appError('authentication_required', 'Authentication is required'));
      return;
    }
    incoming.context = Object.freeze({ user });
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter({ facilities, booking, requireIdentity }));
  app.use(createErrorHandler({ logger: { error() {} } }));
  return { app, calls };
}

async function expectInvalid(testRequest) {
  await testRequest.expect(400).expect(({ body }) => {
    assert.equal(body.error.code, 'invalid_request');
  });
}

describe('admin HTTP contract', () => {
  it('serves every facility and court resource route with exact wrappers and locations', async () => {
    const { app, calls } = createFixture();

    await request(app).get('/api/v1/admin/facilities').expect(200).expect(({ body }) => {
      assert.deepEqual(body.page, { nextCursor: null });
    });
    await request(app).post('/api/v1/admin/facilities').send({
      name: 'Centro Deportivo',
      timeZone: 'America/Bogota',
    }).expect('Location', '/api/v1/admin/facilities/3').expect(201).expect(({ body }) => {
      assert.equal(body.facility.id, '3');
      assert.deepEqual(body.operation, OPERATION);
    });
    await request(app).get('/api/v1/admin/facilities/3').expect(200, { facility: FACILITY });
    await request(app).patch('/api/v1/admin/facilities/3')
      .send({ name: 'Centro Norte' }).expect(200);
    await request(app).put('/api/v1/admin/facilities/3/booking-policy').send({
      timeZone: 'America/Bogota',
      minimumAdvanceMinutes: 30,
      maximumAdvanceMinutes: 20_160,
    }).expect(200);
    await request(app).post('/api/v1/admin/facilities/3/deactivation').expect(200);
    await request(app).get('/api/v1/admin/facilities/3/courts').expect(200);
    await request(app).post('/api/v1/admin/facilities/3/courts').send({
      name: 'Cancha 1',
      description: null,
      minimumSeparationMinutes: 10,
      startIntervalMinutes: 30,
      allowedDurationsMinutes: [30, 60, 90],
    }).expect('Location', '/api/v1/admin/courts/12').expect(201);
    await request(app).get('/api/v1/admin/courts/12').expect(200, { court: COURT });
    await request(app).patch('/api/v1/admin/courts/12')
      .send({ name: 'Cancha Central', description: null }).expect(200);

    assert.deepEqual(calls.map(({ name }) => name), [
      'listFacilities',
      'createFacility',
      'getFacility',
      'updateFacility',
      'replaceFacilityBookingPolicy',
      'deactivateFacility',
      'listCourts',
      'createCourt',
      'getCourt',
      'updateCourt',
    ]);
    for (const call of calls) assert.equal(call.input.actor, ADMIN);
    assert.deepEqual(calls[0].input, {
      actor: ADMIN,
      state: 'active',
      limit: 25,
      cursor: undefined,
    });
    assert.equal(calls[1].input.minimumAdvanceMinutes, 15);
    assert.equal(calls[1].input.maximumAdvanceMinutes, 43_200);
  });

  it('serves all configuration, schedule, exception, and deactivation routes', async () => {
    const { app, calls } = createFixture();

    await request(app).get('/api/v1/admin/courts/12/booking-configuration')
      .expect(200, BOOKING_CONFIGURATION);
    await request(app).put('/api/v1/admin/courts/12/booking-configuration')
      .send(BOOKING_CONFIGURATION).expect(200);
    await request(app).get('/api/v1/admin/courts/12/weekly-schedule')
      .expect(200, { weeklySchedule: WEEKLY_SCHEDULE });
    await request(app).put('/api/v1/admin/courts/12/weekly-schedule').send({
      periods: WEEKLY_SCHEDULE.periods,
    }).expect(200);
    await request(app).get('/api/v1/admin/courts/12/date-exceptions').expect(200);
    await request(app).get('/api/v1/admin/courts/12/date-exceptions/2026-09-28')
      .expect(200, { dateException: DATE_EXCEPTION });
    await request(app).put('/api/v1/admin/courts/12/date-exceptions/2026-09-28').send({
      mode: 'CLOSED',
      periods: [],
    }).expect(200);
    await request(app).delete('/api/v1/admin/courts/12/date-exceptions/2026-09-28')
      .expect(200).expect(({ body }) => assert.equal(body.dateException, null));
    await request(app).post('/api/v1/admin/courts/12/deactivation').expect(200);

    assert.deepEqual(calls.map(({ name }) => name), [
      'getCourtBookingConfiguration',
      'replaceCourtBookingConfiguration',
      'getWeeklySchedule',
      'replaceWeeklySchedule',
      'listDateExceptions',
      'getDateException',
      'putDateException',
      'deleteDateException',
      'deactivateCourt',
    ]);
    for (const call of calls) assert.equal(call.input.actor, ADMIN);
    assert.deepEqual(calls[4].input, {
      actor: ADMIN,
      courtId: '12',
      limit: 25,
      cursor: undefined,
    });
  });

  it('serves every unavailability and operational-conflict route', async () => {
    const { app, calls } = createFixture();

    await request(app).get('/api/v1/admin/courts/12/unavailabilities').expect(200);
    await request(app).post('/api/v1/admin/courts/12/unavailabilities').send({
      type: 'BLOQUEO_ADMINISTRATIVO',
      startAt: '2026-09-28T21:00:00.000000Z',
      endAt: '2026-09-29T02:00:00.000000Z',
      reason: null,
    }).expect('Location', '/api/v1/admin/unavailabilities/81').expect(201);
    await request(app).get('/api/v1/admin/unavailabilities/81')
      .expect(200, { unavailability: UNAVAILABILITY });
    await request(app).get(
      '/api/v1/admin/operational-conflicts?courtId=12&bookingId=901&operationalChangeId=501&limit=10&cursor=next',
    ).expect(200);
    await request(app).get('/api/v1/admin/operational-conflicts/701')
      .expect(200, CONFLICT);

    assert.deepEqual(calls.map(({ name }) => name), [
      'listUnavailabilities',
      'createUnavailability',
      'getUnavailability',
      'listOperationalConflicts',
      'getOperationalConflict',
    ]);
    for (const call of calls) assert.equal(call.input.actor, ADMIN);
    assert.deepEqual(calls[3].input, {
      actor: ADMIN,
      courtId: '12',
      bookingId: '901',
      operationalChangeId: '501',
      limit: 10,
      cursor: 'next',
    });
  });

  it('requires an active identity and the persisted administrator role', async () => {
    const missing = createFixture({ user: null });
    await request(missing.app).get('/api/v1/admin/facilities').expect(401).expect(({ body }) => {
      assert.equal(body.error.code, 'authentication_required');
    });
    assert.equal(missing.calls.length, 0);

    const unauthorized = createFixture({ user: { id: '44', roles: ['USUARIO'] } });
    await request(unauthorized.app).get('/api/v1/admin/facilities').expect(403).expect(({ body }) => {
      assert.equal(body.error.code, 'forbidden');
    });
    assert.equal(unauthorized.calls.length, 0);
  });

  it('rejects unknown fields and queries, malformed IDs, and invalid pagination', async () => {
    const { app, calls } = createFixture();
    await expectInvalid(request(app).get('/api/v1/admin/facilities?unexpected=true'));
    await expectInvalid(request(app).get('/api/v1/admin/facilities/3?state=active'));
    await expectInvalid(request(app).get('/api/v1/admin/courts/0'));
    await expectInvalid(request(app).get('/api/v1/admin/courts/18446744073709551616'));
    await expectInvalid(request(app).get('/api/v1/admin/facilities?limit=101'));
    await expectInvalid(request(app).post('/api/v1/admin/facilities').send({
      name: 'Centro',
      timeZone: 'America/Bogota',
      actorUserId: '7',
    }));
    await expectInvalid(request(app).patch('/api/v1/admin/courts/12').send({}));
    assert.equal(calls.length, 0);
  });

  it('validates exact dates, times, instants, types, and path/body identity', async () => {
    const { app, calls } = createFixture();
    await expectInvalid(
      request(app).get('/api/v1/admin/courts/12/date-exceptions/2026-02-30'),
    );
    await expectInvalid(request(app).put('/api/v1/admin/courts/12/weekly-schedule').send({
      periods: [{ weekday: 1, startTime: '8:00', endTime: '12:00:00' }],
    }));
    await expectInvalid(request(app).post('/api/v1/admin/courts/12/unavailabilities').send({
      type: 'OTRO',
      startAt: '2026-09-28T21:00:00-05:00',
      endAt: '2026-09-29T02:00:00.000000Z',
    }));
    await expectInvalid(
      request(app).put('/api/v1/admin/courts/12/booking-configuration')
        .send({ ...BOOKING_CONFIGURATION, courtId: '13' }),
    );
    await expectInvalid(request(app).post('/api/v1/admin/facilities').send({
      name: 'Centro',
      timeZone: 'Not/AZone',
    }));
    assert.equal(calls.length, 0);
  });

  it('forbids bodies on bodyless operations and rejects Idempotency-Key', async () => {
    const { app, calls } = createFixture();
    await expectInvalid(
      request(app).post('/api/v1/admin/facilities/3/deactivation').send({}),
    );
    await expectInvalid(
      request(app).post('/api/v1/admin/courts/12/deactivation').send({ reason: 'x' }),
    );
    await expectInvalid(
      request(app).delete('/api/v1/admin/courts/12/date-exceptions/2026-09-28').send({}),
    );
    await expectInvalid(
      request(app).post('/api/v1/admin/facilities')
        .set('Idempotency-Key', 'not-supported')
        .send({ name: 'Centro', timeZone: 'America/Bogota' }),
    );
    assert.equal(calls.length, 0);
  });
});
