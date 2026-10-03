import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createAuthModule, createMySqlAuthAdapter } from '../../src/modules/auth/index.js';
import { createBookingModule, createMySqlBookingAdapter } from '../../src/modules/booking/index.js';
import { createFacilitiesModule, createMySqlFacilitiesAdapter } from '../../src/modules/facilities/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from '../../src/modules/facility-memberships/index.js';
import { createMySqlUsersAdapter } from '../../src/modules/users/index.js';

const available = process.env.NODE_ENV === 'test'
  && ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
    .every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');
const NOW = '2026-09-27T12:00:00.000000Z';
const ORIGIN = 'https://owner-bookings.example.test';
const BASE = '/api/v1/owner/bookings';
const PRICE = 9000000;

describe('owner bookings with MySQL and real sessions', { skip: !available, timeout: 60_000 }, () => {
  let pool;
  let app;
  const fixture = { users: [], facilities: [], courts: [], bookings: [], memberships: [] };
  const ids = {};
  const cookie = {};
  const get = (who, query = '') => request(app).get(`${BASE}${query}`).set('Cookie', cookie[who]);

  before(async () => {
    const migration = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(migration).up(); } finally { await migration.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
    const clock = { now: () => NOW };
    const auth = createAuthModule({ adapter: createMySqlAuthAdapter({ pool }), clock });
    for (const name of ['ownerA', 'ownerB', 'shared', 'normal', 'admin', 'customer']) {
      const email = `${randomUUID()}@owner-bookings.test`;
      const user = await auth.register({ name, email, password: 'Owner-Bookings-Test-2026!' });
      ids[name] = user.id;
      fixture.users.push(user.id);
      if (name.startsWith('owner') || name === 'shared') {
        await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'PROPIETARIO')", [user.id]);
      }
      if (name === 'admin') {
        await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'ADMINISTRADOR')", [user.id]);
      }
      const session = await auth.login({ email, password: 'Owner-Bookings-Test-2026!' });
      cookie[name] = `__Host-reserva_session=${session.token}`;
    }
    for (const name of ['A', 'B']) {
      const [facility] = await pool.execute(
        "INSERT INTO facilities (name, timezone) VALUES (?, 'America/Bogota')",
        [`Owner bookings ${name} ${randomUUID()}`],
      );
      ids[`facility${name}`] = String(facility.insertId);
      fixture.facilities.push(ids[`facility${name}`]);
      const [court] = await pool.execute(
        `INSERT INTO courts (facility_id, name, minimum_separation_minutes, start_interval_minutes)
         VALUES (?, ?, 0, 30)`, [facility.insertId, `Cancha ${name}`],
      );
      ids[`court${name}`] = String(court.insertId);
      fixture.courts.push(ids[`court${name}`]);
    }
    for (const [facilityId, userId] of [
      [ids.facilityA, ids.ownerA], [ids.facilityA, ids.shared], [ids.facilityB, ids.ownerB],
    ]) {
      const [result] = await pool.execute(
        `INSERT INTO facility_memberships
         (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
         VALUES (?, ?, 'PROPIETARIO', 1, ?, ?)`, [facilityId, userId, '2026-09-27 11:00:00', ids.admin],
      );
      fixture.memberships.push(String(result.insertId));
    }
    for (const [courtId, start, status, price] of [
      [ids.courtA, '2026-09-28 12:00:00', 'CONFIRMADA', PRICE],
      [ids.courtA, '2026-09-27 10:00:00', 'CONFIRMADA', null],
      [ids.courtA, '2026-09-29 12:00:00', 'CANCELADA', PRICE],
      [ids.courtA, '2026-09-30 12:00:00', 'CONFIRMADA', PRICE],
      [ids.courtB, '2026-09-28 12:00:00', 'CONFIRMADA', PRICE],
    ]) {
      const end = start.replace(':00:00', ':00:00');
      const [result] = await pool.execute(
        `INSERT INTO bookings (user_id, court_id, start_at, end_at, booking_timezone,
          status, created_at, cancelled_at, cancelled_by_user_id, price_amount_minor, price_currency)
         VALUES (?, ?, ?, DATE_ADD(?, INTERVAL 60 MINUTE), 'America/Bogota', ?,
           '2026-09-26 12:00:00', ?, ?, ?, ?)`,
        [ids.customer, courtId, start, end, status,
          status === 'CANCELADA' ? '2026-09-27 09:00:00' : null,
          status === 'CANCELADA' ? ids.customer : null, price, price === null ? null : 'COP'],
      );
      fixture.bookings.push(String(result.insertId));
    }
    await pool.execute(
      `UPDATE bookings SET payment_status = 'PAGADO', deposit_percentage_snapshot = 30,
       deposit_amount_minor = 2700000, amount_paid_minor = 2700000, voluntary_reschedule_count = 1
       WHERE id = ?`, [fixture.bookings[0]],
    );
    const users = createMySqlUsersAdapter({ pool });
    const booking = createBookingModule({ adapter: createMySqlBookingAdapter({ pool }), clock });
    const facilities = createFacilitiesModule({ adapter: createMySqlFacilitiesAdapter({ pool }), clock });
    const memberships = createFacilityMembershipsModule({
      adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock,
    });
    app = createApp({ environment: 'production', frontendOrigin: ORIGIN,
      booking, facilities, memberships, auth,
      findActiveUserById: (id) => users.findById(id), logger: { error() {} } });
  });

  after(async () => {
    if (!pool) return;
    try {
      for (const id of fixture.bookings) {
        await pool.execute('DELETE FROM booking_changes WHERE booking_id = ?', [id]);
        await pool.execute('DELETE FROM bookings WHERE id = ?', [id]);
      }
      for (const id of fixture.memberships) {
        await pool.execute('DELETE FROM facility_memberships WHERE id = ?', [id]);
      }
      for (const id of fixture.courts) await pool.execute('DELETE FROM courts WHERE id = ?', [id]);
      for (const id of fixture.facilities) await pool.execute('DELETE FROM facilities WHERE id = ?', [id]);
      for (const id of fixture.users) {
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM user_credentials WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
        await pool.execute('DELETE FROM users WHERE id = ?', [id]);
      }
    } finally { await pool.end(); }
  });

  it('lists only business bookings with effective and persisted status and immutable price snapshots', async () => {
    const a = await get('ownerA').expect(200);
    assert.equal(a.body.items.length, 4);
    assert(a.body.items.every((item) => item.court.id === ids.courtA));
    assert(a.body.items.every((item) => item.user.name === 'customer' && !('email' in item.user)));
    assert(a.body.items.every((item) => item.durationMinutes === 60));
    const completed = a.body.items.find((item) => item.status === 'COMPLETADA');
    assert.equal(completed.persistedStatus, 'CONFIRMADA');
    assert.equal(completed.priceMinor, null);
    assert.equal(completed.currency, null);
    assert.equal(a.body.items.find((item) => item.status === 'CANCELADA').persistedStatus, 'CANCELADA');
    assert.equal(a.body.items.find((item) => item.priceMinor === PRICE).currency, 'COP');
    const paid = a.body.items.find((item) => item.id === fixture.bookings[0]);
    assert.deepEqual({ paymentStatus: paid.paymentStatus, depositPercentage: paid.depositPercentage,
      depositAmountMinor: paid.depositAmountMinor, amountPaidMinor: paid.amountPaidMinor,
      paymentExpiresAt: paid.paymentExpiresAt, voluntaryRescheduleCount: paid.voluntaryRescheduleCount },
    { paymentStatus: 'PAGADO', depositPercentage: 30, depositAmountMinor: 2700000,
      amountPaidMinor: 2700000, paymentExpiresAt: null, voluntaryRescheduleCount: 1 });
    const shared = await get('shared').expect(200);
    assert.deepEqual(shared.body.items.map((item) => item.id), a.body.items.map((item) => item.id));
    const b = await get('ownerB').expect(200);
    assert.equal(b.body.items.length, 1);
    assert.equal(b.body.items[0].court.id, ids.courtB);
  });

  it('filters facility, court, effective status and UTC half-open start range without revealing foreign IDs', async () => {
    for (const filter of [`facilityId=${ids.facilityA}`, `courtId=${ids.courtA}`]) {
      assert.equal((await get('ownerA', `?${filter}`).expect(200)).body.items.length, 4);
    }
    for (const status of ['CONFIRMADA', 'CANCELADA', 'COMPLETADA']) {
      const result = await get('ownerA', `?status=${status}`).expect(200);
      assert.equal(result.body.items.length, status === 'CONFIRMADA' ? 2 : 1);
      assert(result.body.items.every((item) => item.status === status));
    }
    const range = await get('ownerA', '?startFrom=2026-09-28T12:00:00Z&startBefore=2026-09-30T12:00:00Z').expect(200);
    assert.equal(range.body.items.length, 2);
    for (const filter of [`facilityId=${ids.facilityB}`, `courtId=${ids.courtB}`,
      `facilityId=${ids.facilityA}&courtId=${ids.courtB}`]) {
      await get('ownerA', `?${filter}`).expect(404);
    }
    await get('ownerA', '?courtId=18446744073709551615').expect(404);
  });

  it('binds cursor to actor, filters and order and rejects malformed queries', async () => {
    const first = await get('ownerA', `?facilityId=${ids.facilityA}&limit=2`).expect(200);
    const cursor = first.body.page.nextCursor;
    assert(cursor);
    const second = await get('ownerA', `?facilityId=${ids.facilityA}&limit=2&cursor=${cursor}`).expect(200);
    assert.equal(second.body.items.length, 2);
    assert.equal(second.body.page.nextCursor, null);
    assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.id)).size, 4);
    await get('ownerA', `?courtId=${ids.courtA}&cursor=${cursor}`).expect(400);
    await get('shared', `?facilityId=${ids.facilityA}&cursor=${cursor}`).expect(400);
    for (const query of ['?status=INVALID', '?limit=101', '?startFrom=tomorrow',
      '?startFrom=2026-09-30T12:00:00Z&startBefore=2026-09-28T12:00:00Z', '?unknown=1']) {
      await get('ownerA', query).expect(400);
    }
  });

  it('requires a valid session and owner role; admin retains its global API', async () => {
    await request(app).get(BASE).expect(401);
    await get('normal').expect(403);
    await get('admin').expect(403);
    await request(app).get('/api/v1/admin/facilities').set('Cookie', cookie.admin).expect(200);
  });

  it('revoking membership immediately removes previously visible bookings', async () => {
    await get('ownerA').expect(200);
    await pool.execute('UPDATE facility_memberships SET active = 0, deactivated_at = ? WHERE id = ?',
      ['2026-09-27 12:00:00', fixture.memberships[0]]);
    assert.deepEqual((await get('ownerA').expect(200)).body.items, []);
    await get('ownerA', `?facilityId=${ids.facilityA}`).expect(404);
    await get('ownerA', `?courtId=${ids.courtA}`).expect(404);
    assert.equal((await get('shared').expect(200)).body.items.length, 4);
  });
});
