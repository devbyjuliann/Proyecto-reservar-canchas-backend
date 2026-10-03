import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { Temporal } from '@js-temporal/polyfill';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createBookingModule, createMySqlBookingAdapter } from '../../src/modules/booking/index.js';
import { createCourtPricingModule, createMySqlCourtPricingAdapter } from '../../src/modules/court-pricing/index.js';
import { createFacilityMembershipsModule, createMySqlFacilityMembershipsAdapter } from '../../src/modules/facility-memberships/index.js';
import { createPublicCatalogModule, createMySqlPublicCatalogAdapter } from '../../src/modules/public-catalog/index.js';
import { createSystemClock } from '../../src/shared/clock.js';
import { toMySqlDateTime } from '../../src/shared/time.js';

const names = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const available = process.env.NODE_ENV === 'test'
  && names.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');

describe('court pricing and booking snapshot MySQL', { skip: !available, timeout: 30_000 }, () => {
  let pool;
  let pricing;
  let catalog;
  let booking;
  let fixture;

  before(async () => {
    const connection = await createMigrationConnection(loadDatabaseConfig({ forMigrations: true }));
    try { await createMigrator(connection).up(); } finally { await connection.end(); }
    pool = createMySqlPool(loadDatabaseConfig());
    const clock = createSystemClock();
    const catalogAdapter = createMySqlPublicCatalogAdapter({ pool });
    const memberships = createFacilityMembershipsModule({
      adapter: createMySqlFacilityMembershipsAdapter({ pool }), clock,
    });
    pricing = createCourtPricingModule({
      adapter: createMySqlCourtPricingAdapter({ pool }), memberships,
    });
    catalog = createPublicCatalogModule({ adapter: catalogAdapter, clock });
    booking = createBookingModule({ adapter: createMySqlBookingAdapter({
      pool, isPublicCourt: catalogAdapter.isPublicCourt,
    }), clock });
  });
  after(async () => { await pool?.end(); });
  beforeEach(async () => { fixture = await seed(pool); });
  afterEach(async () => {
    if (!fixture) return;
    await pool.execute('DELETE FROM idempotency_records WHERE user_id = ?', [fixture.user.id]);
    await pool.execute(
      'DELETE FROM operational_conflicts WHERE operational_change_id IN (SELECT id FROM operational_changes WHERE court_id = ?)',
      [fixture.courtId],
    );
    await pool.execute('DELETE FROM operational_changes WHERE court_id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM booking_changes WHERE booking_id IN (SELECT id FROM bookings WHERE court_id = ?)', [fixture.courtId]);
    await pool.execute('DELETE FROM bookings WHERE court_id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM court_weekly_periods WHERE court_id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM court_prices WHERE court_id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM court_allowed_durations WHERE court_id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM courts WHERE id = ?', [fixture.courtId]);
    await pool.execute('DELETE FROM facility_memberships WHERE facility_id IN (?, ?)',
      [fixture.facilityId, fixture.otherFacilityId]);
    await pool.execute('DELETE FROM facilities WHERE id IN (?, ?)',
      [fixture.facilityId, fixture.otherFacilityId]);
    for (const actor of [fixture.admin, fixture.owner, fixture.otherOwner, fixture.user]) {
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [actor.id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [actor.id]);
    }
    fixture = null;
  });

  async function price(actor, scope, amount = 9000000) {
    return pricing.setPrice({ actor, scope, courtId: fixture.courtId,
      durationMinutes: 60, priceMinor: amount });
  }

  it('enforces valid COP prices and tenant permissions on the exact duration', async () => {
    await assert.rejects(pricing.setPrice({ actor: fixture.admin, scope: 'admin',
      courtId: fixture.courtId, durationMinutes: 90, priceMinor: 100 }),
    { code: 'invalid_operational_configuration' });
    await assert.rejects(price(fixture.otherOwner, 'owner'), { code: 'resource_not_found' });
    const set = await price(fixture.owner, 'owner');
    assert.equal(set.price.priceMinor, 9000000);
    assert.equal(set.price.currency, 'COP');
    assert.equal((await pricing.listPrices({ actor: fixture.owner, scope: 'owner',
      courtId: fixture.courtId })).items[0].priceMinor, 9000000);
    assert.equal((await price(fixture.admin, 'admin', 9200000)).operation.changed, true);
    assert.equal((await price(fixture.admin, 'admin', 9200000)).operation.changed, false);
    await assert.rejects(pool.execute(
      `INSERT INTO court_prices (court_id, duration_minutes, price_amount_minor, currency)
       VALUES (?, 60, 100, 'COP')`, [fixture.courtId],
    ), { code: 'ER_DUP_ENTRY' });
    await assert.rejects(pool.execute(
      `INSERT INTO court_prices (court_id, duration_minutes, price_amount_minor, currency)
       VALUES (?, 90, 100, 'COP')`, [fixture.courtId],
    ));
    await assert.rejects(pool.execute(
      `UPDATE court_prices SET price_amount_minor = 0 WHERE court_id = ?`, [fixture.courtId],
    ));
    await assert.rejects(pool.execute(
      `UPDATE court_prices SET currency = 'USD' WHERE court_id = ?`, [fixture.courtId],
    ));
    const [membership] = await pool.execute('SELECT id FROM facility_memberships WHERE facility_id = ?',
      [fixture.facilityId]);
    await membershipsRevoke(pool, membership[0].id);
    await assert.rejects(price(fixture.owner, 'owner'), { code: 'resource_not_found' });
    assert.equal((await price(fixture.admin, 'admin', 9300000)).price.priceMinor, 9300000);
    assert.equal((await pricing.removePrice({ actor: fixture.admin, scope: 'admin',
      courtId: fixture.courtId, durationMinutes: 60 })).operation.changed, true);
    assert.equal((await pricing.removePrice({ actor: fixture.admin, scope: 'admin',
      courtId: fixture.courtId, durationMinutes: 60 })).operation.changed, false);
  });

  it('publishes only with price and exposes COP amount in catalog and availability', async () => {
    await assert.rejects(catalog.publish({ actor: fixture.admin, facilityId: fixture.facilityId }),
      { code: 'facility_not_publishable' });
    assert.deepEqual((await catalog.listFacilities({ filters: emptyFilters(), limit: 25 })).items, []);
    await price(fixture.admin, 'admin');
    assert.equal((await catalog.publish({ actor: fixture.admin, facilityId: fixture.facilityId })).changed, true);
    const facilities = await catalog.listFacilities({ filters: emptyFilters(), limit: 25 });
    const item = facilities.items.find((entry) => entry.id === fixture.facilityId);
    assert.equal(item.fromPriceMinor, 9000000);
    assert.equal(item.currency, 'COP');
    const courts = await catalog.listCourts({ filters: emptyFilters({ minPriceMinor: 8000000,
      maxPriceMinor: 9500000 }), limit: 25 });
    assert.equal(courts.items.some((entry) => entry.id === fixture.courtId), true);
    assert.equal((await catalog.getCourt(fixture.courtId)).prices[0].priceMinor, 9000000);
    assert.equal((await booking.getAvailability({ courtId: fixture.courtId,
      date: fixture.date })).options.some((option) => option.priceMinor === 9000000), true);
    await pricing.removePrice({ actor: fixture.admin, scope: 'admin',
      courtId: fixture.courtId, durationMinutes: 60 });
    assert.equal(await catalog.isCourtVisible(fixture.courtId), false);
    await assert.rejects(catalog.getCourt(fixture.courtId), { code: 'resource_not_found' });
  });

  it('freezes booking price, replays it and rejects changed or missing prices', async () => {
    await price(fixture.admin, 'admin');
    await catalog.publish({ actor: fixture.admin, facilityId: fixture.facilityId });
    const request = { courtId: fixture.courtId, localDate: fixture.date,
      startTime: '12:00:00', durationMinutes: 60, expectedPriceMinor: 9000000, currency: 'COP' };
    const first = await booking.confirmBooking({ actor: fixture.user, request, idempotencyKey: 'price-first' });
    assert.equal(first.booking.priceMinor, 9000000);
    assert.equal(first.booking.currency, 'COP');
    const [stored] = await pool.execute(
      'SELECT price_amount_minor, price_currency FROM bookings WHERE id = ?', [first.booking.id],
    );
    assert.equal(Number(stored[0].price_amount_minor), 9000000);
    await price(fixture.admin, 'admin', 9500000);
    const replay = await booking.confirmBooking({ actor: fixture.user, request,
      idempotencyKey: 'price-first' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.booking.id, first.booking.id);
    assert.equal(replay.booking.priceMinor, 9000000);
    await assert.rejects(booking.confirmBooking({ actor: fixture.user,
      request: { ...request, expectedPriceMinor: 9500000 }, idempotencyKey: 'price-first' }),
    { code: 'invalid_idempotency_key_reuse' });

    const stale = { ...request, startTime: '14:00:00' };
    await assert.rejects(booking.confirmBooking({ actor: fixture.user, request: stale,
      idempotencyKey: 'price-stale' }), (error) => {
      assert.equal(error.code, 'booking_price_changed');
      assert.deepEqual(error.details, { currentPriceMinor: 9500000, currency: 'COP' });
      return true;
    });
    const [rejected] = await pool.execute(
      `SELECT outcome, result_price_amount_minor FROM idempotency_records
       WHERE user_id = ? AND idempotency_key = ?`,
      [fixture.user.id, Buffer.from('price-stale', 'ascii')],
    );
    assert.equal(rejected[0].outcome, 'REJECTED');
    assert.equal(Number(rejected[0].result_price_amount_minor), 9500000);
    await price(fixture.admin, 'admin', 9900000);
    await assert.rejects(booking.confirmBooking({ actor: fixture.user, request: stale,
      idempotencyKey: 'price-stale' }), (error) => {
      assert.deepEqual(error.details, { currentPriceMinor: 9500000, currency: 'COP' });
      return true;
    });
    await pricing.removePrice({ actor: fixture.admin, scope: 'admin',
      courtId: fixture.courtId, durationMinutes: 60 });
    await assert.rejects(booking.confirmBooking({ actor: fixture.user, request: stale,
      idempotencyKey: 'price-stale' }), (error) => {
      assert.equal(error.code, 'booking_price_changed');
      assert.deepEqual(error.details, { currentPriceMinor: 9500000, currency: 'COP' });
      return true;
    });
    await assert.rejects(booking.confirmBooking({ actor: fixture.user,
      request: { ...stale, expectedPriceMinor: 9900000, startTime: '16:00:00' },
      idempotencyKey: 'price-missing' }), (error) => {
      assert.equal(error.code, 'booking_price_changed');
      assert.equal(error.details.currentPriceMinor, null);
      return true;
    });
    const [bookings] = await pool.execute('SELECT id, price_amount_minor FROM bookings WHERE court_id = ?',
      [fixture.courtId]);
    assert.equal(bookings.length, 1);
    assert.equal(Number(bookings[0].price_amount_minor), 9000000);
    assert.equal((await booking.listOwnBookings({ actor: fixture.user, limit: 25 })).items[0].priceMinor, 9000000);
    const cancelled = await booking.cancelBooking({ actor: fixture.user, bookingId: first.booking.id });
    assert.equal(cancelled.booking.priceMinor, 9000000);
    assert.equal(cancelled.booking.status, 'CANCELADA');
  });

  it('retains NULL for historical bookings and permits listing and cancellation', async () => {
    const start = Temporal.Now.instant().add({ hours: 96 }).toString();
    const end = Temporal.Instant.from(start).add({ hours: 1 }).toString();
    const [insert] = await pool.execute(
      `INSERT INTO bookings
       (user_id, court_id, start_at, end_at, booking_timezone, status, created_at)
       VALUES (?, ?, ?, ?, 'America/Bogota', 'CONFIRMADA', UTC_TIMESTAMP(6))`,
      [fixture.user.id, fixture.courtId, toMySqlDateTime(start), toMySqlDateTime(end)],
    );
    const [stored] = await pool.execute('SELECT price_amount_minor, price_currency FROM bookings WHERE id = ?',
      [insert.insertId]);
    assert.equal(stored[0].price_amount_minor, null);
    assert.equal(stored[0].price_currency, null);
    const listed = await booking.listOwnBookings({ actor: fixture.user, limit: 25 });
    assert.equal(listed.items[0].priceMinor, null);
    assert.equal(listed.items[0].currency, null);
    const cancelled = await booking.cancelBooking({ actor: fixture.user, bookingId: String(insert.insertId) });
    assert.equal(cancelled.booking.status, 'CANCELADA');
    assert.equal(cancelled.booking.priceMinor, null);
  });

  it('rejects a partially populated booking price snapshot at the database boundary', async () => {
    const start = Temporal.Now.instant().add({ hours: 96 }).toString();
    const end = Temporal.Instant.from(start).add({ hours: 1 }).toString();
    await assert.rejects(pool.execute(
      `INSERT INTO bookings
       (user_id, court_id, start_at, end_at, booking_timezone, status, created_at,
        price_amount_minor, price_currency)
       VALUES (?, ?, ?, ?, 'America/Bogota', 'CONFIRMADA', UTC_TIMESTAMP(6), 9000000, NULL)`,
      [fixture.user.id, fixture.courtId, toMySqlDateTime(start), toMySqlDateTime(end)],
    ));
    await assert.rejects(pool.execute(
      `INSERT INTO bookings
       (user_id, court_id, start_at, end_at, booking_timezone, status, created_at,
        price_amount_minor, price_currency)
       VALUES (?, ?, ?, ?, 'America/Bogota', 'CONFIRMADA', UTC_TIMESTAMP(6), NULL, 'COP')`,
      [fixture.user.id, fixture.courtId, toMySqlDateTime(start), toMySqlDateTime(end)],
    ));
  });

  it('retains prices for surviving durations and removes them with discarded durations', async () => {
    await price(fixture.admin, 'admin');
    for (const durations of [[60, 90], [90]]) {
      await booking.replaceCourtBookingConfiguration({
        actor: fixture.admin, courtId: fixture.courtId,
        bookingConfiguration: { courtId: fixture.courtId, minimumSeparationMinutes: 0,
          startIntervalMinutes: 30, allowedDurationsMinutes: durations },
      });
      const [rows] = await pool.execute('SELECT duration_minutes FROM court_prices WHERE court_id = ?',
        [fixture.courtId]);
      assert.deepEqual(rows.map((row) => Number(row.duration_minutes)),
        durations.includes(60) ? [60] : []);
    }
  });
});

function emptyFilters(values = {}) {
  return { q: null, city: null, sport: null, minPriceMinor: null, maxPriceMinor: null, ...values };
}

async function membershipsRevoke(pool, id) {
  await pool.execute('UPDATE facility_memberships SET active = 0, deactivated_at = UTC_TIMESTAMP(6) WHERE id = ?',
    [id]);
}

async function seed(pool) {
  const users = [];
  for (const [name, roles] of [
    ['Price Admin', ['USUARIO', 'ADMINISTRADOR']],
    ['Price Owner', ['USUARIO', 'PROPIETARIO']],
    ['Other Owner', ['USUARIO', 'PROPIETARIO']],
    ['Price User', ['USUARIO']],
  ]) {
    const [result] = await pool.execute('INSERT INTO users (name, email) VALUES (?, ?)',
      [name, `${randomUUID()}@pricing-integration.test`]);
    const actor = { id: String(result.insertId), roles };
    users.push(actor);
    for (const role of roles) {
      await pool.execute('INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)', [actor.id, role]);
    }
  }
  const facilities = [];
  for (const name of ['Precio Central', 'Otro Centro']) {
    const [result] = await pool.execute(
      `INSERT INTO facilities
       (name, timezone, minimum_advance_minutes, maximum_advance_minutes,
        city, city_normalized, address, description)
       VALUES (?, 'America/Bogota', 0, 43200, 'Bogotá', 'bogotá', 'Calle 1', 'Canchas cubiertas')`,
      [`${name} ${randomUUID()}`],
    );
    facilities.push(String(result.insertId));
  }
  await pool.execute(
    `INSERT INTO facility_memberships
     (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
     VALUES (?, ?, 'PROPIETARIO', 1, UTC_TIMESTAMP(6), ?)`,
    [facilities[0], users[1].id, users[0].id],
  );
  await pool.execute(
    `INSERT INTO facility_memberships
     (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
     VALUES (?, ?, 'PROPIETARIO', 1, UTC_TIMESTAMP(6), ?)`,
    [facilities[1], users[2].id, users[0].id],
  );
  const [court] = await pool.execute(
    `INSERT INTO courts (facility_id, name, description, sport_code,
      minimum_separation_minutes, start_interval_minutes)
     VALUES (?, 'Pricing Court', 'Cubierta', 'FUTBOL_5', 0, 30)`, [facilities[0]],
  );
  const courtId = String(court.insertId);
  await pool.execute('INSERT INTO court_allowed_durations (court_id, duration_minutes) VALUES (?, 60)', [courtId]);
  const date = Temporal.Now.instant().toZonedDateTimeISO('America/Bogota').toPlainDate().add({ days: 3 });
  await pool.execute(
    `INSERT INTO court_weekly_periods (court_id, weekday, start_time, end_time)
     VALUES (?, ?, '10:00:00', '18:00:00')`, [courtId, date.dayOfWeek],
  );
  return { admin: users[0], owner: users[1], otherOwner: users[2], user: users[3],
    facilityId: facilities[0], otherFacilityId: facilities[1], courtId, date: date.toString() };
}
