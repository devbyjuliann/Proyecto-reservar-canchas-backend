import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
} from 'node:test';

import { Temporal } from '@js-temporal/polyfill';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import {
  createBookingModule,
  createBookingEmailNotifier,
  createMySqlBookingAdapter,
} from '../../src/modules/booking/index.js';
import { createSystemClock } from '../../src/shared/clock.js';

const REQUIRED_DB_ENV = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const MYSQL_AVAILABLE = process.env.NODE_ENV === 'test'
  && REQUIRED_DB_ENV.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');

describe('booking MySQL integration', { skip: !MYSQL_AVAILABLE, timeout: 30_000 }, () => {
  let pool;
  let adapter;
  let bookingModule;
  let fixture;
  let sqlObserver;

  before(async () => {
    const config = loadDatabaseConfig({ forMigrations: true });
    const migrationConnection = await createMigrationConnection(config);
    try {
      await createMigrator(migrationConnection).up();
    } finally {
      await migrationConnection.end();
    }
    pool = createMySqlPool(loadDatabaseConfig());
    sqlObserver = createSqlObserver();
    adapter = createMySqlBookingAdapter({
      pool: createObservedPool(pool, sqlObserver),
    });
    bookingModule = createBookingModule({ adapter, clock: createSystemClock() });
  });

  after(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    fixture = await seedFixture(pool);
  });

  afterEach(async () => {
    await cleanFixture(pool, fixture);
  });

  it('confirms once, replays the same result, and rejects another payload', async () => {
    const request = fixture.request;
    const first = await bookingModule.confirmBooking({
      actor: { id: fixture.userIds[0] },
      request,
      idempotencyKey: 'integration-replay',
    });
    const replay = await bookingModule.confirmBooking({
      actor: { id: fixture.userIds[0] },
      request,
      idempotencyKey: 'integration-replay',
    });

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.booking.id, first.booking.id);
    await assert.rejects(
      bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request: { ...request, durationMinutes: 30 },
        idempotencyKey: 'integration-replay',
      }),
      { code: 'invalid_idempotency_key_reuse' },
    );

    const [bookingRows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bookings WHERE court_id = ?',
      [fixture.courtId],
    );
    const [idempotencyRows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM idempotency_records WHERE user_id = ?',
      [fixture.userIds[0]],
    );
    assert.equal(Number(bookingRows[0].count), 1);
    assert.equal(Number(idempotencyRows[0].count), 1);
  });

  it('serializes incompatible confirmations so exactly one succeeds', async () => {
    const heldLock = await holdCourtLock(pool, fixture.courtId);
    let results;
    try {
      sqlObserver.reset();
      const settlement = { count: 0 };
      const attempts = fixture.userIds.map((userId, index) =>
        bookingModule.confirmBooking({
          actor: { id: userId },
          request: fixture.request,
          idempotencyKey: `integration-concurrent-${index}`,
        }).finally(() => {
          settlement.count += 1;
        }));
      const completion = Promise.allSettled(attempts);

      await sqlObserver.waitFor({ idempotencyClaims: 2, courtLocks: 2 });
      assert.equal(settlement.count, 0);
      await heldLock.release();
      results = await completion;
    } finally {
      await heldLock.dispose();
    }

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'booking_conflict');

    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bookings WHERE court_id = ?',
      [fixture.courtId],
    );
    assert.equal(Number(rows[0].count), 1);
  });

  it('coalesces concurrent requests with the same idempotency key', async () => {
    const heldLock = await holdCourtLock(pool, fixture.courtId);
    let results;
    try {
      sqlObserver.reset();
      const settlement = { count: 0 };
      const attempts = [0, 1].map(() => bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request: fixture.request,
        idempotencyKey: 'integration-same-key',
      }).finally(() => {
        settlement.count += 1;
      }));
      const completion = Promise.all(attempts);

      // The second request waits on the unique idempotency key before reaching the court lock.
      await sqlObserver.waitFor({ idempotencyClaims: 2, courtLocks: 1 });
      assert.equal(settlement.count, 0);
      await heldLock.release();
      results = await completion;
    } finally {
      await heldLock.dispose();
    }

    assert.equal(new Set(results.map((result) => result.booking.id)).size, 1);
    assert.deepEqual(
      results.map((result) => result.replayed).sort(),
      [false, true],
    );
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bookings WHERE court_id = ?',
      [fixture.courtId],
    );
    assert.equal(Number(rows[0].count), 1);

    const [idempotencyRows] = await pool.execute(
      `SELECT outcome, booking_id, result_code
       FROM idempotency_records
       WHERE user_id = ? AND operation = 'CONFIRM_BOOKING' AND idempotency_key = ?`,
      [fixture.userIds[0], Buffer.from('integration-same-key', 'ascii')],
    );
    assert.equal(idempotencyRows.length, 1);
    assert.equal(idempotencyRows[0].outcome, 'SUCCEEDED');
    assert.equal(String(idempotencyRows[0].booking_id), results[0].booking.id);
    assert.equal(idempotencyRows[0].result_code, null);
  });

  it('allows only one interpretation of a concurrently reused idempotency key', async () => {
    const heldLock = await holdCourtLock(pool, fixture.courtId);
    let results;
    try {
      sqlObserver.reset();
      const settlement = { count: 0 };
      const requests = [
        fixture.request,
        { ...fixture.request, startTime: '11:00:00' },
      ];
      const attempts = requests.map((request) => bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request,
        idempotencyKey: 'integration-concurrent-key-reuse',
      }).finally(() => {
        settlement.count += 1;
      }));
      const completion = Promise.allSettled(attempts);

      await sqlObserver.waitFor({ idempotencyClaims: 2, courtLocks: 1 });
      assert.equal(settlement.count, 0);
      await heldLock.release();
      results = await completion;
    } finally {
      await heldLock.dispose();
    }

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'invalid_idempotency_key_reuse');

    const [bookingRows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bookings WHERE court_id = ?',
      [fixture.courtId],
    );
    assert.equal(Number(bookingRows[0].count), 1);

    const [idempotencyRows] = await pool.execute(
      `SELECT outcome, booking_id, result_code
       FROM idempotency_records
       WHERE user_id = ? AND operation = 'CONFIRM_BOOKING' AND idempotency_key = ?`,
      [fixture.userIds[0], Buffer.from('integration-concurrent-key-reuse', 'ascii')],
    );
    assert.equal(idempotencyRows.length, 1);
    assert.equal(idempotencyRows[0].outcome, 'SUCCEEDED');
    assert.equal(String(idempotencyRows[0].booking_id), fulfilled[0].value.booking.id);
    assert.equal(idempotencyRows[0].result_code, null);
  });

  it('rolls back booking and idempotency when a technical error occurs', async () => {
    const requestHash = createHash('sha256').update('technical-failure').digest();
    await assert.rejects(
      adapter.confirmBooking({
        userId: fixture.userIds[0],
        request: fixture.request,
        idempotencyKey: 'integration-rollback',
        requestHash,
        evaluate() {
          throw new Error('Injected technical failure');
        },
      }),
      /Injected technical failure/,
    );

    const [bookingRows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM bookings WHERE court_id = ?',
      [fixture.courtId],
    );
    const [idempotencyRows] = await pool.execute(
      `SELECT COUNT(*) AS count
       FROM idempotency_records
       WHERE user_id = ? AND idempotency_key = ?`,
      [fixture.userIds[0], Buffer.from('integration-rollback', 'ascii')],
    );
    assert.equal(Number(bookingRows[0].count), 0);
    assert.equal(Number(idempotencyRows[0].count), 0);
  });

  it('persists and replays resource_not_found as a stable rejection', async () => {
    const missingRequest = { ...fixture.request, courtId: '18446744073709551615' };
    await assert.rejects(
      bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request: missingRequest,
        idempotencyKey: 'integration-missing',
      }),
      { code: 'resource_not_found' },
    );
    await assert.rejects(
      bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request: missingRequest,
        idempotencyKey: 'integration-missing',
      }),
      { code: 'resource_not_found' },
    );
    await assert.rejects(
      bookingModule.confirmBooking({
        actor: { id: fixture.userIds[0] },
        request: { ...missingRequest, durationMinutes: 30 },
        idempotencyKey: 'integration-missing',
      }),
      { code: 'invalid_idempotency_key_reuse' },
    );

    const [rows] = await pool.execute(
      `SELECT outcome, result_code
       FROM idempotency_records
       WHERE user_id = ? AND idempotency_key = ?`,
      [fixture.userIds[0], Buffer.from('integration-missing', 'ascii')],
    );
    assert.deepEqual(rows, [{ outcome: 'REJECTED', result_code: 'resource_not_found' }]);
  });

  it('cancels once, preserves the original cancellation, and retains microseconds', async () => {
    const confirmed = await bookingModule.confirmBooking({
      actor: { id: fixture.userIds[0] },
      request: fixture.request,
      idempotencyKey: 'integration-cancel',
    });
    const first = await bookingModule.cancelBooking({
      actor: { id: fixture.userIds[0] },
      bookingId: confirmed.booking.id,
    });
    const replay = await bookingModule.cancelBooking({
      actor: { id: fixture.userIds[0] },
      bookingId: confirmed.booking.id,
    });

    assert.equal(first.booking.status, 'CANCELADA');
    assert.equal(replay.booking.cancelledAt, first.booking.cancelledAt);
    assert.match(first.booking.cancelledAt, /\.\d{6}Z$/);

    const [rows] = await pool.execute(
      `SELECT DATE_FORMAT(cancelled_at, '%Y-%m-%d %H:%i:%s.%f') AS cancelled_at
       FROM bookings WHERE id = ?`,
      [confirmed.booking.id],
    );
    assert.match(rows[0].cancelled_at, /\.\d{6}$/);
  });

  it('emails the client and each operational owner once per real transition, using the original price after a tariff change', async () => {
    await pool.execute('UPDATE court_prices SET price_amount_minor = 5000000 WHERE court_id = ?', [fixture.courtId]);
    const sent = [];
    const notifications = createBookingEmailNotifier({
      sendEmail: async (message) => { sent.push(message); }, frontendOrigin: 'https://canchapp.online',
    });
    const withEmail = createBookingModule({ adapter, clock: createSystemClock(), notifications });
    const actor = { id: fixture.userIds[0], email: fixture.userEmails[0] };
    const bookingRequest = { ...fixture.request, expectedPriceMinor: 5000000 };
    const first = await withEmail.confirmBooking({ actor, request: bookingRequest, idempotencyKey: 'email-replay' });
    assert.equal(first.replayed, false);
    assert.equal(sent.length, 3);
    assert.deepEqual(sent.filter(({ type }) => type === 'booking-confirmation').map(({ email }) => email), [actor.email]);
    assert.deepEqual(sent.filter(({ type }) => type === 'owner-booking-confirmation').map(({ email }) => email).sort(),
      fixture.operationalOwnerEmails.slice().sort());
    const localDate = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'America/Bogota' }).format(new Date(first.booking.startAt));
    for (const message of sent) {
      assert.ok(message.text.includes(localDate));
      assert.ok(message.text.includes('12:00 - 13:00'));
      assert.ok(message.text.includes('$50.000 COP'));
    }
    const replay = await withEmail.confirmBooking({ actor, request: bookingRequest, idempotencyKey: 'email-replay' });
    assert.equal(replay.replayed, true);
    assert.equal(sent.length, 3);

    await pool.execute('UPDATE court_prices SET price_amount_minor = 6000000 WHERE court_id = ?', [fixture.courtId]);
    const cancelled = await withEmail.cancelBooking({ actor, bookingId: first.booking.id });
    assert.equal(cancelled.booking.status, 'CANCELADA');
    await withEmail.cancelBooking({ actor, bookingId: first.booking.id });
    assert.equal(sent.length, 6);
    assert.deepEqual(sent.filter(({ type }) => type === 'booking-cancellation').map(({ email }) => email), [actor.email]);
    const ownerCancellations = sent.filter(({ type }) => type === 'owner-booking-cancellation');
    assert.deepEqual(ownerCancellations.map(({ email }) => email).sort(), fixture.operationalOwnerEmails.slice().sort());
    for (const message of ownerCancellations) {
      assert.ok(message.text.includes('$50.000 COP'));
      assert.equal(message.text.includes('$60.000 COP'), false);
      assert.ok(message.text.includes('El horario vuelve a quedar sujeto a la disponibilidad actual de la cancha.'));
    }
    const [rows] = await pool.execute('SELECT status, price_amount_minor FROM bookings WHERE id = ?', [first.booking.id]);
    assert.equal(rows[0].status, 'CANCELADA');
    assert.equal(Number(rows[0].price_amount_minor), 5000000);
  });

  it('keeps HTTP confirmation and cancellation successful when the provider fails after commit', async () => {
    const errors = [];
    const notifications = createBookingEmailNotifier({
      sendEmail: async () => { throw new Error('Sensitive provider failure'); },
      frontendOrigin: 'https://canchapp.online',
    });
    const withEmail = createBookingModule({ adapter, clock: createSystemClock(), notifications,
      logger: { error: (message) => { errors.push(message); } } });
    const app = createApp({ environment: 'test', frontendOrigin: 'http://localhost:5173', booking: withEmail,
      findActiveUserById: async (id) => id === fixture.userIds[0]
        ? { id, name: 'Integration one', email: fixture.userEmails[0], roles: ['USUARIO'] } : null,
      logger: { error: (message) => { errors.push(message); } } });
    const confirmed = await request(app).post('/api/v1/bookings')
      .set('X-User-Id', fixture.userIds[0]).set('Idempotency-Key', 'email-provider-fails')
      .send(fixture.request).expect(201);
    const bookingId = confirmed.body.booking.id;
    const [before] = await pool.execute('SELECT status FROM bookings WHERE id = ?', [bookingId]);
    assert.equal(before[0].status, 'CONFIRMADA');
    const cancelled = await request(app).post(`/api/v1/bookings/${bookingId}/cancellation`)
      .set('X-User-Id', fixture.userIds[0]).expect(200);
    assert.equal(cancelled.body.booking.status, 'CANCELADA');
    const [after] = await pool.execute('SELECT status FROM bookings WHERE id = ?', [bookingId]);
    assert.equal(after[0].status, 'CANCELADA');
    assert.deepEqual(errors, [
      'Booking confirmation email delivery failed',
      'owner_booking_email_failed', 'owner_booking_email_failed',
      'Booking cancellation email delivery failed',
      'owner_booking_email_failed', 'owner_booking_email_failed',
    ]);
    assert.equal(errors.join(' ').includes('Sensitive provider failure'), false);
  });
});

async function seedFixture(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const userIds = [];
    const userEmails = [];
    for (const suffix of ['one', 'two']) {
      const email = `${randomUUID()}@example.com`;
      const [user] = await connection.execute(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [`Integration ${suffix}`, email],
      );
      userIds.push(String(user.insertId));
      userEmails.push(email);
    }
    const ownerIds = [];
    const ownerEmails = [];
    for (const suffix of ['active-one', 'active-two', 'suspended', 'deactivated', 'inactive-membership']) {
      const email = `${randomUUID()}@example.com`;
      const [owner] = await connection.execute(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [`Owner ${suffix}`, email],
      );
      ownerIds.push(String(owner.insertId));
      ownerEmails.push(email);
      await connection.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'PROPIETARIO')", [owner.insertId]);
    }
    const [facility] = await connection.execute(
      `INSERT INTO facilities
         (name, timezone, minimum_advance_minutes, maximum_advance_minutes)
       VALUES (?, 'America/Bogota', 0, 525600)`,
      [`Integration ${randomUUID()}`],
    );
    const facilityId = String(facility.insertId);
    for (const [index, ownerId] of ownerIds.entries()) {
      await connection.execute(
        `INSERT INTO facility_memberships
         (facility_id, user_id, membership_type, active, created_at, deactivated_at, created_by_user_id)
         VALUES (?, ?, 'PROPIETARIO', ?, NOW(6), ${index < 4 ? 'NULL' : 'NOW(6)'}, ?)`,
        [facilityId, ownerId, index < 4 ? 1 : 0, ownerIds[0]],
      );
    }
    await connection.execute('UPDATE users SET owner_suspended_at = NOW(6) WHERE id = ?', [ownerIds[2]]);
    await connection.execute('UPDATE users SET deactivated_at = NOW(6) WHERE id = ?', [ownerIds[3]]);
    const [court] = await connection.execute(
      `INSERT INTO courts
         (facility_id, name, minimum_separation_minutes, start_interval_minutes)
       VALUES (?, ?, 0, 30)`,
      [facilityId, `Court ${randomUUID()}`],
    );
    const courtId = String(court.insertId);
    await connection.execute(
      'INSERT INTO court_allowed_durations (court_id, duration_minutes) VALUES (?, 60)',
      [courtId],
    );
    await connection.execute(
      "INSERT INTO court_prices (court_id, duration_minutes, price_amount_minor, currency) VALUES (?, 60, 9000000, 'COP')",
      [courtId],
    );

    const localDate = Temporal.Now.instant()
      .toZonedDateTimeISO('America/Bogota')
      .toPlainDate()
      .add({ days: 2 });
    await connection.execute(
      `INSERT INTO court_weekly_periods (court_id, weekday, start_time, end_time)
       VALUES (?, ?, '10:00:00', '14:00:00')`,
      [courtId, localDate.dayOfWeek],
    );
    await connection.commit();
    return {
      userIds,
      userEmails,
      ownerIds,
      ownerEmails,
      operationalOwnerEmails: ownerEmails.slice(0, 2),
      facilityId,
      courtId,
      request: {
        courtId,
        localDate: localDate.toString(),
        startTime: '12:00:00',
        durationMinutes: 60,
        expectedPriceMinor: 9000000,
        currency: 'COP',
      },
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanFixture(pool, fixture) {
  if (!fixture) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `DELETE FROM idempotency_records WHERE user_id IN (?, ?)`,
      fixture.userIds,
    );
    await connection.execute('DELETE FROM bookings WHERE court_id = ?', [fixture.courtId]);
    await connection.execute(
      'DELETE FROM court_weekly_periods WHERE court_id = ?',
      [fixture.courtId],
    );
    await connection.execute('DELETE FROM court_prices WHERE court_id = ?', [fixture.courtId]);
    await connection.execute(
      'DELETE FROM court_allowed_durations WHERE court_id = ?',
      [fixture.courtId],
    );
    await connection.execute('DELETE FROM courts WHERE id = ?', [fixture.courtId]);
    await connection.execute('DELETE FROM facility_memberships WHERE facility_id = ?', [fixture.facilityId]);
    await connection.execute('DELETE FROM facilities WHERE id = ?', [fixture.facilityId]);
    await connection.execute(
      'DELETE FROM user_roles WHERE user_id IN (?, ?)',
      fixture.userIds,
    );
    await connection.execute(
      `DELETE FROM user_roles WHERE user_id IN (${fixture.ownerIds.map(() => '?').join(', ')})`,
      fixture.ownerIds,
    );
    await connection.execute('DELETE FROM users WHERE id IN (?, ?)', fixture.userIds);
    await connection.execute(
      `DELETE FROM users WHERE id IN (${fixture.ownerIds.map(() => '?').join(', ')})`,
      fixture.ownerIds,
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function createObservedPool(pool, observer) {
  return {
    execute: (...args) => pool.execute(...args),
    async getConnection() {
      const connection = await pool.getConnection();
      return new Proxy(connection, {
        get(target, property) {
          if (property === 'execute') {
            return (sql, values) => {
              const result = target.execute(sql, values);
              observer.record(sql);
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

function createSqlObserver() {
  const counts = { idempotencyClaims: 0, courtLocks: 0 };
  const waiters = new Set();

  return {
    record(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO idempotency_records')) {
        counts.idempotencyClaims += 1;
      }
      if (normalized === 'SELECT id FROM courts WHERE id = ? FOR UPDATE') {
        counts.courtLocks += 1;
      }
      for (const waiter of waiters) waiter.check();
    },
    reset() {
      counts.idempotencyClaims = 0;
      counts.courtLocks = 0;
    },
    waitFor(expected) {
      if (hasObserved(counts, expected)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = {
          check() {
            if (!hasObserved(counts, expected)) return;
            clearTimeout(waiter.timeout);
            waiters.delete(waiter);
            resolve();
          },
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(
              `Timed out waiting for SQL concurrency point: ${JSON.stringify({ counts, expected })}`,
            ));
          }, 5_000),
        };
        waiters.add(waiter);
      });
    },
  };
}

function hasObserved(counts, expected) {
  return counts.idempotencyClaims >= expected.idempotencyClaims
    && counts.courtLocks >= expected.courtLocks;
}

async function holdCourtLock(pool, courtId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'SELECT id FROM courts WHERE id = ? FOR UPDATE',
      [courtId],
    );
  } catch (error) {
    connection.release();
    throw error;
  }

  let active = true;
  return {
    async release() {
      if (!active) return;
      await connection.commit();
      active = false;
      connection.release();
    },
    async dispose() {
      if (!active) return;
      try {
        await connection.rollback();
      } finally {
        active = false;
        connection.release();
      }
    },
  };
}
