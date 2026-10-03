import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const FACILITY_PUBLIC = `f.publication_status = 'PUBLISHED'
  AND f.published_at IS NOT NULL AND f.unpublished_at IS NULL
  AND f.deactivated_at IS NULL AND TRIM(f.name) <> '' AND TRIM(f.timezone) <> ''
  AND f.city IS NOT NULL AND TRIM(f.city) <> ''
  AND f.address IS NOT NULL AND TRIM(f.address) <> ''
  AND f.description IS NOT NULL AND TRIM(f.description) <> ''`;
const COURT_BASE = `c.deactivated_at IS NULL
  AND TRIM(c.name) <> '' AND c.description IS NOT NULL AND TRIM(c.description) <> ''
  AND c.sport_code IS NOT NULL AND c.sport_code <> '' AND EXISTS
    (SELECT 1 FROM court_allowed_durations d WHERE d.court_id = c.id)`;
const COURT_READY = `${COURT_BASE} AND EXISTS
  (SELECT 1 FROM court_prices p WHERE p.court_id = c.id AND p.currency = 'COP')`;
const FACILITY_COLUMNS = `f.id, f.name, f.city, f.address, f.description,
  f.timezone, f.published_at`;
const COURT_COLUMNS = `c.id, c.name, c.description, c.sport_code, c.cancellation_min_minutes,
  f.id AS facility_id, f.name AS facility_name, f.city AS facility_city,
  f.timezone`;

export function createMySqlPublicCatalogAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) throw new TypeError('A mysql2 promise pool is required');
  return Object.freeze({ pricingReady, list, getFacility, getCourt, isPublicCourt, publish, unpublish });

  async function pricingReady() { return true; }

  async function isPublicCourt(executor, courtId, { requirePrice = true } = {}) {
    const [rows] = await executor.execute(
      `SELECT c.id FROM courts c JOIN facilities f ON f.id = c.facility_id
       WHERE c.id = ? AND ${FACILITY_PUBLIC} AND ${requirePrice ? COURT_READY : COURT_BASE}`,
      [courtId],
    );
    return rows.length === 1;
  }

  async function list({ kind, facilityId, filters, limit, position }) {
    return kind === 'facilities'
      ? listFacilities({ filters, limit, position })
      : listCourts({ kind, facilityId, filters, limit, position });
  }

  async function listFacilities({ filters, limit, position }) {
    const values = [];
    const courtConditions = [COURT_READY];
    if (filters.sport) { courtConditions.push('c.sport_code = ?'); values.push(filters.sport); }
    if (filters.q) {
      courtConditions.push("(f.name LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')");
      values.push(like(filters.q), like(filters.q));
    }
    priceFilter(courtConditions, values, filters);
    const conditions = [FACILITY_PUBLIC,
      `EXISTS (SELECT 1 FROM courts c WHERE c.facility_id = f.id AND ${courtConditions.join(' AND ')})`];
    if (filters.city) { conditions.push('f.city_normalized = ?'); values.push(filters.city); }
    if (position) {
      conditions.push('(f.name > ? OR (f.name = ? AND f.id > ?))');
      values.push(position.name, position.name, position.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `SELECT ${FACILITY_COLUMNS} FROM facilities f WHERE ${conditions.join(' AND ')}
       ORDER BY f.name ASC, f.id ASC LIMIT ?`, values,
    );
    const summaries = rows.map(facilitySummary);
    for (const summary of summaries) {
      const conditionsForPrice = [COURT_READY];
      const priceValues = [];
      if (filters.sport) { conditionsForPrice.push('c.sport_code = ?'); priceValues.push(filters.sport); }
      if (filters.q) {
        conditionsForPrice.push("(f.name LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')");
        priceValues.push(like(filters.q), like(filters.q));
      }
      const bounds = priceBounds('p', priceValues, filters);
      const [prices] = await pool.execute(
        `SELECT MIN(p.price_amount_minor) AS minimum, COUNT(DISTINCT c.id) AS court_count
         FROM courts c JOIN facilities f ON f.id = c.facility_id
         JOIN court_prices p ON p.court_id = c.id AND p.currency = 'COP'
         WHERE f.id = ? AND ${conditionsForPrice.join(' AND ')} ${bounds}`,
        [summary.id, ...priceValues],
      );
      summary.fromPriceMinor = prices[0].minimum == null ? null : Number(prices[0].minimum);
      summary.currency = 'COP';
      summary.visibleCourtCount = Number(prices[0].court_count);
    }
    return summaries;
  }

  async function listCourts({ kind, facilityId, filters, limit, position }) {
    const conditions = [FACILITY_PUBLIC, COURT_READY];
    const values = [];
    if (kind === 'facility-courts') { conditions.push('f.id = ?'); values.push(facilityId); }
    if (filters.city) { conditions.push('f.city_normalized = ?'); values.push(filters.city); }
    if (filters.sport) { conditions.push('c.sport_code = ?'); values.push(filters.sport); }
    if (filters.q) {
      conditions.push("(f.name LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')");
      values.push(like(filters.q), like(filters.q));
    }
    priceFilter(conditions, values, filters);
    if (position) {
      if (kind === 'facility-courts') {
        conditions.push('(c.name > ? OR (c.name = ? AND c.id > ?))');
        values.push(position.name, position.name, position.id);
      } else {
        conditions.push(`(f.name > ? OR (f.name = ? AND
          (c.name > ? OR (c.name = ? AND c.id > ?))))`);
        values.push(position.facilityName, position.facilityName,
          position.courtName, position.courtName, position.id);
      }
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `SELECT ${COURT_COLUMNS} FROM courts c JOIN facilities f ON f.id = c.facility_id
       WHERE ${conditions.join(' AND ')} ORDER BY
       ${kind === 'facility-courts' ? 'c.name ASC, c.id ASC' : 'f.name ASC, c.name ASC, c.id ASC'} LIMIT ?`,
      values,
    );
    const summaries = rows.map(courtSummary);
    for (const summary of summaries) {
      const priceValues = [summary.id];
      const bounds = priceBounds('p', priceValues, filters);
      const [prices] = await pool.execute(
        `SELECT MIN(p.price_amount_minor) AS minimum FROM court_prices p
         WHERE p.court_id = ? AND p.currency = 'COP' ${bounds}`, priceValues,
      );
      summary.fromPriceMinor = prices[0].minimum == null ? null : Number(prices[0].minimum);
      summary.currency = 'COP';
    }
    return summaries;
  }

  async function getFacility(facilityId) {
    const [rows] = await pool.execute(
      `SELECT ${FACILITY_COLUMNS} FROM facilities f
       WHERE f.id = ? AND ${FACILITY_PUBLIC}
         AND EXISTS (SELECT 1 FROM courts c WHERE c.facility_id = f.id AND ${COURT_READY})`,
      [facilityId],
    );
    return rows.length ? { ...facilitySummary(rows[0]),
      timeZone: rows[0].timezone, images: [],
      publishedAt: toInstantString(rows[0].published_at) } : null;
  }

  async function getCourt(courtId) {
    const [rows] = await pool.execute(
      `SELECT ${COURT_COLUMNS} FROM courts c JOIN facilities f ON f.id = c.facility_id
       WHERE c.id = ? AND ${FACILITY_PUBLIC} AND ${COURT_READY}`, [courtId],
    );
    if (!rows.length) return null;
    const [prices] = await pool.execute(
      `SELECT duration_minutes, price_amount_minor FROM court_prices
       WHERE court_id = ? AND currency = 'COP' ORDER BY duration_minutes`, [courtId],
    );
    return { ...courtSummary(rows[0]), timeZone: rows[0].timezone,
      images: [], prices: prices.map((price) => ({ durationMinutes: Number(price.duration_minutes),
        priceMinor: Number(price.price_amount_minor), currency: 'COP' })) };
  }

  async function publish({ facilityId, actorUserId, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, name, city, address, description, deactivated_at, publication_status
         FROM facilities WHERE id = ? FOR UPDATE`, [facilityId],
      );
      if (!rows.length) return await rollbackValue(connection, null);
      const facility = rows[0];
      if (facility.publication_status === 'PUBLISHED') return await rollbackValue(connection, { changed: false });
      const complete = facility.deactivated_at == null
        && [facility.name, facility.city, facility.address, facility.description].every(nonBlank);
      if (!complete) return await rollbackValue(connection, false);
      const [members] = await connection.execute(
        `SELECT m.id FROM facility_memberships m
         JOIN users u ON u.id = m.user_id AND u.deactivated_at IS NULL
         JOIN user_roles r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
         WHERE m.facility_id = ? AND m.active = 1 LIMIT 1`, [facilityId],
      );
      if (!members.length) return await rollbackValue(connection, false);
      const [courts] = await connection.execute(
        `SELECT c.id FROM courts c WHERE c.facility_id = ? AND ${COURT_READY}
         ORDER BY c.id ASC FOR UPDATE`, [facilityId],
      );
      if (!courts.length) return await rollbackValue(connection, false);
      if (!await pricingReady()) return await rollbackValue(connection, false);
      await connection.execute(
        `UPDATE facilities SET publication_status = 'PUBLISHED', published_at = ?,
          published_by_user_id = ?, unpublished_at = NULL WHERE id = ?`,
        [toMySqlDateTime(now), actorUserId, facilityId],
      );
      await connection.commit();
      return { changed: true };
    } catch (caught) {
      await connection.rollback();
      throw caught;
    } finally {
      connection.release();
    }
  }

  async function unpublish({ facilityId, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT publication_status FROM facilities WHERE id = ? FOR UPDATE', [facilityId],
      );
      if (!rows.length) return await rollbackValue(connection, null);
      if (rows[0].publication_status === 'DRAFT') return await rollbackValue(connection, { changed: false });
      await connection.execute(
        `UPDATE facilities SET publication_status = 'DRAFT', unpublished_at = ? WHERE id = ?`,
        [toMySqlDateTime(now), facilityId],
      );
      await connection.commit();
      return { changed: true };
    } catch (caught) {
      await connection.rollback();
      throw caught;
    } finally {
      connection.release();
    }
  }
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function priceBounds(alias, values, filters) {
  let clause = '';
  if (filters.minPriceMinor != null) {
    clause += ` AND ${alias}.price_amount_minor >= ?`;
    values.push(filters.minPriceMinor);
  }
  if (filters.maxPriceMinor != null) {
    clause += ` AND ${alias}.price_amount_minor <= ?`;
    values.push(filters.maxPriceMinor);
  }
  return clause;
}

function priceFilter(conditions, values, filters) {
  if (filters.minPriceMinor == null && filters.maxPriceMinor == null) return;
  const bounds = priceBounds('p', values, filters);
  conditions.push(`EXISTS (SELECT 1 FROM court_prices p WHERE p.court_id = c.id
    AND p.currency = 'COP' ${bounds})`);
}

function like(value) {
  return `%${value.replace(/[!%_]/g, (match) => `!${match}`)}%`;
}

function facilitySummary(row) {
  return { id: String(row.id), name: row.name, city: row.city,
    address: row.address, description: row.description, image: null };
}

function courtSummary(row) {
  return { id: String(row.id), facility: { id: String(row.facility_id),
    name: row.facility_name, city: row.facility_city }, name: row.name,
    description: row.description, sportCode: row.sport_code,
    cancellationMinMinutes: Number(row.cancellation_min_minutes), image: null };
}

async function rollbackValue(connection, value) {
  await connection.rollback();
  return value;
}
