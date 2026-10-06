import { randomBytes } from 'node:crypto';

import { bookingError } from '../booking/errors.js';
import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const utcNow = () => toMySqlDateTime(new Date().toISOString());
const statuses = new Set(['PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'CANCELLED']);

async function transaction(pool, action) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

// Refund claims are durable before contacting Wompi. An ambiguous POST is never
// replayed automatically: the Sandbox V2 guide does not promise POST idempotency.
export function createRefundEngine({ pool, provider, notifications, logger = console }) {
  async function ensureLatePayment(paymentId) {
    return transaction(pool, async (db) => {
      const [payments] = await db.execute(`SELECT p.*, b.user_id AS booking_user_id, b.status AS booking_status
        FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ? FOR UPDATE`, [paymentId]);
      const p = payments[0];
      if (!p || String(p.user_id) !== String(p.booking_user_id) || p.provider !== 'WOMPI'
        || p.status !== 'REFUND_PENDING' || p.provider_status !== 'APPROVED'
        || !p.wompi_transaction_id) return null;
      return createObligation(db, p, 'LATE_PAYMENT');
    });
  }

  async function resolve({ bookingId, userId, choice }) {
    return transaction(pool, async (db) => {
      const [rows] = await db.execute('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [bookingId]);
      if (!rows.length) throw bookingError('resource_not_found');
      const booking = rows[0];
      if (String(booking.user_id) !== String(userId)) throw bookingError('forbidden');
      if (booking.economic_resolution && booking.economic_resolution !== (choice === 'REFUND' ? 'REFUND_REQUESTED' : 'RESCHEDULED')) {
        throw bookingError('invalid_booking_state');
      }
      const owner = booking.status === 'CANCELADA' && booking.cancellation_reason === 'CANCELLED_BY_OWNER'
        && booking.economic_outcome === 'FULL_REFUND_OR_RESCHEDULE';
      const weather = booking.status === 'CANCELADA' && booking.cancellation_reason === 'CLIENTE_EXCEPCION'
        && booking.economic_outcome === 'REFUND_ALLOWED';
      if (!owner && !(weather && choice === 'REFUND')) throw bookingError('invalid_booking_state');
      if (choice === 'RESCHEDULE') {
        // The exceptional reschedule is executed separately; no money moves here.
        return { resolution: 'RESCHEDULE', bookingId };
      }
      if (!booking.economic_resolution) await db.execute(`UPDATE bookings SET economic_resolution = 'REFUND_REQUESTED'
        WHERE id = ?`, [bookingId]);
      const [payments] = await db.execute(`SELECT * FROM payments WHERE booking_id = ? AND user_id = ?
        AND provider = 'WOMPI' AND provider_status = 'APPROVED'
        AND status = 'APROBADO' ORDER BY id FOR UPDATE`, [bookingId, userId]);
      for (const payment of payments) await createObligation(db, payment, owner ? 'OWNER_CANCELLATION' : 'WEATHER_EXCEPTION');
      // No Wompi charge: restore the original internal credit inside this same transaction.
      if (!payments.length) await restoreCredit(db, bookingId, userId);
      return { resolution: 'REFUND', bookingId };
    });
  }

  async function createObligation(db, payment, reason) {
    if (payment.currency !== 'COP' || payment.provider !== 'WOMPI'
      || !['APROBADO', 'REFUND_PENDING'].includes(payment.status) || !payment.wompi_transaction_id) {
      throw bookingError('invalid_booking_state');
    }
    const [existing] = await db.execute('SELECT id FROM payment_refunds WHERE payment_id = ? AND reason_code = ?',
      [payment.id, reason]);
    if (existing.length) return String(existing[0].id);
    const [reserved] = await db.execute(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payment_refunds
      WHERE payment_id = ? AND status IN ('PENDING', 'APPROVED')`, [payment.id]);
    const amount = Number(payment.amount_minor) - Number(reserved[0].total);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw bookingError('invalid_payment_amount');
    // Wompi references are limited to 40 characters; BIGINT booking IDs may use 20.
    const reference = `RC-REF-${payment.booking_id}-${randomBytes(5).toString('hex')}`;
    const now = utcNow();
    const [insert] = await db.execute(`INSERT INTO payment_refunds (booking_id, payment_id, user_id, provider,
      provider_transaction_id, reference, amount_minor, currency, reason_code, status, requested_at, created_at, updated_at)
      VALUES (?, ?, ?, 'WOMPI', ?, ?, ?, 'COP', ?, 'PENDING', ?, ?, ?)`,
    [payment.booking_id, payment.id, payment.user_id, payment.wompi_transaction_id, reference, amount, reason, now, now, now]);
    return String(insert.insertId);
  }

  async function processPending() {
    const [late] = await pool.execute(`SELECT p.id FROM payments p WHERE p.provider = 'WOMPI'
      AND p.status = 'REFUND_PENDING' AND p.wompi_transaction_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payment_refunds r WHERE r.payment_id = p.id)
      ORDER BY p.id LIMIT 25`);
    for (const row of late) await ensureLatePayment(String(row.id));
    const [rows] = await pool.execute(`SELECT id FROM payment_refunds WHERE status = 'PENDING'
      AND (last_attempt_at IS NULL OR (provider_refund_id IS NOT NULL
        AND last_attempt_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 2 MINUTE)))
      ORDER BY id LIMIT 25`);
    for (const row of rows) {
      try { await processOne(String(row.id)); }
      catch { logger.error?.('refund processing failed'); }
    }
  }

  async function processOne(refundId) {
    const claimed = await transaction(pool, async (db) => {
      const [rows] = await db.execute('SELECT * FROM payment_refunds WHERE id = ? FOR UPDATE', [refundId]);
      const row = rows[0];
      if (!row || row.status !== 'PENDING' || row.last_attempt_at && !row.provider_refund_id
        || row.last_attempt_at
        && Date.now() - new Date(`${row.last_attempt_at}Z`).getTime() < 120_000) return null;
      await db.execute('UPDATE payment_refunds SET last_attempt_at = ?, updated_at = ? WHERE id = ?',
        [utcNow(), utcNow(), refundId]);
      return row;
    });
    if (!claimed) return;
    // A crash after this claim leaves the obligation for reconciliation; no second POST.
    const result = claimed.provider_refund_id
      ? await provider.findRefund(claimed.provider_refund_id)
      : await provider.createRefund({ transactionId: claimed.provider_transaction_id,
        amountInCents: Number(claimed.amount_minor), reference: claimed.reference, reason: claimed.reason_code });
    await recordProviderResult({ refundId, id: result.refund_id ?? result.id,
      transactionId: result.transaction_id ?? claimed.provider_transaction_id,
      amountInCents: result.amount_in_cents ?? Number(claimed.amount_minor), currency: result.currency ?? 'COP',
      status: result.status });
  }

  async function recordProviderResult({ refundId, id, transactionId, amountInCents, currency, status }) {
    if (!statuses.has(status) || typeof id !== 'string' || !id || !Number.isSafeInteger(amountInCents)) return;
    const completed = await transaction(pool, async (db) => {
      const [rows] = await db.execute('SELECT * FROM payment_refunds WHERE id = ? FOR UPDATE', [refundId]);
      const refund = rows[0];
      if (!refund || refund.status !== 'PENDING' || refund.provider_refund_id && refund.provider_refund_id !== id
        || refund.provider_transaction_id !== transactionId || Number(refund.amount_minor) !== amountInCents
        || refund.currency !== currency) return null;
      const now = utcNow();
      await db.execute(`UPDATE payment_refunds SET status = ?, provider_refund_id = ?,
        processed_at = ?, updated_at = ? WHERE id = ?`,
      [status, id, status === 'PENDING' ? null : now, now, refundId]);
      if (status !== 'APPROVED') return null;
      const restored = await restoreCredit(db, refund.booking_id, refund.user_id);
      // Claim the one customer notification in the same transaction as settlement.
      const [bookings] = await db.execute(`SELECT b.id, b.start_at, b.booking_timezone,
        c.name AS court_name, f.name AS facility_name,
        u.email FROM bookings b JOIN courts c ON c.id = b.court_id
        JOIN facilities f ON f.id = c.facility_id JOIN users u ON u.id = b.user_id WHERE b.id = ?`, [refund.booking_id]);
      await db.execute('UPDATE payment_refunds SET emailed_at = ? WHERE id = ? AND emailed_at IS NULL', [now, refundId]);
      return { booking: { ...bookings[0], start_at: toInstantString(bookings[0].start_at) },
        amountMinor: amountInCents, restoredMinor: restored,
        reason: refund.reason_code };
    });
    if (completed && notifications?.refundApproved) {
      try { await notifications.refundApproved(completed); }
      catch { logger.error?.('refund approved email delivery failed'); }
    }
  }

  async function recordWebhook(facts) {
    const [rows] = await pool.execute('SELECT id FROM payment_refunds WHERE provider = ? AND provider_refund_id = ?',
      ['WOMPI', facts.id]);
    if (!rows.length) return;
    await recordProviderResult({ refundId: String(rows[0].id), ...facts });
  }

  return Object.freeze({ ensureLatePayment, resolve, processPending, processOne, recordWebhook,
    recordProviderResult });
}

async function restoreCredit(db, bookingId, userId) {
  const [spent] = await db.execute(`SELECT COALESCE(-SUM(amount_minor), 0) AS amount, MIN(facility_id) AS facility_id
    FROM customer_credit_ledger WHERE booking_id = ? AND user_id = ? AND reason = 'DEPOSIT_CREDIT_APPLIED'`,
  [bookingId, userId]);
  const amount = Number(spent[0].amount);
  if (!amount) return 0;
  const [restored] = await db.execute(`INSERT IGNORE INTO customer_credit_ledger
    (facility_id, user_id, booking_id, amount_minor, reason, created_at)
    VALUES (?, ?, ?, ?, 'CREDIT_RESTORED', ?)`, [spent[0].facility_id, userId, bookingId, amount, utcNow()]);
  if (!restored.affectedRows) return 0;
  await db.execute(`INSERT INTO customer_credit_balances (facility_id, user_id, balance_minor, updated_at)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE balance_minor = balance_minor + VALUES(balance_minor),
    updated_at = VALUES(updated_at)`, [spent[0].facility_id, userId, amount, utcNow()]);
  return amount;
}
