import { Temporal } from '@js-temporal/polyfill';

import { ApplicationError } from '../../shared/errors.js';
import { requireActiveMembership } from '../facility-memberships/authorize.js';
import { localDayBounds, toInstantString, toMySqlDateTime } from '../../shared/time.js';
import { bookingError } from './errors.js';

const RECOVERABLE_MYSQL_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const MAX_TRANSACTION_ATTEMPTS = 3;

export function createMySqlBookingAdapter({ pool, isPublicCourt }) {
  if (!pool?.execute || !pool?.getConnection) {
    throw new TypeError('A mysql2 promise pool is required');
  }

  return Object.freeze({
    readAvailabilityContext,
    getFacilityCredit,
    confirmBooking,
    approveTestPayment,
    createPaymentAttempt,
    settlePayment,
    getLatestWompiTransaction,
    listOwnBookings,
    listOwnerBookings,
    cancelBooking,
    cancelExceptionBooking,
    rescheduleBooking,
    listBookingChanges,
    requestBookingException,
    decideBookingException,
    listOwnerExceptions,
    cancelOwnerBooking,
    markNoShow,
    updateCancellationPolicy,
    updateDepositPolicy,
    listOperationalOwnerRecipients,
    replaceFacilityBookingPolicy,
    deactivateFacility,
    createCourt,
    getCourtBookingConfiguration,
    replaceCourtBookingConfiguration,
    getWeeklySchedule,
    replaceWeeklySchedule,
    listDateExceptions,
    getDateException,
    putDateException,
    deleteDateException,
    listUnavailabilities,
    createUnavailability,
    getUnavailability,
    deactivateCourt,
    listOperationalConflicts,
    getOperationalConflict,
  });

  async function readAvailabilityContext({ courtId, date }) {
    const connection = await pool.getConnection();
    try {
      const snapshot = await loadAvailabilityContext(connection, { courtId, date, lockCourt: false });
      if (!snapshot) return null;
      return { ...snapshot, prices: await loadPriceMap(connection, courtId) };
    } finally {
      connection.release();
    }
  }

  async function getFacilityCredit({ facilityId, userId }) {
    const [rows] = await pool.execute(
      `SELECT f.id, COALESCE(cb.balance_minor, 0) AS balance_minor
       FROM facilities AS f
       LEFT JOIN customer_credit_balances AS cb
         ON cb.facility_id = f.id AND cb.user_id = ?
       WHERE f.id = ?`,
      [userId, facilityId],
    );
    if (!rows.length) return null;
    return { balanceMinor: Number(rows[0].balance_minor) };
  }

  async function confirmBooking({
    userId,
    request,
    idempotencyKey,
    requestHash,
    evaluate,
  }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const idempotency = await claimIdempotency(connection, {
        userId,
        idempotencyKey,
        requestHash,
      });

      if (idempotency.existing) {
        if (!Buffer.from(idempotency.row.request_hash).equals(requestHash)) {
          throw bookingError('invalid_idempotency_key_reuse');
        }
        if (idempotency.row.outcome === 'REJECTED') {
          return { kind: 'rejected', code: idempotency.row.result_code,
            currentPriceMinor: idempotency.row.result_price_amount_minor == null
              ? null : Number(idempotency.row.result_price_amount_minor) };
        }
        if (idempotency.row.outcome === 'SUCCEEDED') {
          const now = await readDatabaseNow(connection);
          const booking = await loadBooking(connection, idempotency.row.booking_id);
          if (!booking) throw bookingError('internal_error');
          return { kind: 'succeeded', booking, now, replayed: true,
            checkout: checkoutFor(booking, Math.max(0, (booking.depositAmountMinor ?? 0) - (booking.amountPaidMinor ?? 0))) };
        }
        throw bookingError('internal_error');
      }

      const snapshot = await loadAvailabilityContext(connection, {
        courtId: request.courtId,
        date: request.localDate,
        lockCourt: true,
      });
      if (!snapshot) {
        const now = await readDatabaseNow(connection);
        await completeRejectedIdempotency(
          connection,
          idempotency.id,
          'resource_not_found',
          now,
        );
        return { kind: 'rejected', code: 'resource_not_found' };
      }

      await expirePendingBookings(connection, request.courtId);

      if (isPublicCourt && !await isPublicCourt(connection, request.courtId, { requirePrice: false })) {
        const now = await readDatabaseNow(connection);
        await completeRejectedIdempotency(connection, idempotency.id, 'resource_not_found', now);
        return { kind: 'rejected', code: 'resource_not_found' };
      }

      const now = await readDatabaseNow(connection);
      const decision = evaluate({ context: snapshot.context, now });
      if (!decision.accepted) {
        if (decision.code === 'internal_error') throw bookingError('internal_error');
        await completeRejectedIdempotency(
          connection,
          idempotency.id,
          decision.code,
          now,
        );
        return { kind: 'rejected', code: decision.code };
      }

      const [priceRows] = await connection.execute(
        'SELECT price_amount_minor, currency FROM court_prices WHERE court_id = ? AND duration_minutes = ?',
        [request.courtId, request.durationMinutes],
      );
      const currentPriceMinor = priceRows.length ? Number(priceRows[0].price_amount_minor) : null;
      if (currentPriceMinor !== request.expectedPriceMinor || priceRows[0]?.currency !== 'COP'
        || request.currency !== 'COP') {
        await completeRejectedIdempotency(connection, idempotency.id, 'booking_price_changed', now,
          currentPriceMinor);
        return { kind: 'rejected', code: 'booking_price_changed', currentPriceMinor };
      }

      const depositPercentage = Number(snapshot.court.depositPercentage);
      const depositAmountMinor = Math.ceil(currentPriceMinor * depositPercentage / 100);
      const requestedCredit = request.useCreditMinor ?? 0;
      const creditApplied = await spendCredit(connection, {
        facilityId: snapshot.facility.id, userId, bookingId: null,
        requestedMinor: Math.min(requestedCredit, depositAmountMinor), now,
      });
      const dueMinor = depositAmountMinor - creditApplied;
      const paid = creditApplied;
      const [insert] = await connection.execute(
        `INSERT INTO bookings
           (user_id, court_id, start_at, end_at, booking_timezone, status, created_at,
              price_amount_minor, price_currency, cancellation_min_minutes, economic_outcome,
              deposit_percentage_snapshot, deposit_amount_minor, amount_paid_minor, payment_status,
               payment_expires_at, voluntary_reschedule_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COP', ?, 'NOT_APPLICABLE', ?, ?, ?, ?,
              CASE WHEN ? = 0 THEN NULL ELSE DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE) END, 0)`,
        [
          userId,
          request.courtId,
          toMySqlDateTime(decision.option.startAt),
          toMySqlDateTime(decision.option.endAt),
          snapshot.context.timeZone,
          dueMinor === 0 ? 'CONFIRMADA' : 'PENDIENTE_PAGO',
          toMySqlDateTime(now),
          currentPriceMinor,
          snapshot.court.cancellationMinMinutes,
          depositPercentage,
          depositAmountMinor,
          paid,
          dueMinor === 0 ? 'PAGADO' : 'PENDIENTE',
          dueMinor,
        ],
      );
      const bookingId = String(insert.insertId);
      if (creditApplied > 0) await attachCreditSpend(connection, { facilityId: snapshot.facility.id,
        userId, bookingId, amountMinor: creditApplied, now });
      const [completion] = await connection.execute(
        `UPDATE idempotency_records
         SET outcome = 'SUCCEEDED', booking_id = ?, result_code = NULL, completed_at = ?
         WHERE id = ? AND outcome IS NULL`,
        [bookingId, toMySqlDateTime(now), idempotency.id],
      );
      if (completion.affectedRows !== 1) throw bookingError('internal_error');

      const booking = await loadBooking(connection, bookingId);
      if (!booking) throw bookingError('internal_error');
      await recordBookingChange(connection, { bookingId, actorUserId: userId, type: 'CREATED',
        next: booking, outcome: 'NOT_APPLICABLE', now });
      return { kind: 'succeeded', booking, now, replayed: false,
        checkout: checkoutFor(booking, dueMinor) };
    });
  }

  async function listOwnBookings({ userId, limit, cursor }) {
    const values = [userId];
    let cursorClause = '';
    if (cursor) {
      cursorClause = `
        AND (b.start_at < ? OR (b.start_at = ? AND b.id < ?))`;
      const cursorStart = toMySqlDateTime(cursor.startAt);
      values.push(cursorStart, cursorStart, cursor.id);
    }
    values.push(limit);

    const [rows] = await pool.execute(
      `${bookingSelect()}
       WHERE b.user_id = ?${cursorClause}
       ORDER BY b.start_at DESC, b.id DESC
       LIMIT ?`,
      values,
    );
    return rows.map(mapBooking);
  }

  async function approveTestPayment({ bookingId, providerReference, amountMinor }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute('SELECT court_id FROM bookings WHERE id = ?', [bookingId]);
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      await expirePendingBookings(connection, initial[0].court_id);
      const [locked] = await connection.execute('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
      if (!locked.length) throw bookingError('resource_not_found');
      const booking = await loadBooking(connection, bookingId);
      const now = await readDatabaseNow(connection);
      const [existing] = await connection.execute(
        "SELECT booking_id FROM payments WHERE provider = 'TEST' AND provider_reference = ? FOR UPDATE", [providerReference],
      );
      if (existing.length) {
        if (String(existing[0].booking_id) !== String(bookingId)) throw bookingError('payment_reference_reused');
        return { booking: await loadBooking(connection, bookingId), replayed: true };
      }
      if (booking.status !== 'PENDIENTE_PAGO' || booking.paymentExpiresAt == null) {
        throw bookingError('invalid_booking_state');
      }
      const due = booking.depositAmountMinor - booking.amountPaidMinor;
      if (amountMinor !== due) throw bookingError('invalid_payment_amount');
      await connection.execute(
        `INSERT INTO payments (booking_id, user_id, amount_minor, currency, status, purpose, provider,
           provider_reference, created_at, updated_at)
         VALUES (?, ?, ?, 'COP', 'APROBADO', 'DEPOSITO', 'TEST', ?, ?, ?)`,
        [bookingId, booking.userId, amountMinor, providerReference, toMySqlDateTime(now), toMySqlDateTime(now)],
      );
      await connection.execute(
        `UPDATE bookings SET status = 'CONFIRMADA', payment_status = 'PAGADO',
           amount_paid_minor = amount_paid_minor + ?, payment_expires_at = NULL WHERE id = ?`,
        [amountMinor, bookingId],
      );
      return { booking: await loadBooking(connection, bookingId), replayed: false };
    });
  }

  async function createPaymentAttempt({ bookingId, userId, provider, reference }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [locked] = await connection.execute('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
      if (!locked.length) throw bookingError('resource_not_found');
      const booking = await loadBooking(connection, bookingId);
      if (String(booking.userId) !== String(userId)) throw bookingError('forbidden');
      const now = await readDatabaseNow(connection);
      if (booking.status !== 'PENDIENTE_PAGO' || booking.paymentExpiresAt == null
        || booking.paymentExpiresAt <= now) throw bookingError('invalid_booking_state');
      const amountMinor = (booking.depositAmountMinor ?? 0) - (booking.amountPaidMinor ?? 0);
      if (amountMinor < 1) throw bookingError('invalid_booking_state');
      await connection.execute(`INSERT INTO payments (booking_id, user_id, amount_minor, currency, status, purpose,
        provider, provider_reference, created_at, updated_at) VALUES (?, ?, ?, 'COP', 'PENDIENTE', 'DEPOSITO', ?, ?, ?, ?)`,
      [bookingId, userId, amountMinor, provider, reference, toMySqlDateTime(now), toMySqlDateTime(now)]);
      return { amountMinor, expiresAt: booking.paymentExpiresAt };
    });
  }

  async function getLatestWompiTransaction({ bookingId, userId }) {
    const [rows] = await pool.execute(`SELECT p.wompi_transaction_id FROM payments AS p
      INNER JOIN bookings AS b ON b.id = p.booking_id WHERE p.booking_id = ? AND b.user_id = ?
      AND p.provider = 'WOMPI' AND p.wompi_transaction_id IS NOT NULL ORDER BY p.id DESC LIMIT 1`, [bookingId, userId]);
    return rows.length ? rows[0].wompi_transaction_id : null;
  }

  async function settlePayment({ provider, facts, eventId = null }) {
    return runTransactionWithRetry(pool, async (connection) => {
      if (eventId) {
        const now = await readDatabaseNow(connection);
        const [event] = await connection.execute(`INSERT IGNORE INTO payment_provider_events
          (provider, provider_event_id, received_at) VALUES (?, ?, ?)`, [provider, eventId, toMySqlDateTime(now)]);
        if (event.affectedRows === 0) return { changed: false, ignored: true };
      }
      const [payments] = await connection.execute(`SELECT * FROM payments WHERE provider = ? AND provider_reference = ? FOR UPDATE`,
        [provider, facts.reference]);
      if (!payments.length) return { changed: false, ignored: true };
      const payment = payments[0];
      const [bookings] = await connection.execute('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [payment.booking_id]);
      if (!bookings.length || Number(payment.amount_minor) !== facts.amountInCents || payment.currency !== facts.currency) {
        return { changed: false, ignored: true };
      }
      if (payment.wompi_transaction_id && payment.wompi_transaction_id !== facts.id) return { changed: false, ignored: true };
      const now = await readDatabaseNow(connection);
      const finalStatus = facts.status === 'APPROVED' ? 'APROBADO'
        : facts.status === 'DECLINED' || facts.status === 'VOIDED' ? 'RECHAZADO'
          : facts.status === 'ERROR' ? 'FALLIDO' : 'PENDIENTE';
      let finalizedAt = null;
      try { finalizedAt = facts.finalizedAt ? toInstantString(facts.finalizedAt) : null; } catch { return { changed: false, ignored: true }; }
      if (facts.status === 'APPROVED' && (!finalizedAt || !facts.id)) return { changed: false, ignored: true };
      const expiredAt = bookings[0].payment_expires_at == null ? null : toInstantString(bookings[0].payment_expires_at);
      const late = facts.status === 'APPROVED' && (!expiredAt || finalizedAt > expiredAt);
      const status = late ? 'REFUND_PENDING' : finalStatus;
      await connection.execute(`UPDATE payments SET status = ?, wompi_transaction_id = ?, provider_status = ?,
        finalized_at = ?, payment_method_type = ?, updated_at = ? WHERE id = ?`,
      [status, facts.id, facts.status, finalizedAt ? toMySqlDateTime(finalizedAt) : null, facts.paymentMethodType ?? null,
        toMySqlDateTime(now), payment.id]);
      if (late) {
        await connection.execute("UPDATE bookings SET payment_status = 'REFUND_PENDING' WHERE id = ?", [payment.booking_id]);
        return { changed: true, confirmed: false, refundPending: true };
      }
      if (facts.status !== 'APPROVED') return { changed: true, confirmed: false };
      if (bookings[0].status !== 'PENDIENTE_PAGO') return { changed: false, ignored: true };
      await connection.execute(`UPDATE bookings SET status = 'CONFIRMADA', payment_status = 'PAGADO',
        amount_paid_minor = amount_paid_minor + ?, payment_expires_at = NULL WHERE id = ?`, [payment.amount_minor, payment.booking_id]);
      return { changed: true, confirmed: true, booking: await loadBooking(connection, payment.booking_id) };
    });
  }

  async function listOperationalOwnerRecipients({ facilityId }) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT u.id, u.email
       FROM facility_memberships AS m
       INNER JOIN users AS u ON u.id = m.user_id
       INNER JOIN user_roles AS r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
       WHERE m.facility_id = ?
         AND m.membership_type = 'PROPIETARIO'
         AND m.active = 1
         AND u.deactivated_at IS NULL
         AND u.owner_suspended_at IS NULL`,
      [facilityId],
    );
    return rows.map((row) => ({ id: String(row.id), email: row.email }));
  }

  async function listOwnerBookings({ userId, facilityId, courtId, status,
    startFrom, startBefore, now, limit, cursor }) {
    const clauses = [
      'm.user_id = ?', 'm.active = 1', "m.membership_type = 'PROPIETARIO'",
      'owner.deactivated_at IS NULL', "owner_role.role_code = 'PROPIETARIO'",
    ];
    const values = [userId];
    if (facilityId) { clauses.push('f.id = ?'); values.push(facilityId); }
    if (courtId) { clauses.push('c.id = ?'); values.push(courtId); }
    if (startFrom) { clauses.push('b.start_at >= ?'); values.push(toMySqlDateTime(startFrom)); }
    if (startBefore) { clauses.push('b.start_at < ?'); values.push(toMySqlDateTime(startBefore)); }
    if (status === 'CANCELADA') clauses.push("b.status = 'CANCELADA'");
    if (status === 'PENDIENTE_PAGO') clauses.push("b.status = 'PENDIENTE_PAGO' AND b.payment_expires_at > UTC_TIMESTAMP(6)");
    if (status === 'COMPLETADA') {
      clauses.push("b.status = 'CONFIRMADA' AND b.end_at <= ?");
      values.push(toMySqlDateTime(now));
    }
    if (status === 'CONFIRMADA') {
      clauses.push("b.status = 'CONFIRMADA' AND b.end_at > ?");
      values.push(toMySqlDateTime(now));
    }
    if (cursor) {
      clauses.push('(b.start_at < ? OR (b.start_at = ? AND b.id < ?))');
      values.push(toMySqlDateTime(cursor.startAt), toMySqlDateTime(cursor.startAt), cursor.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
       `SELECT b.id, b.user_id, b.start_at, b.end_at, b.booking_timezone, b.status,
                b.price_amount_minor, b.price_currency, b.no_show_at, b.payment_status,
                b.deposit_percentage_snapshot, b.deposit_amount_minor, b.amount_paid_minor,
                b.payment_expires_at, b.voluntary_reschedule_count,
              c.id AS court_id, c.name AS court_name,
              f.id AS facility_id, f.name AS facility_name,
              customer.name AS customer_name
       FROM facility_memberships AS m
       JOIN users AS owner ON owner.id = m.user_id
       JOIN user_roles AS owner_role ON owner_role.user_id = owner.id
       JOIN facilities AS f ON f.id = m.facility_id
       JOIN courts AS c ON c.facility_id = f.id
       JOIN bookings AS b ON b.court_id = c.id
       JOIN users AS customer ON customer.id = b.user_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY b.start_at DESC, b.id DESC LIMIT ?`, values,
    );
    return rows.map((row) => ({
      id: String(row.id), status: row.status,
      startAt: toInstantString(row.start_at), endAt: toInstantString(row.end_at),
      timeZone: row.booking_timezone,
      court: { id: String(row.court_id), name: row.court_name },
      facility: { id: String(row.facility_id), name: row.facility_name },
      user: { id: String(row.user_id), name: row.customer_name },
      priceMinor: row.price_amount_minor == null ? null : Number(row.price_amount_minor),
       currency: row.price_currency,
       noShowAt: row.no_show_at == null ? null : toInstantString(row.no_show_at),
       paymentStatus: row.payment_status,
       depositPercentage: row.deposit_percentage_snapshot == null ? null : Number(row.deposit_percentage_snapshot),
       depositAmountMinor: row.deposit_amount_minor == null ? null : Number(row.deposit_amount_minor),
       amountPaidMinor: row.amount_paid_minor == null ? null : Number(row.amount_paid_minor),
       paymentExpiresAt: row.payment_expires_at == null ? null : toInstantString(row.payment_expires_at),
       voluntaryRescheduleCount: row.voluntary_reschedule_count == null ? null : Number(row.voluntary_reschedule_count),
    }));
  }

  async function cancelBooking({ userId, bookingId, decide }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initialRows] = await connection.execute(
        'SELECT court_id FROM bookings WHERE id = ?',
        [bookingId],
      );
      if (initialRows.length === 0) return null;

      const [courtLocks] = await connection.execute(
        'SELECT id FROM courts WHERE id = ? FOR UPDATE',
        [initialRows[0].court_id],
      );
      if (courtLocks.length !== 1) throw bookingError('internal_error');
      const [rows] = await connection.execute(
         `SELECT id, user_id, court_id, start_at, end_at, status, cancellation_min_minutes,
                cancelled_at, cancelled_by_user_id
         FROM bookings
         WHERE id = ?
         FOR UPDATE`,
        [bookingId],
      );
      if (rows.length === 0) return null;

      const now = await readDatabaseNow(connection);
      const bookingState = mapBookingState(rows[0]);
      const action = decide({ booking: bookingState, now });
      if (action === 'cancel') {
        const previous = await loadBooking(connection, bookingId);
        const outcome = (previous.amountPaidMinor ?? 0) > 0 ? 'NON_REFUNDABLE' : 'REFUND_ALLOWED';
        const [update] = await connection.execute(
          `UPDATE bookings
             SET status = 'CANCELADA', cancelled_at = ?, cancelled_by_user_id = ?,
                 cancellation_reason = 'CLIENTE_A_TIEMPO', economic_outcome = ?, payment_expires_at = NULL
            WHERE id = ? AND status IN ('CONFIRMADA', 'PENDIENTE_PAGO')`,
          [toMySqlDateTime(now), userId, outcome, bookingId],
        );
        if (update.affectedRows !== 1) throw bookingError('internal_error');
        await recordBookingChange(connection, { bookingId, actorUserId: userId,
          type: 'CANCELLED_BY_CUSTOMER', previous,
          outcome, now });
      }

      const booking = await loadBooking(connection, bookingId);
      if (!booking) throw bookingError('internal_error');
      return { booking, now, changed: action === 'cancel' };
    });
  }

  async function cancelExceptionBooking({ userId, bookingId }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute('SELECT court_id FROM bookings WHERE id = ?', [bookingId]);
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      const [locked] = await connection.execute('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
      if (!locked.length) throw bookingError('resource_not_found');
      const previous = await loadBooking(connection, bookingId);
      if (previous.userId !== userId) throw bookingError('forbidden');
      const now = await readDatabaseNow(connection);
      if (previous.status !== 'CONFIRMADA' || Temporal.Instant.compare(Temporal.Instant.from(now),
        Temporal.Instant.from(previous.startAt)) >= 0) throw bookingError('invalid_booking_state');
      const [approved] = await connection.execute(
        `SELECT id, category FROM booking_exception_requests WHERE booking_id = ?
         AND status = 'APROBADA' AND used_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`, [bookingId],
      );
      if (!approved.length) throw bookingError('booking_cancellation_window_closed');
      await connection.execute(
        `UPDATE bookings SET status = 'CANCELADA', cancelled_at = ?, cancelled_by_user_id = ?,
         cancellation_reason = 'CLIENTE_EXCEPCION', economic_outcome = 'REFUND_ALLOWED' WHERE id = ?`,
        [toMySqlDateTime(now), userId, bookingId],
      );
      await connection.execute(
        `UPDATE booking_exception_requests SET used_at = ?, economic_outcome = 'REFUND_ALLOWED' WHERE id = ?`,
        [toMySqlDateTime(now), approved[0].id],
      );
      await recordBookingChange(connection, { bookingId, actorUserId: userId, type: 'CANCELLED_BY_CUSTOMER',
        previous, reason: approved[0].category, outcome: 'REFUND_ALLOWED', now });
      return { booking: await loadBooking(connection, bookingId), now };
    });
  }

  async function listBookingChanges({ bookingId, userId }) {
    const [owned] = await pool.execute('SELECT id FROM bookings WHERE id = ? AND user_id = ?', [bookingId, userId]);
    if (!owned.length) return null;
    const [rows] = await pool.execute(
      `SELECT change_type, actor_user_id, previous_start_at, previous_end_at,
         new_start_at, new_end_at, previous_price_minor, new_price_minor, reason, reason_code,
        economic_outcome, created_at FROM booking_changes WHERE booking_id = ? ORDER BY id`, [bookingId],
    );
    return rows.map((row) => ({ type: row.change_type, actorUserId: String(row.actor_user_id),
      previousStartAt: row.previous_start_at == null ? null : toInstantString(row.previous_start_at),
      previousEndAt: row.previous_end_at == null ? null : toInstantString(row.previous_end_at),
      newStartAt: row.new_start_at == null ? null : toInstantString(row.new_start_at),
      newEndAt: row.new_end_at == null ? null : toInstantString(row.new_end_at),
      previousPriceMinor: row.previous_price_minor == null ? null : Number(row.previous_price_minor),
      newPriceMinor: row.new_price_minor == null ? null : Number(row.new_price_minor),
      reason: row.reason, reasonCode: row.reason_code,
      economicOutcome: row.economic_outcome, createdAt: toInstantString(row.created_at) }));
  }

  async function rescheduleBooking({ bookingId, userId, request, idempotencyKey, requestHash, decide, evaluate }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const claim = await claimIdempotency(connection, { userId, idempotencyKey, requestHash,
        operation: 'BOOKING_RESCHEDULE' });
      if (claim.existing) {
        if (!Buffer.from(claim.row.request_hash).equals(requestHash)) throw bookingError('invalid_idempotency_key_reuse');
        if (claim.row.outcome !== 'SUCCEEDED' || String(claim.row.booking_id) !== bookingId) {
          throw bookingError('invalid_idempotency_key_reuse');
        }
        return { booking: await loadBooking(connection, bookingId), replayed: true, now: await readDatabaseNow(connection) };
      }
      const [initial] = await connection.execute('SELECT court_id FROM bookings WHERE id = ?', [bookingId]);
      if (!initial.length) throw bookingError('resource_not_found');
      const courtId = String(initial[0].court_id);
      const [locks] = await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [courtId]);
      if (!locks.length) throw bookingError('resource_not_found');
      const [locked] = await connection.execute('SELECT id FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
      if (!locked.length) throw bookingError('resource_not_found');
      const previous = await loadBooking(connection, bookingId);
      const now = await readDatabaseNow(connection);
      if (previous.userId !== userId) throw bookingError('forbidden');
      const [exceptions] = await connection.execute(
        `SELECT id FROM booking_exception_requests WHERE booking_id = ?
         AND status = 'APROBADA' AND used_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`, [bookingId],
      );
      const useException = decide({ booking: previous, now, exceptionApproved: exceptions.length > 0 });
      const durationMinutes = Temporal.Instant.from(previous.startAt).until(previous.endAt).total('minutes');
      const snapshot = await loadAvailabilityContext(connection, {
        courtId, date: request.localDate, lockCourt: false,
      });
      if (!snapshot || isPublicCourt && !await isPublicCourt(connection, courtId, { requirePrice: false })) {
        throw bookingError('resource_not_found');
      }
      const context = { ...snapshot.context, bookings: snapshot.context.bookings.filter((item) => item.id !== bookingId) };
      const decision = evaluate({ context, now, request, durationMinutes });
      if (!decision.accepted) throw bookingError(decision.code);
      if (toInstantString(decision.option.startAt) === previous.startAt) throw bookingError('invalid_booking_option');
      const [prices] = await connection.execute(
        'SELECT price_amount_minor, currency FROM court_prices WHERE court_id = ? AND duration_minutes = ?',
        [courtId, durationMinutes],
      );
      const currentPrice = prices[0] == null ? null : Number(prices[0].price_amount_minor);
      if (currentPrice !== request.expectedPriceMinor || prices[0]?.currency !== 'COP' || request.currency !== 'COP') {
        throw bookingError('booking_price_changed', { details: { currentPriceMinor: currentPrice, currency: 'COP' } });
      }
      const nextDeposit = Math.ceil(currentPrice * previous.depositPercentage / 100);
      const surplus = Math.max(0, previous.amountPaidMinor - nextDeposit);
      await connection.execute(
        `UPDATE bookings SET start_at = ?, end_at = ?, price_amount_minor = ?, price_currency = 'COP',
           deposit_amount_minor = ?, payment_status = ?, voluntary_reschedule_count = voluntary_reschedule_count + ?
         WHERE id = ? AND status = 'CONFIRMADA'`,
        [toMySqlDateTime(decision.option.startAt), toMySqlDateTime(decision.option.endAt), currentPrice,
          nextDeposit, previous.amountPaidMinor >= nextDeposit ? 'PAGADO' : 'PENDIENTE',
          useException ? 0 : 1, bookingId],
      );
      const [credited] = await connection.execute(
        `SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM customer_credit_ledger
         WHERE booking_id = ? AND reason = 'RESCHEDULE_SURPLUS' FOR UPDATE`, [bookingId],
      );
      const additionalCredit = Math.max(0, surplus - Number(credited[0].amount));
      if (additionalCredit > 0) await grantCredit(connection, { facilityId: previous.facility.id,
        userId, bookingId, amountMinor: additionalCredit, now });
      if (useException) await connection.execute(
        'UPDATE booking_exception_requests SET used_at = ? WHERE id = ? AND used_at IS NULL',
        [toMySqlDateTime(now), exceptions[0].id],
      );
      const booking = await loadBooking(connection, bookingId);
      await recordBookingChange(connection, { bookingId, actorUserId: userId, type: 'RESCHEDULED',
        previous, next: booking, outcome: useException ? 'RESCHEDULE_PRIORITY' : 'NOT_APPLICABLE', now });
      const [updated] = await connection.execute(
        `UPDATE idempotency_records SET outcome = 'SUCCEEDED', booking_id = ?, completed_at = ?
         WHERE id = ? AND outcome IS NULL`, [bookingId, toMySqlDateTime(now), claim.id],
      );
      if (updated.affectedRows !== 1) throw bookingError('internal_error');
      return { booking, previous, replayed: false, now };
    });
  }

  async function requestBookingException({ bookingId, userId, category, note }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute('SELECT court_id FROM bookings WHERE id = ?', [bookingId]);
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      const booking = await loadBooking(connection, bookingId);
      if (booking.userId !== userId) throw bookingError('forbidden');
      const now = await readDatabaseNow(connection);
      if (booking.status !== 'CONFIRMADA' || booking.noShowAt || Temporal.Instant.compare(Temporal.Instant.from(now),
        Temporal.Instant.from(booking.endAt)) >= 0) throw bookingError('invalid_booking_state');
      const [pending] = await connection.execute(
        "SELECT id FROM booking_exception_requests WHERE booking_id = ? AND status = 'PENDIENTE' FOR UPDATE", [bookingId],
      );
      if (pending.length) throw bookingError('booking_exception_pending');
      const [insert] = await connection.execute(
        `INSERT INTO booking_exception_requests (booking_id, category, note, status, requested_by_user_id, requested_at)
         VALUES (?, ?, ?, 'PENDIENTE', ?, ?)`, [bookingId, category, note ?? null, userId, toMySqlDateTime(now)],
      );
      return { id: String(insert.insertId), bookingId, category, status: 'PENDIENTE', requestedAt: now };
    });
  }

  async function decideBookingException({ exceptionId, ownerUserId, decision }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute(
        `SELECT c.id AS court_id, c.facility_id FROM booking_exception_requests AS e
         JOIN bookings AS b ON b.id = e.booking_id JOIN courts AS c ON c.id = b.court_id WHERE e.id = ?`, [exceptionId],
      );
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      await requireActiveMembership(connection, { facilityId: initial[0].facility_id, userId: ownerUserId, lock: true });
      const [rows] = await connection.execute(
        'SELECT booking_id, category, status FROM booking_exception_requests WHERE id = ? FOR UPDATE', [exceptionId],
      );
      if (rows[0].status !== 'PENDIENTE') throw bookingError('invalid_booking_state');
      const booking = await loadBooking(connection, rows[0].booking_id);
      if (booking.status !== 'CONFIRMADA' || booking.noShowAt) throw bookingError('invalid_booking_state');
      const now = await readDatabaseNow(connection);
      await connection.execute(
        `UPDATE booking_exception_requests SET status = ?, resolved_by_user_id = ?, resolved_at = ?,
         economic_outcome = ? WHERE id = ?`,
        [decision, ownerUserId, toMySqlDateTime(now),
          decision === 'APROBADA' ? 'RESCHEDULE_PRIORITY' : 'NOT_APPLICABLE', exceptionId],
      );
      return { exception: { id: exceptionId, bookingId: booking.id, category: rows[0].category,
        status: decision }, booking };
    });
  }

  async function listOwnerExceptions({ ownerUserId }) {
    const [rows] = await pool.execute(
      `SELECT e.id, e.booking_id, e.category, e.note, e.status, e.requested_at,
        c.name AS court_name, f.name AS facility_name, u.name AS customer_name
       FROM booking_exception_requests AS e
       JOIN bookings AS b ON b.id = e.booking_id
       JOIN courts AS c ON c.id = b.court_id
       JOIN facilities AS f ON f.id = c.facility_id
       JOIN users AS u ON u.id = b.user_id
       JOIN facility_memberships AS m ON m.facility_id = f.id AND m.user_id = ?
         AND m.active = 1 AND m.membership_type = 'PROPIETARIO'
       JOIN users AS owner ON owner.id = m.user_id AND owner.deactivated_at IS NULL
         AND owner.owner_suspended_at IS NULL
       JOIN user_roles AS r ON r.user_id = owner.id AND r.role_code = 'PROPIETARIO'
       WHERE e.status = 'PENDIENTE' ORDER BY e.requested_at DESC, e.id DESC LIMIT 100`, [ownerUserId],
    );
    return rows.map((row) => ({ id: String(row.id), bookingId: String(row.booking_id),
      category: row.category, note: row.note, status: row.status, requestedAt: toInstantString(row.requested_at),
      courtName: row.court_name, facilityName: row.facility_name, customerName: row.customer_name }));
  }

  async function cancelOwnerBooking({ bookingId, ownerUserId, reason, reasonCode }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute(
        'SELECT c.id AS court_id, c.facility_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?', [bookingId],
      );
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      await requireActiveMembership(connection, { facilityId: initial[0].facility_id, userId: ownerUserId, lock: true });
      const booking = await loadBooking(connection, bookingId);
      const now = await readDatabaseNow(connection);
      if (booking.status !== 'CONFIRMADA' || Temporal.Instant.compare(Temporal.Instant.from(now),
        Temporal.Instant.from(booking.endAt)) >= 0 || booking.noShowAt) throw bookingError('invalid_booking_state');
      await connection.execute(
        `UPDATE bookings SET status = 'CANCELADA', cancelled_at = ?, cancelled_by_user_id = ?,
         cancellation_reason = 'CANCELLED_BY_OWNER', economic_outcome = 'FULL_REFUND_OR_RESCHEDULE'
         WHERE id = ? AND status = 'CONFIRMADA'`, [toMySqlDateTime(now), ownerUserId, bookingId],
      );
      await recordBookingChange(connection, { bookingId, actorUserId: ownerUserId, type: 'CANCELLED_BY_OWNER',
        previous: booking, reason, reasonCode, outcome: 'FULL_REFUND_OR_RESCHEDULE', now });
      return { booking: await loadBooking(connection, bookingId), reason };
    });
  }

  async function markNoShow({ bookingId, ownerUserId }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [initial] = await connection.execute(
        'SELECT c.id AS court_id, c.facility_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?', [bookingId],
      );
      if (!initial.length) throw bookingError('resource_not_found');
      await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [initial[0].court_id]);
      await requireActiveMembership(connection, { facilityId: initial[0].facility_id, userId: ownerUserId, lock: true });
      const booking = await loadBooking(connection, bookingId);
      const now = await readDatabaseNow(connection);
      if (booking.status !== 'CONFIRMADA') throw bookingError('invalid_booking_state');
      if (Temporal.Instant.compare(Temporal.Instant.from(now), Temporal.Instant.from(booking.startAt)) < 0) {
        throw bookingError('booking_not_started');
      }
      if (booking.noShowAt) return { booking, changed: false };
      await connection.execute(
        `UPDATE bookings SET no_show_at = ?, no_show_by_user_id = ?, economic_outcome = 'NON_REFUNDABLE'
         WHERE id = ? AND no_show_at IS NULL`, [toMySqlDateTime(now), ownerUserId, bookingId],
      );
      await recordBookingChange(connection, { bookingId, actorUserId: ownerUserId,
        type: 'NO_SHOW', previous: booking, outcome: 'NON_REFUNDABLE', now });
      return { booking: await loadBooking(connection, bookingId), changed: true };
    });
  }

  async function updateCancellationPolicy({ courtId, ownerUserId, minutes }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [courts] = await connection.execute(
        'SELECT id, facility_id, cancellation_min_minutes FROM courts WHERE id = ? FOR UPDATE', [courtId],
      );
      if (!courts.length) throw bookingError('resource_not_found');
      await requireActiveMembership(connection, { facilityId: courts[0].facility_id, userId: ownerUserId, lock: true });
      const changed = Number(courts[0].cancellation_min_minutes) !== minutes;
      if (changed) await connection.execute('UPDATE courts SET cancellation_min_minutes = ? WHERE id = ?', [minutes, courtId]);
      return { courtId, cancellationMinMinutes: minutes, changed };
    });
  }

  async function updateDepositPolicy({ courtId, ownerUserId, percentage }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const [courts] = await connection.execute(
        'SELECT id, facility_id, deposit_percentage FROM courts WHERE id = ? FOR UPDATE', [courtId],
      );
      if (!courts.length) throw bookingError('resource_not_found');
      await requireActiveMembership(connection, { facilityId: courts[0].facility_id, userId: ownerUserId, lock: true });
      const changed = Number(courts[0].deposit_percentage) !== percentage;
      if (changed) await connection.execute('UPDATE courts SET deposit_percentage = ? WHERE id = ?', [percentage, courtId]);
      return { courtId, depositPercentage: percentage, changed };
    });
  }

  async function replaceFacilityBookingPolicy({
    facilityId,
    policy,
    actorUserId,
    ownerUserId,
    now,
  }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const facility = await lockFacility(connection, facilityId);
      if (!facility) return null;
      if (ownerUserId) await requireActiveMembership(connection, { facilityId, userId: ownerUserId, lock: true });
      if (facility.deactivated_at != null) throw bookingError('resource_inactive');
      const courts = await lockFacilityCourts(connection, facilityId);
      const next = {
        timeZone: policy.timeZone ?? policy.timezone,
        minimumAdvanceMinutes: Number(policy.minimumAdvanceMinutes),
        maximumAdvanceMinutes: Number(policy.maximumAdvanceMinutes),
      };
      assertBookingPolicy(next);
      const changed = facility.timezone !== next.timeZone
        || Number(facility.minimum_advance_minutes) !== next.minimumAdvanceMinutes
        || Number(facility.maximum_advance_minutes) !== next.maximumAdvanceMinutes;
      if (!changed) {
        return { facility: mapAdminFacility(facility), operation: unchangedOperation() };
      }
      if (facility.timezone !== next.timeZone && await hasFacilityTemporalData(connection, facilityId)) {
        throw bookingError('facility_time_zone_locked');
      }

      await connection.execute(
        `UPDATE facilities
         SET timezone = ?, minimum_advance_minutes = ?, maximum_advance_minutes = ?
         WHERE id = ?`,
        [next.timeZone, next.minimumAdvanceMinutes, next.maximumAdvanceMinutes, facilityId],
      );
      const changes = [];
      const advanceChanged = Number(facility.minimum_advance_minutes) !== next.minimumAdvanceMinutes
        || Number(facility.maximum_advance_minutes) !== next.maximumAdvanceMinutes;
      if (advanceChanged) {
        for (const court of courts.filter((row) => row.deactivated_at == null)) {
          changes.push(await createOperationalChange(connection, {
            courtId: court.id,
            actorUserId,
            type: 'FACILITY_BOOKING_POLICY_REPLACED',
            now,
          }));
        }
      }
      return {
        facility: mapAdminFacility({
          ...facility,
          timezone: next.timeZone,
          minimum_advance_minutes: next.minimumAdvanceMinutes,
          maximum_advance_minutes: next.maximumAdvanceMinutes,
        }),
        operation: changedOperation(changes),
      };
    });
  }

  async function deactivateFacility({ facilityId, actorUserId, ownerUserId, now }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const facility = await lockFacility(connection, facilityId);
      if (!facility) return null;
      if (ownerUserId) await requireActiveMembership(connection, { facilityId, userId: ownerUserId, lock: true });
      if (facility.deactivated_at != null) {
        return { facility: mapAdminFacility(facility), operation: unchangedOperation() };
      }
      const courts = await lockFacilityCourts(connection, facilityId);
      if (await hasProtectedBookings(connection, courts.map((court) => court.id), now)) {
        throw bookingError('future_bookings_prevent_deactivation');
      }
      await connection.execute(
        'UPDATE facilities SET deactivated_at = ? WHERE id = ?',
        [toMySqlDateTime(now), facilityId],
      );
      const changes = [];
      for (const court of courts.filter((row) => row.deactivated_at == null)) {
        changes.push(await createOperationalChange(connection, {
          courtId: court.id,
          actorUserId,
          type: 'FACILITY_DEACTIVATED',
          now,
        }));
      }
      return {
        facility: mapAdminFacility({ ...facility, deactivated_at: now }),
        operation: changedOperation(changes),
      };
    });
  }

  async function createCourt({ facilityId, court, actorUserId, ownerUserId, now }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const facility = await lockFacility(connection, facilityId);
      if (!facility) return null;
      if (ownerUserId) await requireActiveMembership(connection, { facilityId, userId: ownerUserId, lock: true });
      if (facility.deactivated_at != null) throw bookingError('resource_inactive');
      const durations = normalizedDurations(court.allowedDurationsMinutes);
      assertCourtConfiguration(court);
      const [insert] = await connection.execute(
        `INSERT INTO courts
           (facility_id, name, description, minimum_separation_minutes,
           start_interval_minutes, created_at, sport_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          facilityId,
          court.name,
          court.description ?? null,
          court.minimumSeparationMinutes,
          court.startIntervalMinutes,
          toMySqlDateTime(now),
          court.sportCode ?? null,
        ],
      );
      const courtId = String(insert.insertId);
      for (const duration of durations) {
        await connection.execute(
          'INSERT INTO court_allowed_durations (court_id, duration_minutes) VALUES (?, ?)',
          [courtId, duration],
        );
      }
      const change = await createOperationalChange(connection, {
        courtId,
        actorUserId,
        type: 'COURT_CREATED',
        now,
      });
      return {
        court: mapAdminCourt({
          id: courtId,
          facility_id: facility.id,
          facility_name: facility.name,
          name: court.name,
           description: court.description ?? null,
          sport_code: court.sportCode ?? null,
           minimum_separation_minutes: court.minimumSeparationMinutes,
           cancellation_min_minutes: 120,
          start_interval_minutes: court.startIntervalMinutes,
          created_at: now,
          deactivated_at: null,
          durations,
        }),
        operation: changedOperation([change]),
      };
    });
  }

  async function getCourtBookingConfiguration({ courtId }) {
    const court = await loadAdminCourt(pool, courtId);
    return court == null ? null : presentBookingConfiguration(court);
  }

  async function replaceCourtBookingConfiguration({
    courtId,
    bookingConfiguration,
    actorUserId,
    ownerUserId,
    now,
    assessExistingBooking,
  }) {
    return mutateCourtAvailability({
      pool,
      courtId,
      actorUserId,
      ownerUserId,
      now,
      assessExistingBooking,
      changeType: 'COURT_BOOKING_CONFIGURATION_REPLACED',
      async prepare(connection, court) {
        const durations = normalizedDurations(bookingConfiguration.allowedDurationsMinutes);
        const currentDurations = await loadDurations(connection, courtId);
        const next = {
          minimumSeparationMinutes: Number(bookingConfiguration.minimumSeparationMinutes),
          startIntervalMinutes: Number(bookingConfiguration.startIntervalMinutes),
          allowedDurationsMinutes: durations,
        };
        assertCourtConfiguration(next);
        return {
          changed: Number(court.minimum_separation_minutes) !== next.minimumSeparationMinutes
            || Number(court.start_interval_minutes) !== next.startIntervalMinutes
            || !arraysEqual(currentDurations, durations),
          result: next,
          async write() {
            await connection.execute(
              `UPDATE courts SET minimum_separation_minutes = ?, start_interval_minutes = ?
               WHERE id = ?`,
              [next.minimumSeparationMinutes, next.startIntervalMinutes, courtId],
            );
            for (const duration of currentDurations.filter((value) => !durations.includes(value))) {
              await connection.execute('DELETE FROM court_prices WHERE court_id = ? AND duration_minutes = ?',
                [courtId, duration]);
              await connection.execute('DELETE FROM court_allowed_durations WHERE court_id = ? AND duration_minutes = ?',
                [courtId, duration]);
            }
            for (const duration of durations.filter((value) => !currentDurations.includes(value))) {
              await connection.execute(
                'INSERT INTO court_allowed_durations (court_id, duration_minutes) VALUES (?, ?)',
                [courtId, duration],
              );
            }
          },
          present(value, operation) {
            return { bookingConfiguration: { courtId: String(courtId), ...value }, operation };
          },
        };
      },
    });
  }

  async function getWeeklySchedule({ courtId }) {
    const court = await loadAdminCourt(pool, courtId);
    if (!court) return null;
    return { courtId: String(courtId), periods: await loadWeeklyPeriods(pool, courtId) };
  }

  async function replaceWeeklySchedule({
    courtId,
    weeklySchedule,
    actorUserId,
    ownerUserId,
    now,
    assessExistingBooking,
  }) {
    return mutateCourtAvailability({
      pool,
      courtId,
      actorUserId,
      ownerUserId,
      now,
      assessExistingBooking,
      changeType: 'WEEKLY_SCHEDULE_REPLACED',
      async prepare(connection) {
        const periods = normalizedWeeklyPeriods(weeklySchedule.periods);
        const current = await loadWeeklyPeriods(connection, courtId);
        return {
          changed: !objectsEqual(current, periods),
          result: { courtId: String(courtId), periods },
          async write() {
            await connection.execute('DELETE FROM court_weekly_periods WHERE court_id = ?', [courtId]);
            for (const period of periods) {
              await connection.execute(
                `INSERT INTO court_weekly_periods (court_id, weekday, start_time, end_time)
                 VALUES (?, ?, ?, ?)`,
                [courtId, period.weekday, period.startTime, period.endTime],
              );
            }
          },
          present(value, operation) {
            return { weeklySchedule: value, operation };
          },
        };
      },
    });
  }

  async function listDateExceptions({ courtId, limit, cursor }) {
    if (!await courtExists(pool, courtId)) return null;
    const values = [courtId];
    let cursorClause = '';
    if (cursor) {
      cursorClause = ' AND de.local_date < ?';
      values.push(cursor.localDate);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `SELECT de.id, de.court_id, DATE_FORMAT(de.local_date, '%Y-%m-%d') AS local_date, de.mode
       FROM court_date_exceptions AS de
       WHERE de.court_id = ?${cursorClause}
       ORDER BY de.local_date DESC
       LIMIT ?`,
      values,
    );
    return Promise.all(rows.map((row) => mapDateExceptionWithPeriods(pool, row)));
  }

  async function getDateException({ courtId, localDate }) {
    if (!await courtExists(pool, courtId)) return null;
    return loadDateException(pool, courtId, localDate);
  }

  async function putDateException({
    courtId,
    localDate,
    dateException,
    actorUserId,
    ownerUserId,
    now,
    assessExistingBooking,
  }) {
    return mutateCourtAvailability({
      pool,
      courtId,
      actorUserId,
      ownerUserId,
      now,
      assessExistingBooking,
      changeType: 'DATE_EXCEPTION_PUT',
      bookingWhere: 'AND DATE(CONVERT_TZ(b.start_at, \'UTC\', ?)) = ?',
      bookingWhereValues(court) { return [court.timezone, localDate]; },
      async prepare(connection, court) {
        assertCurrentOrFutureLocalDate(localDate, court.timezone, now);
        const value = normalizedDateException(courtId, localDate, dateException);
        assertValidExceptionTimes(value, court.timezone);
        const current = await loadDateException(connection, courtId, localDate);
        return {
          changed: !objectsEqual(current, value),
          result: value,
          async write() {
            let exceptionId;
            if (current) {
              const [rows] = await connection.execute(
                'SELECT id FROM court_date_exceptions WHERE court_id = ? AND local_date = ?',
                [courtId, localDate],
              );
              exceptionId = String(rows[0].id);
              await connection.execute('DELETE FROM court_exception_periods WHERE exception_id = ?', [exceptionId]);
              await connection.execute('UPDATE court_date_exceptions SET mode = ? WHERE id = ?', [value.mode, exceptionId]);
            } else {
              const [insert] = await connection.execute(
                'INSERT INTO court_date_exceptions (court_id, local_date, mode) VALUES (?, ?, ?)',
                [courtId, localDate, value.mode],
              );
              exceptionId = String(insert.insertId);
            }
            for (const period of value.periods) {
              await connection.execute(
                `INSERT INTO court_exception_periods (exception_id, start_time, end_time)
                 VALUES (?, ?, ?)`,
                [exceptionId, period.startTime, period.endTime],
              );
            }
          },
          present(result, operation) { return { dateException: result, operation }; },
        };
      },
    });
  }

  async function deleteDateException({
    courtId,
    localDate,
    actorUserId,
    ownerUserId,
    now,
    assessExistingBooking,
  }) {
    return mutateCourtAvailability({
      pool,
      courtId,
      actorUserId,
      ownerUserId,
      now,
      assessExistingBooking,
      changeType: 'DATE_EXCEPTION_DELETED',
      bookingWhere: 'AND DATE(CONVERT_TZ(b.start_at, \'UTC\', ?)) = ?',
      bookingWhereValues(court) { return [court.timezone, localDate]; },
      async prepare(connection, court) {
        assertCurrentOrFutureLocalDate(localDate, court.timezone, now);
        const [rows] = await connection.execute(
          'SELECT id FROM court_date_exceptions WHERE court_id = ? AND local_date = ?',
          [courtId, localDate],
        );
        if (rows.length === 0) throw bookingError('resource_not_found');
        return {
          changed: true,
          result: null,
          async write() {
            await connection.execute('DELETE FROM court_exception_periods WHERE exception_id = ?', [rows[0].id]);
            await connection.execute('DELETE FROM court_date_exceptions WHERE id = ?', [rows[0].id]);
          },
          present(_result, operation) { return { dateException: null, operation }; },
        };
      },
    });
  }

  async function listUnavailabilities({ courtId, limit, cursor }) {
    if (!await courtExists(pool, courtId)) return null;
    const values = [courtId];
    let cursorClause = '';
    if (cursor) {
      cursorClause = ' AND (cu.start_at < ? OR (cu.start_at = ? AND cu.id < ?))';
      const startAt = toMySqlDateTime(cursor.startAt);
      values.push(startAt, startAt, cursor.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `${unavailabilitySelect()} WHERE cu.court_id = ?${cursorClause}
       ORDER BY cu.start_at DESC, cu.id DESC LIMIT ?`,
      values,
    );
    return rows.map(mapUnavailability);
  }

  async function createUnavailability({
    courtId,
    unavailability,
    actorUserId,
    ownerUserId,
    now,
    assessExistingBooking,
  }) {
    assertUnavailability(unavailability, now);
    return mutateCourtAvailability({
      pool,
      courtId,
      actorUserId,
      ownerUserId,
      now,
      assessExistingBooking,
      changeType: 'UNAVAILABILITY_CREATED',
      bookingWhere: 'AND b.start_at < ? AND b.end_at > ?',
      bookingWhereValues() {
        return [toMySqlDateTime(unavailability.endAt), toMySqlDateTime(unavailability.startAt)];
      },
      async prepare(connection) {
        let created;
        return {
          changed: true,
          get result() { return created; },
          async write() {
            const [insert] = await connection.execute(
              `INSERT INTO court_unavailabilities
                 (court_id, type, start_at, end_at, reason, created_by_user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                courtId,
                unavailability.type,
                toMySqlDateTime(unavailability.startAt),
                toMySqlDateTime(unavailability.endAt),
                unavailability.reason ?? null,
                actorUserId,
                toMySqlDateTime(now),
              ],
            );
            created = {
              id: String(insert.insertId),
              courtId: String(courtId),
              type: unavailability.type,
              startAt: toInstantString(unavailability.startAt),
              endAt: toInstantString(unavailability.endAt),
              reason: unavailability.reason ?? null,
              createdByUserId: String(actorUserId),
              createdAt: now,
            };
          },
          present(_result, operation) { return { unavailability: created, operation }; },
        };
      },
    });
  }

  async function getUnavailability({ unavailabilityId }) {
    const [rows] = await pool.execute(
      `${unavailabilitySelect()} WHERE cu.id = ?`,
      [unavailabilityId],
    );
    return rows.length === 0 ? null : mapUnavailability(rows[0]);
  }

  async function deactivateCourt({ courtId, actorUserId, ownerUserId, now }) {
    return runTransactionWithRetry(pool, async (connection) => {
      const court = await lockAdminCourt(connection, courtId);
      if (!court) return null;
      if (ownerUserId) await requireActiveMembership(connection, {
        facilityId: court.facility_id, userId: ownerUserId, lock: true,
      });
      if (court.deactivated_at != null) {
        return { court: mapAdminCourt(court), operation: unchangedOperation() };
      }
      if (court.facility_deactivated_at != null) throw bookingError('resource_inactive');
      if (await hasProtectedBookings(connection, [courtId], now)) {
        throw bookingError('future_bookings_prevent_deactivation');
      }
      await connection.execute(
        'UPDATE courts SET deactivated_at = ? WHERE id = ?',
        [toMySqlDateTime(now), courtId],
      );
      const change = await createOperationalChange(connection, {
        courtId,
        actorUserId,
        type: 'COURT_DEACTIVATED',
        now,
      });
      return {
        court: mapAdminCourt({ ...court, deactivated_at: now }),
        operation: changedOperation([change]),
      };
    });
  }

  async function listOperationalConflicts({
    courtId,
    bookingId,
    operationalChangeId,
    limit,
    cursor,
  }) {
    const conditions = [];
    const values = [];
    if (courtId !== undefined) { conditions.push('oc.court_id = ?'); values.push(courtId); }
    if (bookingId !== undefined) { conditions.push('cf.booking_id = ?'); values.push(bookingId); }
    if (operationalChangeId !== undefined) {
      conditions.push('cf.operational_change_id = ?');
      values.push(operationalChangeId);
    }
    if (cursor) {
      conditions.push('(cf.detected_at < ? OR (cf.detected_at = ? AND cf.id < ?))');
      const detectedAt = toMySqlDateTime(cursor.detectedAt);
      values.push(detectedAt, detectedAt, cursor.id);
    }
    values.push(limit);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const [rows] = await pool.execute(
      `${operationalConflictSelect()} ${where}
       ORDER BY cf.detected_at DESC, cf.id DESC LIMIT ?`,
      values,
    );
    return rows.map(mapOperationalConflict);
  }

  async function getOperationalConflict({ conflictId }) {
    const [rows] = await pool.execute(
      `${operationalConflictSelect()} WHERE cf.id = ?`,
      [conflictId],
    );
    return rows.length === 0 ? null : mapOperationalConflict(rows[0]);
  }

}

async function mutateCourtAvailability({
  pool,
  courtId,
  actorUserId,
  ownerUserId,
  now,
  assessExistingBooking,
  changeType,
  prepare,
  bookingWhere = '',
  bookingWhereValues = () => [],
}) {
  return runTransactionWithRetry(pool, async (connection) => {
    const court = await lockAdminCourt(connection, courtId);
    if (!court) return null;
    if (ownerUserId) await requireActiveMembership(connection, {
      facilityId: court.facility_id, userId: ownerUserId, lock: true,
    });
    if (court.deactivated_at != null || court.facility_deactivated_at != null) {
      throw bookingError('resource_inactive');
    }
    const mutation = await prepare(connection, court);
    if (!mutation.changed) {
      return mutation.present(mutation.result, unchangedOperation());
    }

    const bookings = await loadAssessmentBookings(
      connection,
      courtId,
      bookingWhere,
      bookingWhereValues(court),
    );
    const before = [];
    for (const booking of bookings) {
      const context = await loadBookingAssessmentContext(connection, court, booking);
      before.push(assessExistingBooking({ context, booking }));
    }

    await mutation.write();
    const conflicts = [];
    for (let index = 0; index < bookings.length; index += 1) {
      const context = await loadBookingAssessmentContext(connection, court, bookings[index]);
      const after = assessExistingBooking({ context, booking: bookings[index] });
      if (
        before[index]?.applicable
        && before[index].compatible
        && after?.applicable
        && !after.compatible
      ) conflicts.push(bookings[index].id);
    }

    const change = await createOperationalChange(connection, {
      courtId,
      actorUserId,
      type: changeType,
      now,
    });
    for (const bookingId of conflicts) {
      await connection.execute(
        `INSERT INTO operational_conflicts
           (operational_change_id, booking_id, detected_at)
         VALUES (?, ?, ?)`,
        [change.id, bookingId, toMySqlDateTime(now)],
      );
    }
    change.conflictsCreated = conflicts.length;
    return mutation.present(mutation.result, changedOperation([change]));
  });
}

async function lockFacility(connection, facilityId) {
  const [rows] = await connection.execute(
    `SELECT id, name, timezone, minimum_advance_minutes, maximum_advance_minutes,
            created_at, deactivated_at
     FROM facilities WHERE id = ? FOR UPDATE`,
    [facilityId],
  );
  return rows[0] ?? null;
}

async function lockFacilityCourts(connection, facilityId) {
  const [rows] = await connection.execute(
    `SELECT id, deactivated_at FROM courts
     WHERE facility_id = ? ORDER BY id ASC FOR UPDATE`,
    [facilityId],
  );
  return rows;
}

async function lockAdminCourt(connection, courtId) {
  const [locks] = await connection.execute(
    'SELECT id FROM courts WHERE id = ? FOR UPDATE',
    [courtId],
  );
  if (locks.length === 0) return null;
  return loadAdminCourt(connection, courtId);
}

async function loadAdminCourt(executor, courtId) {
  const [rows] = await executor.execute(
    `SELECT c.id, c.facility_id, c.name, c.description, c.sport_code,
              c.minimum_separation_minutes, c.start_interval_minutes, c.cancellation_min_minutes, c.deposit_percentage,
            c.created_at, c.deactivated_at, f.name AS facility_name,
            f.timezone, f.minimum_advance_minutes, f.maximum_advance_minutes,
            f.deactivated_at AS facility_deactivated_at
     FROM courts AS c
     INNER JOIN facilities AS f ON f.id = c.facility_id
     WHERE c.id = ?`,
    [courtId],
  );
  if (rows.length === 0) return null;
  return { ...rows[0], durations: await loadDurations(executor, courtId) };
}

async function courtExists(executor, courtId) {
  const [rows] = await executor.execute('SELECT id FROM courts WHERE id = ?', [courtId]);
  return rows.length !== 0;
}

async function loadDurations(executor, courtId) {
  const [rows] = await executor.execute(
    `SELECT duration_minutes FROM court_allowed_durations
     WHERE court_id = ? ORDER BY duration_minutes`,
    [courtId],
  );
  return rows.map((row) => Number(row.duration_minutes));
}

async function loadWeeklyPeriods(executor, courtId) {
  const [rows] = await executor.execute(
    `SELECT weekday, TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
            TIME_FORMAT(end_time, '%H:%i:%s') AS end_time
     FROM court_weekly_periods WHERE court_id = ?
     ORDER BY weekday, start_time, id`,
    [courtId],
  );
  return rows.map((row) => ({
    weekday: Number(row.weekday),
    startTime: row.start_time,
    endTime: row.end_time,
  }));
}

async function loadDateException(executor, courtId, localDate) {
  const [rows] = await executor.execute(
    `SELECT id, court_id, DATE_FORMAT(local_date, '%Y-%m-%d') AS local_date, mode
     FROM court_date_exceptions WHERE court_id = ? AND local_date = ?`,
    [courtId, localDate],
  );
  return rows.length === 0 ? null : mapDateExceptionWithPeriods(executor, rows[0]);
}

async function mapDateExceptionWithPeriods(executor, row) {
  const [periods] = await executor.execute(
    `SELECT TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
            TIME_FORMAT(end_time, '%H:%i:%s') AS end_time
     FROM court_exception_periods WHERE exception_id = ? ORDER BY start_time, id`,
    [row.id],
  );
  return {
    courtId: String(row.court_id),
    localDate: row.local_date,
    mode: row.mode,
    periods: periods.map(mapPeriod),
  };
}

async function hasFacilityTemporalData(connection, facilityId) {
  const [rows] = await connection.execute(
    `SELECT EXISTS (
       SELECT 1 FROM courts AS c WHERE c.facility_id = ? AND (
         EXISTS (SELECT 1 FROM court_weekly_periods p WHERE p.court_id = c.id)
         OR EXISTS (SELECT 1 FROM court_date_exceptions e WHERE e.court_id = c.id)
         OR EXISTS (SELECT 1 FROM court_allowed_durations d WHERE d.court_id = c.id)
         OR EXISTS (SELECT 1 FROM bookings b WHERE b.court_id = c.id)
         OR EXISTS (SELECT 1 FROM court_unavailabilities u WHERE u.court_id = c.id)
         OR EXISTS (SELECT 1 FROM operational_changes o WHERE o.court_id = c.id)
       )
     ) AS present`,
    [facilityId],
  );
  return Boolean(rows[0].present);
}

async function hasProtectedBookings(connection, courtIds, now) {
  if (courtIds.length === 0) return false;
  const placeholders = courtIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT EXISTS (
       SELECT 1 FROM bookings
       WHERE court_id IN (${placeholders})
         AND status = 'CONFIRMADA' AND end_at > ?
     ) AS present`,
    [...courtIds, toMySqlDateTime(now)],
  );
  return Boolean(rows[0].present);
}

async function loadAssessmentBookings(connection, courtId, where, values) {
  const [rows] = await connection.execute(
    `SELECT b.id, b.user_id, b.court_id, b.start_at, b.end_at,
            b.booking_timezone, b.status
     FROM bookings AS b
     WHERE b.court_id = ? AND b.status = 'CONFIRMADA' ${where}
     ORDER BY b.start_at, b.id`,
    [courtId, ...values],
  );
  return rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    courtId: String(row.court_id),
    startAt: toInstantString(row.start_at),
    endAt: toInstantString(row.end_at),
    timeZone: row.booking_timezone,
    status: row.status,
  }));
}

async function loadBookingAssessmentContext(connection, court, booking) {
  const localDate = Temporal.Instant.from(booking.startAt)
    .toZonedDateTimeISO(court.timezone)
    .toPlainDate()
    .toString();
  const snapshot = await loadAvailabilityContext(connection, {
    courtId: court.id,
    date: localDate,
    lockCourt: false,
  });
  if (!snapshot) throw bookingError('internal_error');
  return snapshot.context;
}

async function createOperationalChange(connection, { courtId, actorUserId, type, now }) {
  const [insert] = await connection.execute(
    `INSERT INTO operational_changes
       (court_id, actor_user_id, change_type, occurred_at, metadata)
     VALUES (?, ?, ?, ?, NULL)`,
    [courtId, actorUserId, type, toMySqlDateTime(now)],
  );
  return { id: String(insert.insertId), courtId: String(courtId), conflictsCreated: 0 };
}

function mapAdminFacility(row) {
  return {
    id: String(row.id),
    name: row.name,
    timeZone: row.timezone,
    minimumAdvanceMinutes: Number(row.minimum_advance_minutes),
    maximumAdvanceMinutes: Number(row.maximum_advance_minutes),
    createdAt: toInstantString(row.created_at),
    deactivatedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
    state: row.deactivated_at == null ? 'active' : 'inactive',
  };
}

function mapAdminCourt(row) {
  return {
    id: String(row.id),
    facility: { id: String(row.facility_id), name: row.facility_name },
    name: row.name,
    description: row.description,
    ...(Object.hasOwn(row, 'sport_code') ? { sportCode: row.sport_code } : {}),
    minimumSeparationMinutes: Number(row.minimum_separation_minutes),
    cancellationMinMinutes: Number(row.cancellation_min_minutes),
    depositPercentage: Number(row.deposit_percentage),
    startIntervalMinutes: Number(row.start_interval_minutes),
    allowedDurationsMinutes: row.durations ?? [],
    createdAt: toInstantString(row.created_at),
    deactivatedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
    state: row.deactivated_at == null ? 'active' : 'inactive',
  };
}

function presentBookingConfiguration(court) {
  return {
    courtId: String(court.id),
    minimumSeparationMinutes: Number(court.minimum_separation_minutes),
    cancellationMinMinutes: Number(court.cancellation_min_minutes),
    depositPercentage: Number(court.deposit_percentage),
    startIntervalMinutes: Number(court.start_interval_minutes),
    allowedDurationsMinutes: court.durations,
  };
}

function unchangedOperation() {
  return { changed: false, changes: [] };
}

function changedOperation(changes) {
  return { changed: true, changes };
}

function normalizedDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw bookingError('invalid_operational_configuration');
  }
  const sorted = [...values].sort((left, right) => left - right);
  if (
    new Set(sorted).size !== sorted.length
    || sorted.some((value) => !Number.isInteger(value) || value < 1 || value > 65_535)
  ) throw bookingError('invalid_operational_configuration');
  return sorted;
}

function assertBookingPolicy(policy) {
  try {
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(policy.timeZone);
  } catch (error) {
    throw bookingError('invalid_operational_configuration', { cause: error });
  }
  if (
    !Number.isInteger(policy.minimumAdvanceMinutes)
    || !Number.isInteger(policy.maximumAdvanceMinutes)
    || policy.minimumAdvanceMinutes < 0
    || policy.maximumAdvanceMinutes < policy.minimumAdvanceMinutes
    || policy.maximumAdvanceMinutes > 4_294_967_295
  ) throw bookingError('invalid_operational_configuration');
}

function assertCourtConfiguration(configuration) {
  if (
    !Number.isInteger(configuration.minimumSeparationMinutes)
    || configuration.minimumSeparationMinutes < 0
    || configuration.minimumSeparationMinutes > 65_535
    || !Number.isInteger(configuration.startIntervalMinutes)
    || configuration.startIntervalMinutes < 1
    || configuration.startIntervalMinutes > 65_535
  ) throw bookingError('invalid_operational_configuration');
}

function normalizedWeeklyPeriods(periods) {
  if (!Array.isArray(periods)) throw bookingError('invalid_operational_configuration');
  const result = periods.map((period) => ({
    weekday: Number(period.weekday),
    startTime: normalizeTime(period.startTime),
    endTime: normalizeTime(period.endTime),
  })).sort((left, right) => left.weekday - right.weekday
    || left.startTime.localeCompare(right.startTime));
  for (let index = 0; index < result.length; index += 1) {
    const period = result[index];
    if (
      !Number.isInteger(period.weekday)
      || period.weekday < 1
      || period.weekday > 7
      || period.startTime >= period.endTime
      || (index > 0
        && result[index - 1].weekday === period.weekday
        && result[index - 1].endTime > period.startTime)
    ) throw bookingError('invalid_operational_configuration');
  }
  return result;
}

function normalizedDateException(courtId, localDate, input) {
  const periods = normalizedWeeklyPeriods(
    (input.periods ?? []).map((period) => ({ ...period, weekday: 1 })),
  ).map(({ startTime, endTime }) => ({ startTime, endTime }));
  if (
    (input.mode === 'CLOSED' && periods.length !== 0)
    || (input.mode === 'CUSTOM_PERIODS' && periods.length === 0)
    || !['CLOSED', 'CUSTOM_PERIODS'].includes(input.mode)
  ) throw bookingError('invalid_operational_configuration');
  return { courtId: String(courtId), localDate, mode: input.mode, periods };
}

function assertValidExceptionTimes(exception, timeZone) {
  try {
    const date = Temporal.PlainDate.from(exception.localDate);
    for (const period of exception.periods) {
      for (const time of [period.startTime, period.endTime]) {
        date.toPlainDateTime(time).toZonedDateTime(timeZone, { disambiguation: 'reject' });
      }
    }
  } catch (error) {
    throw bookingError('invalid_operational_configuration', { cause: error });
  }
}

function assertUnavailability(unavailability, now) {
  try {
    const start = Temporal.Instant.from(unavailability.startAt);
    const end = Temporal.Instant.from(unavailability.endAt);
    if (
      !['BLOQUEO_ADMINISTRATIVO', 'FUERA_DE_SERVICIO'].includes(unavailability.type)
      || (unavailability.reason != null
        && (typeof unavailability.reason !== 'string' || unavailability.reason.length > 500))
      || Temporal.Instant.compare(start, end) >= 0
      || Temporal.Instant.compare(end, Temporal.Instant.from(now)) <= 0
    ) throw new RangeError('Invalid unavailability');
  } catch (error) {
    throw bookingError('invalid_operational_configuration', { cause: error });
  }
}

function normalizeTime(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw bookingError('invalid_operational_configuration');
  }
  return value.length === 5 ? `${value}:00` : value;
}

function assertCurrentOrFutureLocalDate(localDate, timeZone, now) {
  try {
    const requested = Temporal.PlainDate.from(localDate);
    const current = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate();
    if (Temporal.PlainDate.compare(requested, current) < 0) {
      throw bookingError('invalid_operational_configuration');
    }
  } catch (error) {
    if (error?.code) throw error;
    throw bookingError('invalid_operational_configuration', { cause: error });
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function objectsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unavailabilitySelect() {
  return `SELECT cu.id, cu.court_id, cu.type, cu.start_at, cu.end_at, cu.reason,
                 cu.created_by_user_id, cu.created_at
          FROM court_unavailabilities AS cu`;
}

function mapUnavailability(row) {
  return {
    id: String(row.id),
    courtId: String(row.court_id),
    type: row.type,
    startAt: toInstantString(row.start_at),
    endAt: toInstantString(row.end_at),
    reason: row.reason,
    createdByUserId: String(row.created_by_user_id),
    createdAt: toInstantString(row.created_at),
  };
}

function operationalConflictSelect() {
  return `SELECT cf.id, cf.detected_at, cf.resolved_at,
                 b.id AS booking_id, b.user_id AS booking_user_id,
                 b.court_id AS booking_court_id, b.start_at AS booking_start_at,
                 b.end_at AS booking_end_at, b.booking_timezone,
                 oc.id AS change_id, oc.court_id AS change_court_id,
                 oc.change_type, oc.actor_user_id, oc.occurred_at
          FROM operational_conflicts AS cf
          INNER JOIN bookings AS b ON b.id = cf.booking_id
          INNER JOIN operational_changes AS oc ON oc.id = cf.operational_change_id`;
}

function mapOperationalConflict(row) {
  return {
    id: String(row.id),
    detectedAt: toInstantString(row.detected_at),
    resolvedAt: row.resolved_at == null ? null : toInstantString(row.resolved_at),
    booking: {
      id: String(row.booking_id),
      courtId: String(row.booking_court_id),
      userId: String(row.booking_user_id),
      startAt: toInstantString(row.booking_start_at),
      endAt: toInstantString(row.booking_end_at),
      timeZone: row.booking_timezone,
    },
    operationalChange: {
      id: String(row.change_id),
      courtId: String(row.change_court_id),
      type: row.change_type,
      actorUserId: String(row.actor_user_id),
      occurredAt: toInstantString(row.occurred_at),
    },
  };
}

async function loadAvailabilityContext(connection, { courtId, date, lockCourt }) {
  if (lockCourt) {
    const [lockRows] = await connection.execute(
      'SELECT id FROM courts WHERE id = ? FOR UPDATE',
      [courtId],
    );
    if (lockRows.length === 0) return null;
  }

  const [courtRows] = await connection.execute(
    `SELECT c.id, c.name, c.facility_id, c.minimum_separation_minutes, c.cancellation_min_minutes,
             c.deposit_percentage,
            c.start_interval_minutes, f.name AS facility_name, f.timezone,
            f.minimum_advance_minutes, f.maximum_advance_minutes
     FROM courts AS c
     INNER JOIN facilities AS f ON f.id = c.facility_id
     WHERE c.id = ?
       AND c.deactivated_at IS NULL
       AND f.deactivated_at IS NULL`,
    [courtId],
  );
  if (courtRows.length === 0) return null;
  const court = courtRows[0];

  const plainDate = Temporal.PlainDate.from(date);
  const [durationRows] = await connection.execute(
    `SELECT duration_minutes
     FROM court_allowed_durations
     WHERE court_id = ?
     ORDER BY duration_minutes`,
    [courtId],
  );
  const [weeklyRows] = await connection.execute(
    `SELECT weekday,
            TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
            TIME_FORMAT(end_time, '%H:%i:%s') AS end_time
     FROM court_weekly_periods
     WHERE court_id = ? AND weekday = ?
     ORDER BY start_time, id`,
    [courtId, plainDate.dayOfWeek],
  );
  const [exceptionRows] = await connection.execute(
    `SELECT id, DATE_FORMAT(local_date, '%Y-%m-%d') AS local_date, mode
     FROM court_date_exceptions
     WHERE court_id = ? AND local_date = ?`,
    [courtId, date],
  );

  let exception = null;
  if (exceptionRows.length > 0) {
    const row = exceptionRows[0];
    const [periodRows] = await connection.execute(
      `SELECT TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
              TIME_FORMAT(end_time, '%H:%i:%s') AS end_time
       FROM court_exception_periods
       WHERE exception_id = ?
       ORDER BY start_time, id`,
      [row.id],
    );
    exception = {
      localDate: row.local_date,
      mode: row.mode,
      periods: periodRows.map(mapPeriod),
    };
  }

  const separation = Number(court.minimum_separation_minutes);
  const bookingBounds = localDayBounds(date, court.timezone, separation);
  const unavailableBounds = localDayBounds(date, court.timezone);
  const [bookingRows] = await connection.execute(
    `SELECT id, start_at, end_at, status
     FROM bookings
     WHERE court_id = ?
        AND (status = 'CONFIRMADA' OR (status = 'PENDIENTE_PAGO' AND payment_expires_at > UTC_TIMESTAMP(6)))
       AND start_at < ?
       AND end_at > ?
     ORDER BY start_at, id`,
    [courtId, bookingBounds.endAt, bookingBounds.startAt],
  );
  const [unavailabilityRows] = await connection.execute(
    `SELECT id, type, start_at, end_at
     FROM court_unavailabilities
     WHERE court_id = ?
       AND start_at < ?
       AND end_at > ?
     ORDER BY start_at, id`,
    [courtId, unavailableBounds.endAt, unavailableBounds.startAt],
  );

  return {
    court: { id: String(court.id), name: court.name,
      cancellationMinMinutes: Number(court.cancellation_min_minutes),
      depositPercentage: Number(court.deposit_percentage) },
    facility: { id: String(court.facility_id), name: court.facility_name },
    context: {
      date,
      timeZone: court.timezone,
      weeklyPeriods: weeklyRows.map((row) => ({
        weekday: Number(row.weekday),
        ...mapPeriod(row),
      })),
      exception,
      allowedDurationsMinutes: durationRows.map((row) => Number(row.duration_minutes)),
      startIntervalMinutes: Number(court.start_interval_minutes),
      minimumSeparationMinutes: separation,
      bookingWindow: {
        minimumAdvanceMinutes: Number(court.minimum_advance_minutes),
        maximumAdvanceMinutes: Number(court.maximum_advance_minutes),
      },
      bookings: bookingRows.map((row) => ({
        id: String(row.id),
        status: row.status,
        startAt: toInstantString(row.start_at),
        endAt: toInstantString(row.end_at),
      })),
      unavailabilities: unavailabilityRows.map((row) => ({
        id: String(row.id),
        type: row.type,
        startAt: toInstantString(row.start_at),
        endAt: toInstantString(row.end_at),
      })),
    },
  };
}

async function changeCourt(pool, { courtId, actorUserId, now, assess, type, apply }) {
  return runTransactionWithRetry(pool, async (connection) => {
    const before = await loadOperationalState(connection, courtId, now, true);
    if (!before) return null;
    if (before.deactivatedAt != null || before.facilityDeactivatedAt != null) return { kind: 'inactive' };
    const outcome = await apply(connection, before);
    if (outcome.notFound) return null;
    if (outcome.noop) return mutationFor(outcome.state, outcome.result, { changed: false, changes: [] });
    const transitioned = assess ? assessTransitions(before, outcome.state, assess) : [];
    const change = await insertChange(connection, { courtId, actorUserId, type, now });
    await insertConflicts(connection, change.id, transitioned, now);
    return mutationFor(outcome.state, outcome.result, {
      changed: true,
      changes: [{ id: change.id, courtId, conflictsCreated: transitioned.length }],
    });
  });
}

function mutationFor(state, result, operation) {
  if (result) return { ...result, operation };
  return { court: state.court, operation };
}

function assessTransitions(before, after, assess) {
  return before.bookings.filter((booking) => {
    const date = Temporal.Instant.from(booking.startAt)
      .toZonedDateTimeISO(before.timeZone).toPlainDate().toString();
    return assess({
      booking,
      beforeContext: contextForDate(before, date),
      afterContext: contextForDate(after, date),
    });
  });
}

async function loadOperationalState(connection, courtId, now, lock) {
  if (lock) {
    const [locks] = await connection.execute('SELECT id FROM courts WHERE id = ? FOR UPDATE', [courtId]);
    if (!locks.length) return null;
  }
  const [courts] = await connection.execute(
    `SELECT c.id, c.name, c.description, c.facility_id, c.minimum_separation_minutes, c.start_interval_minutes, c.created_at, c.deactivated_at,
            f.name AS facility_name, f.timezone, f.minimum_advance_minutes, f.maximum_advance_minutes, f.deactivated_at AS facility_deactivated_at
     FROM courts c INNER JOIN facilities f ON f.id = c.facility_id WHERE c.id = ?`, [courtId],
  );
  if (!courts.length) return null;
  const court = courts[0];
  const [durations] = await connection.execute('SELECT duration_minutes FROM court_allowed_durations WHERE court_id = ? ORDER BY duration_minutes', [courtId]);
  const [weekly] = await connection.execute(`SELECT weekday, TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM court_weekly_periods WHERE court_id = ? ORDER BY weekday, start_time, id`, [courtId]);
  const [exceptionRows] = await connection.execute(`SELECT id, DATE_FORMAT(local_date, '%Y-%m-%d') AS local_date, mode FROM court_date_exceptions WHERE court_id = ?`, [courtId]);
  const exceptions = new Map();
  for (const row of exceptionRows) {
    const [periods] = await connection.execute(`SELECT TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM court_exception_periods WHERE exception_id = ? ORDER BY start_time, id`, [row.id]);
    exceptions.set(row.local_date, { id: String(row.id), localDate: row.local_date, mode: row.mode, periods: periods.map(mapPeriod) });
  }
  const values = [courtId]; let confirmed = "status = 'CONFIRMADA'";
  if (now) { confirmed += ' AND end_at > ?'; values.push(toMySqlDateTime(now)); }
  const [bookings] = await connection.execute(`SELECT id, start_at, end_at, status FROM bookings WHERE court_id = ? AND ${confirmed} ORDER BY start_at, id`, values);
  const [unavailabilities] = await connection.execute('SELECT id, type, start_at, end_at FROM court_unavailabilities WHERE court_id = ? ORDER BY start_at, id', [courtId]);
  return {
    court: { id: String(court.id), name: court.name, description: court.description, facility: { id: String(court.facility_id), name: court.facility_name }, createdAt: toInstantString(court.created_at), deactivatedAt: court.deactivated_at == null ? null : toInstantString(court.deactivated_at), minimumSeparationMinutes: Number(court.minimum_separation_minutes), startIntervalMinutes: Number(court.start_interval_minutes), allowedDurationsMinutes: durations.map((row) => Number(row.duration_minutes) ) },
    timeZone: court.timezone, minimumAdvanceMinutes: Number(court.minimum_advance_minutes), maximumAdvanceMinutes: Number(court.maximum_advance_minutes),
    minimumSeparationMinutes: Number(court.minimum_separation_minutes), startIntervalMinutes: Number(court.start_interval_minutes), allowedDurationsMinutes: durations.map((row) => Number(row.duration_minutes)), weeklyPeriods: weekly.map((row) => ({ weekday: Number(row.weekday), ...mapPeriod(row) })), exceptions,
    bookings: bookings.map((row) => ({ id: String(row.id), status: row.status, startAt: toInstantString(row.start_at), endAt: toInstantString(row.end_at), timeZone: court.timezone })),
    unavailabilities: unavailabilities.map((row) => ({ id: String(row.id), type: row.type, startAt: toInstantString(row.start_at), endAt: toInstantString(row.end_at) })),
    deactivatedAt: court.deactivated_at == null ? null : toInstantString(court.deactivated_at), facilityDeactivatedAt: court.facility_deactivated_at == null ? null : toInstantString(court.facility_deactivated_at),
  };
}

function cloneState(state) { return { ...state, court: { ...state.court, allowedDurationsMinutes: [...state.allowedDurationsMinutes] }, allowedDurationsMinutes: [...state.allowedDurationsMinutes], weeklyPeriods: state.weeklyPeriods.map((period) => ({ ...period })), exceptions: new Map([...state.exceptions].map(([key, value]) => [key, { ...value, periods: value.periods.map((period) => ({ ...period })) }])), unavailabilities: state.unavailabilities.map((item) => ({ ...item })) }; }
function contextForDate(state, date) { return { date, timeZone: state.timeZone, weeklyPeriods: state.weeklyPeriods, exception: state.exceptions.get(date) ?? null, allowedDurationsMinutes: state.allowedDurationsMinutes, startIntervalMinutes: state.startIntervalMinutes, minimumSeparationMinutes: state.minimumSeparationMinutes, bookingWindow: { minimumAdvanceMinutes: state.minimumAdvanceMinutes, maximumAdvanceMinutes: state.maximumAdvanceMinutes }, bookings: state.bookings, unavailabilities: state.unavailabilities }; }
function bookingConfiguration(state) { return { courtId: state.court.id, minimumSeparationMinutes: state.minimumSeparationMinutes, startIntervalMinutes: state.startIntervalMinutes, allowedDurationsMinutes: state.allowedDurationsMinutes }; }
function sameConfiguration(left, right) { return left.minimumSeparationMinutes === right.minimumSeparationMinutes && left.startIntervalMinutes === right.startIntervalMinutes && sameNumbers(left.allowedDurationsMinutes, right.allowedDurationsMinutes); }
function sameNumbers(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function normalizedDurationsDiscarded(values) { return [...values].sort((a, b) => a - b); }
function validDurations(values) { return Array.isArray(values) && values.length > 0 && values.every((value) => Number.isInteger(value) && value > 0 && value <= 65535) && new Set(values).size === values.length; }
function canonicalWeekly(periods) { return periods.map((period) => ({ ...period })).sort((left, right) => left.weekday - right.weekday || left.startTime.localeCompare(right.startTime)); }
function canonicalPeriods(periods) { return periods.map((period) => ({ ...period })).sort((left, right) => left.startTime.localeCompare(right.startTime)); }
function samePeriods(left, right, weekly = false) { const a = weekly ? canonicalWeekly(left) : canonicalPeriods(left); const b = weekly ? canonicalWeekly(right) : canonicalPeriods(right); return a.length === b.length && a.every((period, index) => period.startTime === b[index].startTime && period.endTime === b[index].endTime && (!weekly || period.weekday === b[index].weekday)); }
function sameException(left, right) { return left?.mode === right?.mode && samePeriods(left?.periods ?? [], right?.periods ?? []); }
function validatePeriods(periods, weekly) { for (const period of periods) { if ((!weekly || !Number.isInteger(period.weekday) || period.weekday < 1 || period.weekday > 7) || typeof period.startTime !== 'string' || typeof period.endTime !== 'string' || period.startTime >= period.endTime) throw bookingError('invalid_operational_configuration'); } const ordered = weekly ? canonicalWeekly(periods) : canonicalPeriods(periods); for (let index = 1; index < ordered.length; index += 1) if ((!weekly || ordered[index].weekday === ordered[index - 1].weekday) && ordered[index].startTime < ordered[index - 1].endTime) throw bookingError('invalid_operational_configuration'); }
function validateException(exception) { if ((exception.mode === 'CLOSED' && exception.periods.length) || (exception.mode === 'CUSTOM_PERIODS' && !exception.periods.length) || !['CLOSED', 'CUSTOM_PERIODS'].includes(exception.mode)) throw bookingError('invalid_operational_configuration'); validatePeriods(exception.periods, false); }
function assertCurrentOrFutureDate(localDate, timeZone, now) { const nowDate = Temporal.Instant.from(now).toZonedDateTimeISO(timeZone).toPlainDate().toString(); if (localDate < nowDate) throw bookingError('invalid_operational_configuration'); }
async function replaceException(connection, courtId, oldId, exception) { if (oldId) { await connection.execute('DELETE FROM court_exception_periods WHERE exception_id = ?', [oldId]); await connection.execute('DELETE FROM court_date_exceptions WHERE id = ?', [oldId]); } const [insert] = await connection.execute('INSERT INTO court_date_exceptions (court_id, local_date, mode) VALUES (?, ?, ?)', [courtId, exception.localDate, exception.mode]); for (const period of exception.periods) await connection.execute('INSERT INTO court_exception_periods (exception_id, start_time, end_time) VALUES (?, ?, ?)', [insert.insertId, period.startTime, period.endTime]); }
async function loadException(executor, courtId, localDate) { const [rows] = await executor.execute(`SELECT id, mode FROM court_date_exceptions WHERE court_id = ? AND local_date = ?`, [courtId, localDate]); if (!rows.length) return null; const [periods] = await executor.execute(`SELECT TIME_FORMAT(start_time, '%H:%i:%s') AS start_time, TIME_FORMAT(end_time, '%H:%i:%s') AS end_time FROM court_exception_periods WHERE exception_id = ? ORDER BY start_time, id`, [rows[0].id]); return { courtId: String(courtId), localDate, mode: rows[0].mode, periods: periods.map(mapPeriod) }; }
async function insertChange(connection, { courtId, actorUserId, type, now }) { const [result] = await connection.execute('INSERT INTO operational_changes (court_id, actor_user_id, change_type, occurred_at) VALUES (?, ?, ?, ?)', [courtId, actorUserId, type, toMySqlDateTime(now)]); return { id: String(result.insertId) }; }
async function insertConflicts(connection, changeId, bookings, now) { for (const booking of bookings) await connection.execute('INSERT INTO operational_conflicts (operational_change_id, booking_id, detected_at) VALUES (?, ?, ?)', [changeId, booking.id, toMySqlDateTime(now)]); }
async function hasProtectedBookingsDiscarded(connection, courtIds, now) { if (!courtIds.length) return false; const [rows] = await connection.execute(`SELECT EXISTS(SELECT 1 FROM bookings WHERE court_id IN (${courtIds.map(() => '?').join(', ')}) AND status = 'CONFIRMADA' AND end_at > ?) AS present`, [...courtIds, toMySqlDateTime(now)]); return Boolean(rows[0].present); }
async function facilityHasTemporalData(connection, facilityId) { const [rows] = await connection.execute(`SELECT EXISTS(SELECT 1 FROM courts c WHERE c.facility_id = ? AND (EXISTS(SELECT 1 FROM court_weekly_periods p WHERE p.court_id = c.id) OR EXISTS(SELECT 1 FROM court_date_exceptions e WHERE e.court_id = c.id) OR EXISTS(SELECT 1 FROM court_allowed_durations d WHERE d.court_id = c.id) OR EXISTS(SELECT 1 FROM bookings b WHERE b.court_id = c.id) OR EXISTS(SELECT 1 FROM court_unavailabilities u WHERE u.court_id = c.id))) AS present`, [facilityId]); return Boolean(rows[0].present); }
async function loadAdminFacility(connection, facilityId) { const [rows] = await connection.execute('SELECT id, name, timezone, minimum_advance_minutes, maximum_advance_minutes, created_at, deactivated_at FROM facilities WHERE id = ?', [facilityId]); if (!rows.length) return null; const row = rows[0]; return { id: String(row.id), name: row.name, timeZone: row.timezone, minimumAdvanceMinutes: Number(row.minimum_advance_minutes), maximumAdvanceMinutes: Number(row.maximum_advance_minutes), createdAt: toInstantString(row.created_at), deactivatedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at) }; }
async function loadAdminCourtDiscarded(connection, courtId) { const state = await loadOperationalState(connection, courtId, null, false); return state?.court ?? null; }
function mapUnavailabilityDiscarded(row) { return { id: String(row.id), courtId: String(row.court_id), type: row.type, startAt: toInstantString(row.start_at), endAt: toInstantString(row.end_at), reason: row.reason, createdByUserId: String(row.created_by_user_id), createdAt: toInstantString(row.created_at) }; }
function conflictSelect() { return `SELECT cf.id, cf.detected_at, cf.resolved_at, b.id AS booking_id, b.user_id AS booking_user_id, b.court_id AS booking_court_id, b.start_at AS booking_start_at, b.end_at AS booking_end_at, b.booking_timezone, oc.id AS change_id, oc.court_id AS change_court_id, oc.change_type, oc.actor_user_id, oc.occurred_at FROM operational_conflicts cf INNER JOIN bookings b ON b.id = cf.booking_id INNER JOIN operational_changes oc ON oc.id = cf.operational_change_id`; }
function mapConflict(row) { return { id: String(row.id), detectedAt: toInstantString(row.detected_at), resolvedAt: row.resolved_at == null ? null : toInstantString(row.resolved_at), booking: { id: String(row.booking_id), courtId: String(row.booking_court_id), userId: String(row.booking_user_id), startAt: toInstantString(row.booking_start_at), endAt: toInstantString(row.booking_end_at), timeZone: row.booking_timezone }, operationalChange: { id: String(row.change_id), courtId: String(row.change_court_id), type: row.change_type, actorUserId: String(row.actor_user_id), occurredAt: toInstantString(row.occurred_at) } }; }

async function claimIdempotency(connection, { userId, idempotencyKey, requestHash, operation = 'CONFIRM_BOOKING' }) {
  try {
    const [result] = await connection.execute(
      `INSERT INTO idempotency_records
         (user_id, operation, idempotency_key, request_hash)
        VALUES (?, ?, ?, ?)`,
      [userId, operation, Buffer.from(idempotencyKey, 'ascii'), requestHash],
    );
    return { id: String(result.insertId), existing: false };
  } catch (error) {
    if (error?.code !== 'ER_DUP_ENTRY') throw error;
    const [rows] = await connection.execute(
      `SELECT id, request_hash, outcome, booking_id, result_code, completed_at,
              result_price_amount_minor, result_price_currency
       FROM idempotency_records
       WHERE user_id = ?
          AND operation = ?
         AND idempotency_key = ?
       FOR UPDATE`,
      [userId, operation, Buffer.from(idempotencyKey, 'ascii')],
    );
    if (rows.length !== 1) throw bookingError('internal_error');
    return { id: String(rows[0].id), existing: true, row: rows[0] };
  }
}

async function completeRejectedIdempotency(connection, id, code, now, currentPriceMinor = null) {
  const [result] = await connection.execute(
    `UPDATE idempotency_records
     SET outcome = 'REJECTED', booking_id = NULL, result_code = ?, completed_at = ?,
         result_price_amount_minor = ?, result_price_currency = ?
     WHERE id = ? AND outcome IS NULL`,
    [code, toMySqlDateTime(now), currentPriceMinor,
      currentPriceMinor == null ? null : 'COP', id],
  );
  if (result.affectedRows !== 1) throw bookingError('internal_error');
}

async function readDatabaseNow(connection) {
  const [rows] = await connection.execute(
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS now_utc",
  );
  return toInstantString(rows[0].now_utc);
}

async function expirePendingBookings(connection, courtId) {
  // This uses database time so a process clock cannot retain an expired checkout hold.
  await connection.execute(
    `UPDATE bookings SET payment_status = 'EXPIRED'
     WHERE court_id = ? AND status = 'PENDIENTE_PAGO' AND payment_expires_at <= UTC_TIMESTAMP(6)`,
    [courtId],
  );
}

async function spendCredit(connection, { facilityId, userId, requestedMinor, now }) {
  if (requestedMinor === 0) return 0;
  await connection.execute(
    `INSERT IGNORE INTO customer_credit_balances (facility_id, user_id, balance_minor, updated_at)
     VALUES (?, ?, 0, ?)`, [facilityId, userId, toMySqlDateTime(now)],
  );
  const [rows] = await connection.execute(
    'SELECT balance_minor FROM customer_credit_balances WHERE facility_id = ? AND user_id = ? FOR UPDATE',
    [facilityId, userId],
  );
  const applied = Math.min(requestedMinor, Number(rows[0].balance_minor));
  if (applied) await connection.execute(
    `UPDATE customer_credit_balances SET balance_minor = balance_minor - ?, updated_at = ?
     WHERE facility_id = ? AND user_id = ?`, [applied, toMySqlDateTime(now), facilityId, userId],
  );
  return applied;
}

async function attachCreditSpend(connection, { facilityId, userId, bookingId, amountMinor, now }) {
  await connection.execute(
    `INSERT INTO customer_credit_ledger (facility_id, user_id, booking_id, amount_minor, reason, created_at)
     VALUES (?, ?, ?, ?, 'DEPOSIT_CREDIT_APPLIED', ?)`,
    [facilityId, userId, bookingId, -amountMinor, toMySqlDateTime(now)],
  );
}

async function grantCredit(connection, { facilityId, userId, bookingId, amountMinor, now }) {
  if (amountMinor <= 0) return;
  await connection.execute(
    `INSERT IGNORE INTO customer_credit_balances (facility_id, user_id, balance_minor, updated_at)
     VALUES (?, ?, 0, ?)`, [facilityId, userId, toMySqlDateTime(now)],
  );
  await connection.execute(
    'SELECT balance_minor FROM customer_credit_balances WHERE facility_id = ? AND user_id = ? FOR UPDATE',
    [facilityId, userId],
  );
  await connection.execute(
    `UPDATE customer_credit_balances SET balance_minor = balance_minor + ?, updated_at = ?
     WHERE facility_id = ? AND user_id = ?`, [amountMinor, toMySqlDateTime(now), facilityId, userId],
  );
  await connection.execute(
    `INSERT INTO customer_credit_ledger (facility_id, user_id, booking_id, amount_minor, reason, created_at)
     VALUES (?, ?, ?, ?, 'RESCHEDULE_SURPLUS', ?)`,
    [facilityId, userId, bookingId, amountMinor, toMySqlDateTime(now)],
  );
}

function checkoutFor(booking, dueMinor) {
  return {
    depositPercentage: booking.depositPercentage,
    depositAmountMinor: booking.depositAmountMinor,
    creditAppliedMinor: (booking.amountPaidMinor ?? 0),
    amountDueMinor: dueMinor,
    currency: 'COP',
    expiresAt: booking.paymentExpiresAt,
  };
}

async function loadPriceMap(connection, courtId) {
  const [rows] = await connection.execute(
    "SELECT duration_minutes, price_amount_minor FROM court_prices WHERE court_id = ? AND currency = 'COP'",
    [courtId],
  );
  return new Map(rows.map((row) => [Number(row.duration_minutes), Number(row.price_amount_minor)]));
}

async function loadBooking(connection, bookingId) {
  const [rows] = await connection.execute(
    `${bookingSelect()}
     WHERE b.id = ?`,
    [bookingId],
  );
  return rows.length === 0 ? null : mapBooking(rows[0]);
}

async function recordBookingChange(connection, { bookingId, actorUserId, type, previous, next,
  reason = null, reasonCode = null, outcome, now }) {
  await connection.execute(
    `INSERT INTO booking_changes (booking_id, change_type, actor_user_id,
      previous_start_at, previous_end_at, new_start_at, new_end_at,
      previous_price_minor, new_price_minor, reason_code, reason, economic_outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bookingId, type, actorUserId,
      previous ? toMySqlDateTime(previous.startAt) : null,
      previous ? toMySqlDateTime(previous.endAt) : null,
      next ? toMySqlDateTime(next.startAt) : null,
      next ? toMySqlDateTime(next.endAt) : null,
      previous?.priceMinor ?? null, next?.priceMinor ?? null, reasonCode, reason, outcome, toMySqlDateTime(now)],
  );
}

function bookingSelect() {
  return `SELECT b.id, b.user_id, b.start_at, b.end_at, b.booking_timezone,
                  b.status, b.created_at, b.cancelled_at, b.price_amount_minor, b.price_currency,
                   b.cancellation_min_minutes, b.cancellation_reason, b.economic_outcome, b.no_show_at,
                   b.deposit_percentage_snapshot, b.deposit_amount_minor, b.amount_paid_minor,
                    b.payment_status, b.payment_expires_at, b.voluntary_reschedule_count,
                  EXISTS (SELECT 1 FROM booking_exception_requests AS e
                    WHERE e.booking_id = b.id AND e.status = 'APROBADA' AND e.used_at IS NULL) AS exception_approved,
                  c.id AS court_id, c.name AS court_name,
                  f.id AS facility_id, f.name AS facility_name,
                  customer.name AS customer_name, customer.email AS customer_email
           FROM bookings AS b
           INNER JOIN courts AS c ON c.id = b.court_id
           INNER JOIN facilities AS f ON f.id = c.facility_id
           INNER JOIN users AS customer ON customer.id = b.user_id`;
}

function mapBooking(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    court: { id: String(row.court_id), name: row.court_name },
    facility: { id: String(row.facility_id), name: row.facility_name },
    startAt: toInstantString(row.start_at),
    endAt: toInstantString(row.end_at),
    timeZone: row.booking_timezone,
    priceMinor: row.price_amount_minor == null ? null : Number(row.price_amount_minor),
    currency: row.price_currency,
    cancellationMinMinutes: Number(row.cancellation_min_minutes),
    cancellationReason: row.cancellation_reason,
    economicOutcome: row.economic_outcome,
    noShowAt: row.no_show_at == null ? null : toInstantString(row.no_show_at),
    depositPercentage: row.deposit_percentage_snapshot == null ? null : Number(row.deposit_percentage_snapshot),
    depositAmountMinor: row.deposit_amount_minor == null ? null : Number(row.deposit_amount_minor),
    amountPaidMinor: row.amount_paid_minor == null ? null : Number(row.amount_paid_minor),
    paymentStatus: row.payment_status,
    paymentExpiresAt: row.payment_expires_at == null ? null : toInstantString(row.payment_expires_at),
    voluntaryRescheduleCount: row.voluntary_reschedule_count == null ? null : Number(row.voluntary_reschedule_count),
    exceptionApproved: Boolean(row.exception_approved),
    status: row.status,
    createdAt: toInstantString(row.created_at),
    cancelledAt: row.cancelled_at == null ? null : toInstantString(row.cancelled_at),
  };
}

function mapBookingState(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    courtId: String(row.court_id),
    startAt: toInstantString(row.start_at),
    endAt: toInstantString(row.end_at),
    status: row.status,
    cancellationMinMinutes: Number(row.cancellation_min_minutes),
    cancelledAt: row.cancelled_at == null ? null : toInstantString(row.cancelled_at),
    cancelledByUserId: row.cancelled_by_user_id == null
      ? null
      : String(row.cancelled_by_user_id),
  };
}

function mapPeriod(row) {
  return { startTime: row.start_time, endTime: row.end_time };
}

async function runTransactionWithRetry(pool, operation) {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the original failure.
      }
      if (
        !(error instanceof ApplicationError)
        && RECOVERABLE_MYSQL_ERRORS.has(error?.code)
        && attempt < MAX_TRANSACTION_ATTEMPTS
      ) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
  throw bookingError('internal_error');
}
