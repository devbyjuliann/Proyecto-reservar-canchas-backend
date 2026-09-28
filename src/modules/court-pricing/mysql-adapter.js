import { requireActiveMembership } from '../facility-memberships/authorize.js';

export function createMySqlCourtPricingAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) throw new TypeError('A mysql2 promise pool is required');
  return Object.freeze({ getCourt, listPrices, setPrice, removePrice });

  async function getCourt(courtId) {
    const [rows] = await pool.execute('SELECT facility_id FROM courts WHERE id = ?', [courtId]);
    return rows.length ? { facilityId: String(rows[0].facility_id) } : null;
  }

  async function listPrices({ courtId }) {
    const [rows] = await pool.execute(
      `SELECT d.duration_minutes, p.price_amount_minor, p.currency
       FROM court_allowed_durations d
       LEFT JOIN court_prices p ON p.court_id = d.court_id
         AND p.duration_minutes = d.duration_minutes
       WHERE d.court_id = ? ORDER BY d.duration_minutes ASC`, [courtId],
    );
    return rows.map((row) => ({ courtId: String(courtId),
      durationMinutes: Number(row.duration_minutes),
      priceMinor: row.price_amount_minor == null ? null : Number(row.price_amount_minor),
      currency: row.currency }));
  }

  async function setPrice(input) {
    return mutate(input, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT price_amount_minor FROM court_prices
         WHERE court_id = ? AND duration_minutes = ?`, [input.courtId, input.durationMinutes],
      );
      const changed = !rows.length || Number(rows[0].price_amount_minor) !== input.priceMinor;
      if (changed) {
        await connection.execute(
          `INSERT INTO court_prices (court_id, duration_minutes, price_amount_minor, currency)
           VALUES (?, ?, ?, 'COP')
           ON DUPLICATE KEY UPDATE price_amount_minor = VALUES(price_amount_minor)`,
          [input.courtId, input.durationMinutes, input.priceMinor],
        );
      }
      return { price: { courtId: input.courtId, durationMinutes: input.durationMinutes,
        priceMinor: input.priceMinor, currency: 'COP' }, changed };
    });
  }

  async function removePrice(input) {
    return mutate(input, async (connection) => {
      const [result] = await connection.execute(
        'DELETE FROM court_prices WHERE court_id = ? AND duration_minutes = ?',
        [input.courtId, input.durationMinutes],
      );
      return { price: null, changed: result.affectedRows === 1 };
    });
  }

  async function mutate(input, action) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [courts] = await connection.execute(
        `SELECT c.facility_id, c.deactivated_at, f.deactivated_at AS facility_deactivated_at
         FROM courts c JOIN facilities f ON f.id = c.facility_id
         WHERE c.id = ? FOR UPDATE`, [input.courtId],
      );
      if (!courts.length) return await rollback(connection, 'resource_not_found');
      const court = courts[0];
      if (input.scope === 'owner') {
        await requireActiveMembership(connection, { facilityId: court.facility_id,
          userId: input.actorUserId, lock: true });
      }
      if (court.deactivated_at != null || court.facility_deactivated_at != null) {
        return await rollback(connection, 'resource_inactive');
      }
      const [durations] = await connection.execute(
        'SELECT duration_minutes FROM court_allowed_durations WHERE court_id = ? AND duration_minutes = ?',
        [input.courtId, input.durationMinutes],
      );
      if (!durations.length) return await rollback(connection, 'invalid_operational_configuration');
      const result = await action(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function rollback(connection, result) {
  await connection.rollback();
  return result;
}
