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
import { toInstantString, toMySqlDateTime } from '../../src/shared/time.js';

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

  async function confirmPaid(module, actor, bookingRequest, idempotencyKey) {
    const created = await module.confirmBooking({ actor, request: bookingRequest, idempotencyKey });
    const approved = await module.approveTestPayment({ bookingId: created.booking.id,
      providerReference: `test-${randomUUID()}`, amountMinor: created.checkout.amountDueMinor });
    return { ...created, booking: approved.booking };
  }

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

  it('holds checkout pending and approves exactly one payment by provider reference', async () => {
    const created = await bookingModule.confirmBooking({ actor: { id: fixture.userIds[0] },
      request: fixture.request, idempotencyKey: 'integration-pending-payment' });
    assert.equal(created.booking.status, 'PENDIENTE_PAGO');
    assert.equal(created.checkout.depositPercentage, 30);
    assert.equal(created.checkout.amountDueMinor, created.checkout.depositAmountMinor);

    const approved = await adapter.approveTestPayment({ bookingId: created.booking.id,
      providerReference: 'test-payment-reference-1', amountMinor: created.checkout.amountDueMinor });
    assert.equal(approved.booking.status, 'CONFIRMADA');
    assert.equal(approved.booking.paymentStatus, 'PAGADO');
    const replay = await adapter.approveTestPayment({ bookingId: created.booking.id,
      providerReference: 'test-payment-reference-1', amountMinor: created.checkout.amountDueMinor });
    assert.equal(replay.replayed, true);
    const [payments] = await pool.execute('SELECT provider, purpose, status, user_id FROM payments WHERE booking_id = ?',
      [created.booking.id]);
    assert.deepEqual({ provider: payments[0].provider, purpose: payments[0].purpose,
      status: payments[0].status, userId: String(payments[0].user_id) },
    { provider: 'TEST', purpose: 'DEPOSITO', status: 'APROBADO', userId: fixture.userIds[0] });
  });

  it('expires a hold without recording a customer cancellation and releases its slot', async () => {
    const first = await bookingModule.confirmBooking({ actor: { id: fixture.userIds[0] }, request: fixture.request,
      idempotencyKey: 'expired-hold' });
    await pool.execute('UPDATE bookings SET payment_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ?',
      [first.booking.id]);
    const replacement = await bookingModule.confirmBooking({ actor: { id: fixture.userIds[1] }, request: fixture.request,
      idempotencyKey: 'replacement-after-expiry' });
    assert.equal(replacement.booking.status, 'PENDIENTE_PAGO');
    const [expired] = await pool.execute(
      'SELECT status, payment_status, cancelled_at, cancelled_by_user_id FROM bookings WHERE id = ?', [first.booking.id],
    );
    assert.deepEqual({ status: expired[0].status, paymentStatus: expired[0].payment_status,
      cancelledAt: expired[0].cancelled_at, cancelledBy: expired[0].cancelled_by_user_id },
    { status: 'PENDIENTE_PAGO', paymentStatus: 'EXPIRED', cancelledAt: null, cancelledBy: null });
  });

  it('returns a caller facility credit balance or zero without exposing another customer', async () => {
    const now = toMySqlDateTime(new Date());
    await pool.execute(
      `INSERT INTO customer_credit_balances (facility_id, user_id, balance_minor, updated_at)
       VALUES (?, ?, 4500, ?)`, [fixture.facilityId, fixture.userIds[0], now],
    );
    assert.deepEqual(await bookingModule.getFacilityCredit({ actor: { id: fixture.userIds[0] },
      facilityId: fixture.facilityId }), { facilityId: fixture.facilityId, balanceMinor: 4500, currency: 'COP' });
    assert.deepEqual(await bookingModule.getFacilityCredit({ actor: { id: fixture.userIds[1] },
      facilityId: fixture.facilityId }), { facilityId: fixture.facilityId, balanceMinor: 0, currency: 'COP' });
    await assert.rejects(bookingModule.getFacilityCredit({ actor: { id: fixture.userIds[0] }, facilityId: '999999999' }),
      { code: 'resource_not_found' });
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
    assert.equal(sent.length, 0);
    await withEmail.approveTestPayment({ bookingId: first.booking.id, providerReference: 'email-replay-payment',
      amountMinor: first.checkout.amountDueMinor });
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
    await withEmail.approveTestPayment({ bookingId, providerReference: 'provider-failure-payment',
      amountMinor: confirmed.body.checkout.amountDueMinor });
    const [before] = await pool.execute('SELECT status FROM bookings WHERE id = ?', [bookingId]);
    assert.equal(before[0].status, 'CONFIRMADA');
    const cancelled = await request(app).post(`/api/v1/bookings/${bookingId}/cancellation`)
      .set('X-User-Id', fixture.userIds[0])
      .set('X-Booking-Start-At', confirmed.body.booking.startAt).expect(200);
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

  it('reschedules one booking atomically with current price, durable history and an approved late exception', async () => {
    const sent = [];
    const withEmail = createBookingModule({ adapter, clock: createSystemClock(),
      notifications: createBookingEmailNotifier({
        frontendOrigin: 'https://canchapp.online', sendEmail: async (message) => { sent.push(message); },
      }) });
    const actor = { id: fixture.userIds[0], email: fixture.userEmails[0] };
    const created = await confirmPaid(withEmail, actor, fixture.request, 'resched-created');
    const id = created.booking.id;
    const original = created.booking;
    await assert.rejects(withEmail.rescheduleBooking({ actor, bookingId: id, idempotencyKey: 'occupied',
      request: { localDate: fixture.request.localDate, startTime: '12:00:00',
        expectedPriceMinor: 9000000, currency: 'COP' } }), { code: 'invalid_booking_option' });
    await pool.execute('UPDATE court_prices SET price_amount_minor = 6000000 WHERE court_id = ?', [fixture.courtId]);
    await assert.rejects(withEmail.rescheduleBooking({ actor, bookingId: id, idempotencyKey: 'price-changed',
      request: { localDate: fixture.request.localDate, startTime: '13:00:00',
        expectedPriceMinor: 9000000, currency: 'COP' } }), { code: 'booking_price_changed' });
    const [unchanged] = await pool.execute('SELECT start_at, price_amount_minor FROM bookings WHERE id = ?', [id]);
    assert.equal(Number(unchanged[0].price_amount_minor), original.priceMinor);
    const input = { localDate: fixture.request.localDate, startTime: '13:00:00',
      expectedPriceMinor: 6000000, currency: 'COP' };
    const moved = await withEmail.rescheduleBooking({ actor, bookingId: id, request: input, idempotencyKey: 'moved' });
    assert.equal(moved.booking.id, id);
    assert.equal(moved.booking.priceMinor, 6000000);
    assert.notEqual(moved.booking.startAt, original.startAt);
    assert.equal((await withEmail.rescheduleBooking({ actor, bookingId: id, request: input,
      idempotencyKey: 'moved' })).replayed, true);
    await assert.rejects(withEmail.rescheduleBooking({ actor, bookingId: id, request: {
      ...input, startTime: '14:00:00' }, idempotencyKey: 'second-voluntary' }),
    { code: 'voluntary_reschedule_limit_reached' });
    const [financial] = await pool.execute(
      'SELECT amount_paid_minor, deposit_amount_minor, voluntary_reschedule_count FROM bookings WHERE id = ?', [id],
    );
    assert.deepEqual({ paid: Number(financial[0].amount_paid_minor), deposit: Number(financial[0].deposit_amount_minor),
      count: Number(financial[0].voluntary_reschedule_count) }, { paid: 2700000, deposit: 1800000, count: 1 });
    const [credit] = await pool.execute(
      "SELECT amount_minor FROM customer_credit_ledger WHERE booking_id = ? AND reason = 'RESCHEDULE_SURPLUS'", [id],
    );
    assert.equal(Number(credit[0].amount_minor), 900000);
    const changes = await withEmail.listBookingChanges({ actor, bookingId: id });
    assert.deepEqual(changes.items.map((change) => change.type), ['CREATED', 'RESCHEDULED']);
    assert.equal(changes.items[1].previousPriceMinor, 9000000);
    assert.equal(changes.items[1].newPriceMinor, 6000000);
    assert.equal(changes.items[1].previousStartAt, original.startAt);
    assert.equal(changes.items[1].newStartAt, moved.booking.startAt);
    assert.equal(sent.filter((message) => message.type === 'booking-reschedule').length, 1);
    assert.equal(sent.filter((message) => message.type === 'owner-booking-reschedule').length, 2);

    await pool.execute('UPDATE bookings SET cancellation_min_minutes = 5000 WHERE id = ?', [id]);
    await assert.rejects(withEmail.rescheduleBooking({ actor, bookingId: id, request: {
      ...input, startTime: '12:00:00' }, idempotencyKey: 'window-closed' }),
    { code: 'booking_cancellation_window_closed' });
    const requested = await withEmail.requestBookingException({ actor, bookingId: id, category: 'MAL_CLIMA', note: 'Lluvia' });
    await assert.rejects(withEmail.decideBookingException({ actor: { id: fixture.ownerIds[2], roles: ['PROPIETARIO'],
      ownerScope: true }, exceptionId: requested.exception.id, decision: 'APROBADA' }), { code: 'resource_not_found' });
    const owner = { id: fixture.ownerIds[0], roles: ['PROPIETARIO'], ownerScope: true };
    await withEmail.decideBookingException({ actor: owner, exceptionId: requested.exception.id, decision: 'APROBADA' });
    const late = await withEmail.rescheduleBooking({ actor, bookingId: id, request: {
      ...input, startTime: '12:00:00' }, idempotencyKey: 'approved-late' });
    assert.equal(late.booking.id, id);
    assert.equal((await withEmail.listBookingChanges({ actor, bookingId: id })).items[2].economicOutcome,
      'RESCHEDULE_PRIORITY');
    await assert.rejects(withEmail.rescheduleBooking({ actor, bookingId: id, request: input,
      idempotencyKey: 'already-used' }), { code: 'booking_cancellation_window_closed' });
    const cancelled = await withEmail.cancelOwnerBooking({ actor: owner, bookingId: id,
      reasonCode: 'COURT_DAMAGE', reason: 'Daño urgente de cancha' });
    assert.equal(cancelled.booking.cancellationReason, 'CANCELLED_BY_OWNER');
    assert.equal(cancelled.booking.economicOutcome, 'FULL_REFUND_OR_RESCHEDULE');
    assert.equal((await withEmail.listBookingChanges({ actor, bookingId: id })).items[3].reason, 'Daño urgente de cancha');
    assert.equal(sent.filter((message) => message.type === 'booking-owner-cancellation').length, 1);
  });

  it('snapshots the court cancellation policy and restricts no-show to an active member after start', async () => {
    const owner = { id: fixture.ownerIds[0], roles: ['PROPIETARIO'], ownerScope: true };
    await bookingModule.updateCancellationPolicy({ actor: owner, courtId: fixture.courtId,
      cancellationMinMinutes: 240 });
    const actor = { id: fixture.userIds[0], email: fixture.userEmails[0] };
    const created = await confirmPaid(bookingModule, actor, fixture.request, 'policy-snapshot');
    assert.equal(created.booking.cancellationMinMinutes, 240);
    await bookingModule.updateCancellationPolicy({ actor: owner, courtId: fixture.courtId,
      cancellationMinMinutes: 60 });
    const [stored] = await pool.execute('SELECT cancellation_min_minutes FROM bookings WHERE id = ?', [created.booking.id]);
    assert.equal(Number(stored[0].cancellation_min_minutes), 240);
    await assert.rejects(bookingModule.markNoShow({ actor: owner, bookingId: created.booking.id }),
      { code: 'booking_not_started' });
    await pool.execute(`UPDATE bookings SET start_at = UTC_TIMESTAMP(6) - INTERVAL 1 MINUTE,
      end_at = UTC_TIMESTAMP(6) + INTERVAL 59 MINUTE WHERE id = ?`, [created.booking.id]);
    await assert.rejects(bookingModule.markNoShow({ actor: { ...owner, id: fixture.ownerIds[2] },
      bookingId: created.booking.id }), { code: 'resource_not_found' });
    const result = await bookingModule.markNoShow({ actor: owner, bookingId: created.booking.id });
    assert.equal(result.booking.economicOutcome, 'NON_REFUNDABLE');
    await bookingModule.markNoShow({ actor: owner, bookingId: created.booking.id });
    assert.deepEqual((await bookingModule.listBookingChanges({ actor, bookingId: created.booking.id })).items
      .map((change) => change.type), ['CREATED', 'NO_SHOW']);
  });

  it('serializes competing reschedules and keeps the losing original interval intact', async () => {
    const actors = fixture.userIds.map((id) => ({ id }));
    const first = await confirmPaid(bookingModule, actors[0], fixture.request, 'race-first');
    const second = await confirmPaid(bookingModule, actors[1], {
      ...fixture.request, startTime: '13:00:00' }, 'race-second');
    const input = { localDate: fixture.request.localDate, startTime: '11:00:00',
      expectedPriceMinor: 9000000, currency: 'COP' };
    const held = await holdCourtLock(pool, fixture.courtId);
    let results;
    try {
      const attempts = [first, second].map((item, index) => bookingModule.rescheduleBooking({
        actor: actors[index], bookingId: item.booking.id, request: input, idempotencyKey: `race-move-${index}`,
      }));
      const completion = Promise.allSettled(attempts);
      await held.release();
      results = await completion;
    } finally { await held.dispose(); }
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'booking_conflict');
    const rows = await Promise.all([first.booking.id, second.booking.id].map(async (id) => {
      const [values] = await pool.execute('SELECT start_at FROM bookings WHERE id = ?', [id]);
      return toInstantString(values[0].start_at);
    }));
    assert.equal(rows.filter((value) => value === results.find((item) => item.status === 'fulfilled').value.booking.startAt).length, 1);
    assert.equal(new Set(rows).size, 2);
  });

  it('a stale cancellation cannot cancel a concurrently rescheduled interval', async () => {
    const actor = { id: fixture.userIds[0] };
    const original = await confirmPaid(bookingModule, actor, fixture.request, 'cancel-race-original');
    const moved = await bookingModule.rescheduleBooking({ actor, bookingId: original.booking.id,
      idempotencyKey: 'cancel-race-move', request: { localDate: fixture.request.localDate,
        startTime: '13:00:00', expectedPriceMinor: 9000000, currency: 'COP' } });
    await assert.rejects(bookingModule.cancelBooking({ actor, bookingId: original.booking.id,
      expectedStartAt: original.booking.startAt }), { code: 'booking_conflict' });
    assert.equal(moved.booking.status, 'CONFIRMADA');
    assert.deepEqual((await bookingModule.listBookingChanges({ actor, bookingId: original.booking.id })).items
      .map((item) => item.type), ['CREATED', 'RESCHEDULED']);
  });

  it('requires a resolved approved exception for late cancellation and records a refund classification', async () => {
    const actor = { id: fixture.userIds[0] };
    const owner = { id: fixture.ownerIds[0], roles: ['PROPIETARIO'], ownerScope: true };
    const created = await confirmPaid(bookingModule, actor, fixture.request, 'exception-cancel-created');
    const bookingId = created.booking.id;
    await pool.execute('UPDATE bookings SET cancellation_min_minutes = 5000 WHERE id = ?', [bookingId]);
    await assert.rejects(bookingModule.cancelBooking({ actor, bookingId }),
      { code: 'booking_cancellation_window_closed' });
    await assert.rejects(bookingModule.cancelExceptionBooking({ actor, bookingId }),
      { code: 'booking_cancellation_window_closed' });
    const first = await bookingModule.requestBookingException({ actor, bookingId, category: 'FUERZA_MAYOR' });
    await bookingModule.decideBookingException({ actor: owner, exceptionId: first.exception.id,
      decision: 'RECHAZADA' });
    await assert.rejects(bookingModule.cancelExceptionBooking({ actor, bookingId }),
      { code: 'booking_cancellation_window_closed' });
    const second = await bookingModule.requestBookingException({ actor, bookingId, category: 'MAL_CLIMA' });
    await bookingModule.decideBookingException({ actor: owner, exceptionId: second.exception.id,
      decision: 'APROBADA' });
    const cancelled = await bookingModule.cancelExceptionBooking({ actor, bookingId });
    assert.equal(cancelled.booking.cancellationReason, 'CLIENTE_EXCEPCION');
    assert.equal(cancelled.booking.economicOutcome, 'REFUND_ALLOWED');
    const [rows] = await pool.execute('SELECT used_at, economic_outcome FROM booking_exception_requests WHERE id = ?',
      [second.exception.id]);
    assert.ok(rows[0].used_at);
    assert.equal(rows[0].economic_outcome, 'REFUND_ALLOWED');
    assert.deepEqual((await bookingModule.listBookingChanges({ actor, bookingId })).items.map((item) => item.type),
      ['CREATED', 'CANCELLED_BY_CUSTOMER']);
  });

  it('rejects reschedules blocked by another booking, closing hours, an outage or a date exception', async () => {
    const actor = { id: fixture.userIds[0] };
    const original = await confirmPaid(bookingModule, actor, fixture.request, 'unavailable-original');
    await confirmPaid(bookingModule, { id: fixture.userIds[1] },
      { ...fixture.request, startTime: '13:00:00' }, 'unavailable-neighbor');
    async function move(startTime, key, code) {
      await assert.rejects(bookingModule.rescheduleBooking({ actor, bookingId: original.booking.id,
        request: { localDate: fixture.request.localDate, startTime,
          expectedPriceMinor: 9000000, currency: 'COP' }, idempotencyKey: key }), { code });
    }
    await move('13:00:00', 'neighbor-blocks', 'booking_conflict');
    await move('15:00:00', 'outside-schedule', 'invalid_booking_option');
    const unavailableStart = new Date(`${fixture.request.localDate}T16:00:00Z`);
    const unavailableEnd = new Date(`${fixture.request.localDate}T17:00:00Z`);
    await pool.execute(
      `INSERT INTO court_unavailabilities (court_id, type, start_at, end_at, created_by_user_id, created_at)
       VALUES (?, 'FUERA_DE_SERVICIO', ?, ?, ?, UTC_TIMESTAMP(6))`,
      [fixture.courtId, toMySqlDateTime(unavailableStart), toMySqlDateTime(unavailableEnd), fixture.userIds[0]],
    );
    await move('11:00:00', 'blocked-outage', 'option_not_available');
    await pool.execute('DELETE FROM court_unavailabilities WHERE court_id = ?', [fixture.courtId]);
    await pool.execute(`INSERT INTO court_date_exceptions (court_id, local_date, mode)
      VALUES (?, ?, 'CLOSED')`, [fixture.courtId, fixture.request.localDate]);
    await move('11:00:00', 'closed-date', 'invalid_booking_option');
    const [unchanged] = await pool.execute('SELECT start_at FROM bookings WHERE id = ?', [original.booking.id]);
    assert.equal(toInstantString(unchanged[0].start_at), original.booking.startAt);
    assert.deepEqual((await bookingModule.listBookingChanges({ actor, bookingId: original.booking.id })).items
      .map((item) => item.type), ['CREATED']);
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
    await connection.execute('DELETE FROM booking_changes WHERE booking_id IN (SELECT id FROM bookings WHERE court_id = ?)',
      [fixture.courtId]);
    await connection.execute('DELETE FROM booking_exception_requests WHERE booking_id IN (SELECT id FROM bookings WHERE court_id = ?)',
      [fixture.courtId]);
    await connection.execute('DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE court_id = ?)',
      [fixture.courtId]);
    await connection.execute('DELETE FROM customer_credit_ledger WHERE booking_id IN (SELECT id FROM bookings WHERE court_id = ?)',
      [fixture.courtId]);
    await connection.execute('DELETE FROM bookings WHERE court_id = ?', [fixture.courtId]);
    await connection.execute('DELETE FROM customer_credit_ledger WHERE facility_id = ? AND user_id IN (?, ?)',
      [fixture.facilityId, ...fixture.userIds]);
    await connection.execute('DELETE FROM customer_credit_balances WHERE facility_id = ? AND user_id IN (?, ?)',
      [fixture.facilityId, ...fixture.userIds]);
    await connection.execute('DELETE FROM court_unavailabilities WHERE court_id = ?', [fixture.courtId]);
    await connection.execute('DELETE FROM court_exception_periods WHERE exception_id IN (SELECT id FROM court_date_exceptions WHERE court_id = ?)', [fixture.courtId]);
    await connection.execute('DELETE FROM court_date_exceptions WHERE court_id = ?', [fixture.courtId]);
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
