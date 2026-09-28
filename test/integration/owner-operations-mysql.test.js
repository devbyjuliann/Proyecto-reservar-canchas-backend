import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { Temporal } from '@js-temporal/polyfill';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createBookingModule, createMySqlBookingAdapter } from '../../src/modules/booking/index.js';
import { createCourtPricingModule, createMySqlCourtPricingAdapter } from '../../src/modules/court-pricing/index.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from '../../src/modules/facilities/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from '../../src/modules/facility-memberships/index.js';
import { createMySqlUsersAdapter } from '../../src/modules/users/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const available = process.env.NODE_ENV === 'test'
  && required.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');
const ORIGIN = 'https://owner.example.test';
const BASE = '/api/v1/owner';
const body = { name: 'Cancha propia', description: 'Cubierta', sportCode: 'FUTBOL_5',
  minimumSeparationMinutes: 0, startIntervalMinutes: 30, allowedDurationsMinutes: [60] };
const cookies = (actor) => ({ Origin: ORIGIN, Cookie: `__Host-reserva_session=${actor}` });

describe('owner operations MySQL integration', { skip: !available, timeout: 30_000 }, () => {
  let pool;
  let fixture;
  let app;
  let booking;
  let memberships;
  let courtLockObserver;

  before(async () => {
    const migration = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(migration).up(); } finally { await migration.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
  });
  after(async () => { await pool?.end(); });

  beforeEach(async () => {
    fixture = await seed(pool);
    const clock = createSystemClock();
    courtLockObserver = createLockObserver();
    const observedPool = observedBookingPool(pool, courtLockObserver);
    booking = createBookingModule({ adapter: createMySqlBookingAdapter({ pool: observedPool }), clock });
    const facilities = createFacilitiesModule({ adapter: createMySqlFacilitiesAdapter({ pool }), clock });
    memberships = createFacilityMembershipsModule({
      adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock,
    });
    const pricing = createCourtPricingModule({
      adapter: createMySqlCourtPricingAdapter({ pool }), memberships,
    });
    const users = createMySqlUsersAdapter({ pool });
    app = createApp({ environment: 'production', frontendOrigin: ORIGIN,
      booking, facilities, memberships, pricing,
      auth: {
        async resolveSession(token) {
          const actor = fixture.actors[token];
          const user = actor ? await users.findById(actor.id) : null;
          return user ? { sessionId: token, user } : null;
        },
        async register() {}, async login() {}, async revokeSession() {},
      },
      findActiveUserById: async () => null,
      logger: { error() {} },
    });
  });
  afterEach(async () => {
    if (!fixture) return;
    await pool.execute('DELETE FROM idempotency_records WHERE user_id = ?', [fixture.actors.booker.id]);
    for (const courtId of fixture.courtIds) {
      await pool.execute(
        `DELETE FROM operational_conflicts WHERE booking_id IN
         (SELECT id FROM bookings WHERE court_id = ?)
         OR operational_change_id IN (SELECT id FROM operational_changes WHERE court_id = ?)`,
        [courtId, courtId],
      );
      await pool.execute('DELETE FROM bookings WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM court_unavailabilities WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM court_exception_periods WHERE exception_id IN (SELECT id FROM court_date_exceptions WHERE court_id = ?)', [courtId]);
      await pool.execute('DELETE FROM court_date_exceptions WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM court_weekly_periods WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM court_prices WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM court_allowed_durations WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM operational_changes WHERE court_id = ?', [courtId]);
      await pool.execute('DELETE FROM courts WHERE id = ?', [courtId]);
    }
    for (const facilityId of fixture.facilityIds) {
      await pool.execute('DELETE FROM facility_memberships WHERE facility_id = ?', [facilityId]);
      await pool.execute('DELETE FROM facilities WHERE id = ?', [facilityId]);
    }
    for (const actor of Object.values(fixture.actors)) {
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [actor.id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [actor.id]);
    }
    fixture = null;
  });

  async function createCourt(facilityId = fixture.facilityIds[0], identity = 'ownerA') {
    const result = await request(app).post(`${BASE}/facilities/${facilityId}/courts`)
      .set(cookies(identity)).send(body).expect(201);
    const courtId = result.body.court.id;
    fixture.courtIds.push(courtId);
    return courtId;
  }

  it('scopes Canchas and operations to active memberships, including shared ownership', async () => {
    const [ownFacility, foreignFacility] = fixture.facilityIds;
    await request(app).post(`${BASE}/facilities/${foreignFacility}/courts`)
      .set(cookies('ownerA')).send(body).expect(404);
    await request(app).post(`${BASE}/facilities/${ownFacility}/courts`)
      .set(cookies('ownerB')).send(body).expect(404);
    const courtId = await createCourt();
    assert.equal((await request(app).get(`${BASE}/facilities/${ownFacility}/courts`)
      .set(cookies('ownerA')).expect(200)).body.items[0].id, courtId);
    await request(app).get(`${BASE}/facilities/${ownFacility}/courts`)
      .set(cookies('ownerC')).expect(200);
    await request(app).get(`${BASE}/courts/${courtId}`).set(cookies('ownerB')).expect(404);
    await request(app).get(`${BASE}/courts/${courtId}`).set(cookies('admin')).expect(403);
    await request(app).get(`${BASE}/courts/${courtId}`).set(cookies('normal')).expect(403);
    await request(app).patch(`${BASE}/courts/${courtId}`).set(cookies('ownerB'))
      .send({ name: 'Intrusión' }).expect(404);
    const edited = await request(app).patch(`${BASE}/courts/${courtId}`).set(cookies('ownerA'))
      .send({ name: 'Cancha Norte', sportCode: 'FUTBOL_5' }).expect(200);
    assert.equal(edited.body.court.name, 'Cancha Norte');
    await request(app).put(`${BASE}/courts/${courtId}/booking-configuration`)
      .set(cookies('ownerA'))
      .send({ courtId, minimumSeparationMinutes: 10, startIntervalMinutes: 30,
        allowedDurationsMinutes: [60, 90] }).expect(200);
    const config = await request(app).get(`${BASE}/courts/${courtId}/booking-configuration`)
      .set(cookies('ownerC')).expect(200);
    assert.deepEqual(config.body.allowedDurationsMinutes, [60, 90]);
    await request(app).get(`${BASE}/courts/${courtId}/booking-configuration`)
      .set(cookies('ownerB')).expect(404);
    await request(app).put(`${BASE}/courts/${courtId}/prices/60`)
      .set(cookies('ownerA')).send({ priceMinor: 9000000, currency: 'COP' }).expect(200);
    await request(app).get(`${BASE}/courts/${courtId}/prices`)
      .set(cookies('ownerC')).expect(200);
    await request(app).put(`${BASE}/courts/${courtId}/prices/60`)
      .set(cookies('ownerB')).send({ priceMinor: 10000000, currency: 'COP' }).expect(404);

    const [membership] = await pool.execute(
      'SELECT id FROM facility_memberships WHERE facility_id = ? AND user_id = ? AND active = 1',
      [ownFacility, fixture.actors.ownerA.id],
    );
    await memberships.revokeMembership({ actor: fixture.actors.admin,
      facilityId: ownFacility, membershipId: String(membership[0].id) });
    await request(app).get(`${BASE}/courts/${courtId}`).set(cookies('ownerA')).expect(404);
    await request(app).put(`${BASE}/courts/${courtId}/prices/60`).set(cookies('ownerA'))
      .send({ priceMinor: 9500000, currency: 'COP' }).expect(404);
    await request(app).put(`${BASE}/courts/${courtId}/prices/60`).set(cookies('ownerC'))
      .send({ priceMinor: 9500000, currency: 'COP' }).expect(200);
    await request(app).get(`/api/v1/admin/courts/${courtId}/booking-configuration`)
      .set(cookies('admin')).expect(200);
  });

  it('reuses temporal rules, court locks, operational changes and conflicts for owner actions', async () => {
    const courtId = await createCourt();
    const date = Temporal.Now.instant().toZonedDateTimeISO('America/Bogota')
      .toPlainDate().add({ days: 3 });
    const periods = [{ weekday: date.dayOfWeek, startTime: '10:00:00', endTime: '18:00:00' }];
    await request(app).put(`${BASE}/courts/${courtId}/weekly-schedule`)
      .set(cookies('ownerA')).send({ periods }).expect(200);
    await request(app).put(`${BASE}/courts/${courtId}/prices/60`).set(cookies('ownerA'))
      .send({ priceMinor: 9000000, currency: 'COP' }).expect(200);
    const confirmed = await booking.confirmBooking({ actor: fixture.actors.booker,
      request: { courtId, localDate: date.toString(), startTime: '12:00:00',
        durationMinutes: 60, expectedPriceMinor: 9000000, currency: 'COP' },
      idempotencyKey: 'owner-conflict-fixture',
    });
    const changed = await request(app).put(`${BASE}/courts/${courtId}/weekly-schedule`)
      .set(cookies('ownerA')).send({ periods: [] }).expect(200);
    assert.equal(changed.body.operation.changes[0].conflictsCreated, 1);
    const [conflicts] = await pool.execute(
      `SELECT cf.id FROM operational_conflicts cf
       JOIN operational_changes ch ON ch.id = cf.operational_change_id
       WHERE ch.court_id = ? AND cf.booking_id = ?`, [courtId, confirmed.booking.id],
    );
    assert.equal(conflicts.length, 1);
    const [bookings] = await pool.execute('SELECT status FROM bookings WHERE id = ?', [confirmed.booking.id]);
    assert.equal(bookings[0].status, 'CONFIRMADA');
    await request(app).get(`${BASE}/courts/${courtId}/weekly-schedule`)
      .set(cookies('ownerC')).expect(200).expect(({ body: response }) => {
        assert.deepEqual(response.weeklySchedule.periods, []);
      });

    const held = await pool.getConnection();
    let released = false;
    try {
      await held.beginTransaction();
      await held.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [courtId]);
      courtLockObserver.reset();
      const first = request(app).put(`${BASE}/courts/${courtId}/weekly-schedule`)
        .set(cookies('ownerA')).send({ periods }).then((response) => {
          courtLockObserver.settled += 1;
          return response;
        });
      const second = request(app).put(`${BASE}/courts/${courtId}/weekly-schedule`)
        .set(cookies('ownerC')).send({ periods: [{ weekday: date.dayOfWeek,
          startTime: '14:00:00', endTime: '18:00:00' }] }).then((response) => {
          courtLockObserver.settled += 1;
          return response;
        });
      await courtLockObserver.waitFor(2);
      assert.equal(courtLockObserver.settled, 0);
      await held.commit();
      held.release();
      released = true;
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map((response) => response.status), [200, 200]);
    } finally {
      if (!released) { await held.rollback(); held.release(); }
    }
    const [changes] = await pool.execute(
      "SELECT id FROM operational_changes WHERE court_id = ? AND change_type = 'WEEKLY_SCHEDULE_REPLACED'",
      [courtId],
    );
    assert.equal(changes.length >= 2, true);

    const exception = await request(app).put(`${BASE}/courts/${courtId}/date-exceptions/${date}`)
      .set(cookies('ownerC')).send({ mode: 'CLOSED', periods: [] }).expect(200);
    assert.equal(exception.body.dateException.mode, 'CLOSED');
    await request(app).get(`${BASE}/courts/${courtId}/date-exceptions/${date}`)
      .set(cookies('ownerA')).expect(200);
    await request(app).put(`${BASE}/courts/${courtId}/date-exceptions/${date}`)
      .set(cookies('ownerA')).send({ mode: 'CUSTOM_PERIODS', periods: [{
        startTime: '09:00:00', endTime: '15:00:00',
      }] }).expect(200);
    const start = Temporal.Now.instant().add({ hours: 48 }).toString();
    const end = Temporal.Instant.from(start).add({ hours: 1 }).toString();
    const block = await request(app).post(`${BASE}/courts/${courtId}/unavailabilities`)
      .set(cookies('ownerA')).send({ type: 'BLOQUEO_ADMINISTRATIVO',
        startAt: start, endAt: end, reason: 'Mantenimiento' }).expect(201);
    await request(app).get(`${BASE}/unavailabilities/${block.body.unavailability.id}`)
      .set(cookies('ownerB')).expect(404);
    await request(app).get(`${BASE}/courts/${courtId}/unavailabilities`)
      .set(cookies('ownerC')).expect(200);
    const secondStart = Temporal.Now.instant().add({ hours: 72 }).toString();
    const secondEnd = Temporal.Instant.from(secondStart).add({ hours: 1 }).toString();
    await request(app).post(`${BASE}/courts/${courtId}/unavailabilities`)
      .set(cookies('ownerC')).send({ type: 'FUERA_DE_SERVICIO',
        startAt: secondStart, endAt: secondEnd, reason: 'Reparación' }).expect(201);
    await request(app).delete(`${BASE}/courts/${courtId}/date-exceptions/${date}`)
      .set(cookies('ownerA')).expect(200);
  });

  it('rejects an owner mutation if membership is revoked while waiting on the court lock', async () => {
    const courtId = await createCourt();
    const date = Temporal.Now.instant().toZonedDateTimeISO('America/Bogota')
      .toPlainDate().add({ days: 3 });
    const held = await pool.getConnection();
    let released = false;
    try {
      await held.beginTransaction();
      await held.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [courtId]);
      courtLockObserver.reset();
      const pending = request(app).put(`${BASE}/courts/${courtId}/weekly-schedule`)
        .set(cookies('ownerA')).send({ periods: [{ weekday: date.dayOfWeek,
          startTime: '10:00:00', endTime: '18:00:00' }] }).then((response) => {
          courtLockObserver.settled += 1;
          return response;
        });
      await courtLockObserver.waitFor(1);
      assert.equal(courtLockObserver.settled, 0);
      const [rows] = await pool.execute(
        'SELECT id FROM facility_memberships WHERE facility_id = ? AND user_id = ? AND active = 1',
        [fixture.facilityIds[0], fixture.actors.ownerA.id],
      );
      await memberships.revokeMembership({ actor: fixture.actors.admin,
        facilityId: fixture.facilityIds[0], membershipId: String(rows[0].id) });
      await held.commit();
      held.release();
      released = true;
      assert.equal((await pending).status, 404);
    } finally {
      if (!released) { await held.rollback(); held.release(); }
    }
    const [changes] = await pool.execute(
      "SELECT id FROM operational_changes WHERE court_id = ? AND change_type = 'WEEKLY_SCHEDULE_REPLACED'",
      [courtId],
    );
    assert.equal(changes.length, 0);
  });

  it('creates an owner facility with membership atomically and limits descriptive and policy edits', async () => {
    const created = await request(app).post(`${BASE}/facilities`).set(cookies('ownerA'))
      .send({ name: `Owner ${randomUUID()}`, timeZone: 'America/Bogota', city: 'Bogotá' })
      .expect(201);
    const facilityId = created.body.facility.id;
    fixture.facilityIds.push(facilityId);
    assert.equal(created.body.membership.userId, fixture.actors.ownerA.id);
    assert.equal(created.body.facility.publicationState, 'DRAFT');
    await request(app).patch(`${BASE}/facilities/${facilityId}`).set(cookies('ownerB'))
      .send({ name: 'Ajena' }).expect(404);
    await request(app).patch(`${BASE}/facilities/${facilityId}`).set(cookies('ownerA'))
      .send({ address: 'Calle 1', description: 'Cubierta' }).expect(200);
    await request(app).put(`${BASE}/facilities/${facilityId}/booking-policy`)
      .set(cookies('ownerA'))
      .send({ timeZone: 'America/Bogota', minimumAdvanceMinutes: 30,
        maximumAdvanceMinutes: 43200 }).expect(200);
    const deactivated = await request(app).post(`${BASE}/facilities/${facilityId}/deactivation`)
      .set(cookies('ownerA')).expect(200);
    assert.equal(deactivated.body.facility.state, 'inactive');
  });
});

async function seed(pool) {
  const actors = {};
  for (const [identity, roles] of Object.entries({
    admin: ['USUARIO', 'ADMINISTRADOR'],
    ownerA: ['USUARIO', 'PROPIETARIO'],
    ownerB: ['USUARIO', 'PROPIETARIO'],
    ownerC: ['USUARIO', 'PROPIETARIO'],
    normal: ['USUARIO'], booker: ['USUARIO'],
  })) {
    const [result] = await pool.execute('INSERT INTO users (name, email) VALUES (?, ?)',
      [identity, `${randomUUID()}@owner-operations.test`]);
    actors[identity] = { id: String(result.insertId), roles };
    for (const role of roles) {
      await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)',
        [actors[identity].id, role]);
    }
  }
  const facilityIds = [];
  for (const name of ['Own Facility', 'Foreign Facility']) {
    const [result] = await pool.execute(
      `INSERT INTO facilities (name, timezone, minimum_advance_minutes, maximum_advance_minutes)
       VALUES (?, 'America/Bogota', 0, 43200)`, [`${name} ${randomUUID()}`],
    );
    facilityIds.push(String(result.insertId));
  }
  for (const [facilityId, userId] of [
    [facilityIds[0], actors.ownerA.id],
    [facilityIds[0], actors.ownerC.id],
    [facilityIds[1], actors.ownerB.id],
  ]) {
    await pool.execute(
      `INSERT INTO facility_memberships
       (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
       VALUES (?, ?, 'PROPIETARIO', 1, UTC_TIMESTAMP(6), ?)`,
      [facilityId, userId, actors.admin.id],
    );
  }
  return { actors, facilityIds, courtIds: [] };
}

function observedBookingPool(pool, observer) {
  return {
    execute: (...args) => pool.execute(...args),
    async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'execute') return (sql, values) => {
            const result = target.execute(sql, values);
            if (String(sql).replace(/\s+/g, ' ').trim() === 'SELECT id FROM courts WHERE id = ? FOR UPDATE') {
              observer.record();
            }
            return result;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

function createLockObserver() {
  let attempts = 0;
  let waiting;
  return {
    settled: 0,
    record() {
      attempts += 1;
      if (waiting && attempts >= waiting.count) {
        clearTimeout(waiting.timer);
        waiting.resolve();
        waiting = null;
      }
    },
    reset() { attempts = 0; this.settled = 0; },
    waitFor(count) {
      if (attempts >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new Error('Court lock not observed'));
        }, 5000);
        waiting = { count, resolve, timer };
      });
    },
  };
}
