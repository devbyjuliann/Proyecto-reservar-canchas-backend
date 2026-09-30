import { toInstantString, toMySqlDateTime } from '../../shared/time.js';
import { requireActiveMembership } from '../facility-memberships/authorize.js';
import { facilitiesError } from './errors.js';

export function createMySqlFacilitiesAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) {
    throw new TypeError('A mysql2 promise pool is required');
  }

  return Object.freeze({
    listFacilities,
    createFacility,
    getFacility,
    updateFacility,
    listCourts,
    getCourt,
    updateCourt,
    reactivateFacility,
  });

  async function listFacilities({ state, limit, cursor }) {
    const conditions = stateCondition('deactivated_at', state);
    const values = [];
    if (cursor) {
      conditions.push('(name > ? OR (name = ? AND id > ?))');
      values.push(cursor.name, cursor.name, cursor.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `SELECT id, name, timezone, minimum_advance_minutes,
              maximum_advance_minutes, created_at, deactivated_at,
              city, address, description, publication_status, published_at,
              published_by_user_id, unpublished_at
       FROM facilities
       WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC, id ASC
       LIMIT ?`,
      values,
    );
    return rows.map(mapFacility);
  }

  async function createFacility({ input, now, ownerUserId }) {
    if (ownerUserId) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [owners] = await connection.execute(
          `SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
            WHERE u.id = ? AND u.deactivated_at IS NULL AND u.owner_suspended_at IS NULL AND r.role_code = 'PROPIETARIO'
           FOR UPDATE`, [ownerUserId],
        );
        if (!owners.length) throw facilitiesError('forbidden');
        const result = await insertFacility(connection, input, now);
        const [membership] = await connection.execute(
          `INSERT INTO facility_memberships
           (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
           VALUES (?, ?, 'PROPIETARIO', 1, ?, ?)`,
          [result.insertId, ownerUserId, toMySqlDateTime(now), ownerUserId],
        );
        await connection.commit();
        return { facility: await getFacility(result.insertId), membership: {
          id: String(membership.insertId), facilityId: String(result.insertId),
          userId: String(ownerUserId), membershipRole: 'PROPIETARIO', active: true,
          grantedAt: toInstantString(now), revokedAt: null, createdByUserId: String(ownerUserId),
        } };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
    const result = await insertFacility(pool, input, now);
    return { facility: await getFacility(result.insertId) };
  }

  async function insertFacility(executor, input, now) {
    const [result] = await executor.execute(
      `INSERT INTO facilities
          (name, timezone, minimum_advance_minutes, maximum_advance_minutes,
           created_at, city, city_normalized, address, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.timeZone,
        input.minimumAdvanceMinutes,
        input.maximumAdvanceMinutes,
        toMySqlDateTime(now),
        input.city ?? null,
        input.city?.normalize('NFC').toLowerCase() ?? null,
        input.address ?? null,
        input.description ?? null,
      ],
    );
    return result;
  }

  async function getFacility(facilityId) {
    const [rows] = await pool.execute(
      `SELECT id, name, timezone, minimum_advance_minutes,
              maximum_advance_minutes, created_at, deactivated_at,
              city, address, description, publication_status, published_at,
              published_by_user_id, unpublished_at
       FROM facilities
       WHERE id = ?`,
      [facilityId],
    );
    return rows.length === 0 ? null : mapFacility(rows[0]);
  }

  async function reactivateFacility(facilityId) {
    const [result] = await pool.execute(
      'UPDATE facilities SET deactivated_at = NULL WHERE id = ? AND deactivated_at IS NOT NULL',
      [facilityId],
    );
    const facility = await getFacility(facilityId);
    return facility ? { facility, changed: result.affectedRows === 1 } : null;
  }

  async function updateFacility({ facilityId, input, ownerUserId }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, name, timezone, minimum_advance_minutes,
                maximum_advance_minutes, created_at, deactivated_at,
                city, address, description, publication_status, published_at,
                published_by_user_id, unpublished_at
         FROM facilities WHERE id = ? FOR UPDATE`,
        [facilityId],
      );
      if (rows.length === 0) return await rollbackResult(connection, 'not_found');
      if (ownerUserId) await requireActiveMembership(connection, {
        facilityId, userId: ownerUserId, lock: true,
      });
      if (rows[0].deactivated_at != null) return await rollbackResult(connection, 'inactive');

      const next = {
        name: input.name ?? rows[0].name,
        city: input.city ?? rows[0].city,
        address: input.address ?? rows[0].address,
        description: input.description ?? rows[0].description,
      };
      const changed = Object.entries(next).some(([key, value]) => value !== rows[0][key]);
      if (changed) {
        await connection.execute(
          `UPDATE facilities SET name = ?, city = ?, city_normalized = ?, address = ?, description = ?
           WHERE id = ?`,
          [next.name, next.city, next.city?.normalize('NFC').toLowerCase() ?? null,
            next.address, next.description, facilityId],
        );
      }
      await connection.commit();
      return {
        status: 'ok',
        changed,
        facility: mapFacility({ ...rows[0], ...next }),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function listCourts({ facilityId, state, limit, cursor }) {
    const [facilities] = await pool.execute('SELECT id FROM facilities WHERE id = ?', [facilityId]);
    if (facilities.length === 0) return null;

    const conditions = ['c.facility_id = ?', ...stateCondition('c.deactivated_at', state)];
    const values = [facilityId];
    if (cursor) {
      conditions.push('(c.name > ? OR (c.name = ? AND c.id > ?))');
      values.push(cursor.name, cursor.name, cursor.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `SELECT c.id, c.name, c.description, c.sport_code, c.minimum_separation_minutes,
              c.start_interval_minutes, c.created_at, c.deactivated_at,
              f.id AS facility_id, f.name AS facility_name
       FROM courts AS c
       INNER JOIN facilities AS f ON f.id = c.facility_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.name ASC, c.id ASC
       LIMIT ?`,
      values,
    );
    await attachDurations(pool, rows);
    return rows.map(mapCourt);
  }

  async function getCourt(courtId) {
    const [rows] = await pool.execute(
      `SELECT c.id, c.name, c.description, c.sport_code, c.minimum_separation_minutes,
              c.start_interval_minutes, c.created_at, c.deactivated_at,
              f.id AS facility_id, f.name AS facility_name
       FROM courts AS c
       INNER JOIN facilities AS f ON f.id = c.facility_id
       WHERE c.id = ?`,
      [courtId],
    );
    if (rows.length === 0) return null;
    await attachDurations(pool, rows);
    return mapCourt(rows[0]);
  }

  async function updateCourt({ courtId, input, ownerUserId }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT c.id, c.name, c.description, c.sport_code, c.minimum_separation_minutes,
                c.start_interval_minutes, c.created_at, c.deactivated_at,
                f.id AS facility_id, f.name AS facility_name,
                f.deactivated_at AS facility_deactivated_at
         FROM courts AS c
         INNER JOIN facilities AS f ON f.id = c.facility_id
         WHERE c.id = ? FOR UPDATE`,
        [courtId],
      );
      if (rows.length === 0) return await rollbackResult(connection, 'not_found');
      const current = rows[0];
      if (ownerUserId) await requireActiveMembership(connection, {
        facilityId: current.facility_id, userId: ownerUserId, lock: true,
      });
      if (current.deactivated_at != null || current.facility_deactivated_at != null) {
        return await rollbackResult(connection, 'inactive');
      }

      const name = input.name ?? current.name;
      const description = Object.hasOwn(input, 'description')
        ? input.description
        : current.description;
      const sportCode = Object.hasOwn(input, 'sportCode') ? input.sportCode : current.sport_code;
      const changed = name !== current.name || description !== current.description
        || sportCode !== current.sport_code;
      if (changed) {
        await connection.execute(
          'UPDATE courts SET name = ?, description = ?, sport_code = ? WHERE id = ?',
          [name, description, sportCode, courtId],
        );
      }
      const [durations] = await connection.execute(
        `SELECT duration_minutes FROM court_allowed_durations
         WHERE court_id = ? ORDER BY duration_minutes ASC`,
        [courtId],
      );
      await connection.commit();
      return {
        status: 'ok',
        changed,
        court: mapCourt({
          ...current,
          name,
          description,
          sport_code: sportCode,
          allowedDurationsMinutes: durations.map((row) => row.duration_minutes),
        }),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function stateCondition(column, state) {
  if (state === 'active') return [`${column} IS NULL`];
  if (state === 'inactive') return [`${column} IS NOT NULL`];
  return ['TRUE'];
}

async function attachDurations(executor, rows) {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.id);
  const [durations] = await executor.execute(
    `SELECT court_id, duration_minutes FROM court_allowed_durations
     WHERE court_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY court_id ASC, duration_minutes ASC`,
    ids,
  );
  const byCourt = new Map();
  for (const duration of durations) {
    const values = byCourt.get(String(duration.court_id)) ?? [];
    values.push(duration.duration_minutes);
    byCourt.set(String(duration.court_id), values);
  }
  for (const row of rows) row.allowedDurationsMinutes = byCourt.get(String(row.id)) ?? [];
}

async function rollbackResult(connection, status) {
  await connection.rollback();
  return { status };
}

function mapFacility(row) {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.timezone,
    minimumAdvanceMinutes: row.minimum_advance_minutes,
    maximumAdvanceMinutes: row.maximum_advance_minutes,
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at,
    ...(Object.hasOwn(row, 'city') ? {
      city: row.city, address: row.address, description: row.description,
      publicationState: row.publication_status,
      publishedAt: row.published_at,
      publishedByUserId: row.published_by_user_id == null ? null : String(row.published_by_user_id),
      unpublishedAt: row.unpublished_at,
    } : {}),
  };
}

function mapCourt(row) {
  return {
    id: row.id,
    facility: { id: row.facility_id, name: row.facility_name },
    name: row.name,
    description: row.description,
    ...(Object.hasOwn(row, 'sport_code') ? { sportCode: row.sport_code } : {}),
    minimumSeparationMinutes: row.minimum_separation_minutes,
    startIntervalMinutes: row.start_interval_minutes,
    allowedDurationsMinutes: row.allowedDurationsMinutes ?? [],
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at,
  };
}
