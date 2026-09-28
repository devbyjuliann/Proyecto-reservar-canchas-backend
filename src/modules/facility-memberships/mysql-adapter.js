import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const MEMBERSHIP_SELECT = `SELECT m.id, m.facility_id, m.user_id, m.membership_type,
  m.active, m.created_at, m.deactivated_at, m.created_by_user_id,
  u.name AS user_name, u.email AS user_email
  FROM facility_memberships m JOIN users u ON u.id = m.user_id`;
const FACILITY_SELECT = `SELECT f.id, f.name, f.timezone, f.minimum_advance_minutes,
  f.maximum_advance_minutes, f.created_at, f.deactivated_at,
  f.city, f.address, f.description, f.publication_status, f.published_at,
  f.published_by_user_id, f.unpublished_at FROM facilities f`;

export function createMySqlFacilityMembershipsAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) throw new TypeError('A mysql2 promise pool is required');
  return Object.freeze({ facilityExists, listMemberships, getMembership, assign, revoke,
    listOwnedFacilities, getOwnedFacility, resolveCourtFacilityId, resolveUnavailabilityCourtId });

  async function resolveCourtFacilityId(courtId) {
    const [rows] = await pool.execute('SELECT facility_id FROM courts WHERE id = ?', [courtId]);
    return rows.length ? String(rows[0].facility_id) : null;
  }

  async function resolveUnavailabilityCourtId(unavailabilityId) {
    const [rows] = await pool.execute('SELECT court_id FROM court_unavailabilities WHERE id = ?',
      [unavailabilityId]);
    return rows.length ? String(rows[0].court_id) : null;
  }

  async function facilityExists(facilityId) {
    const [rows] = await pool.execute('SELECT id FROM facilities WHERE id = ?', [facilityId]);
    return rows.length !== 0;
  }

  async function listMemberships({ facilityId, limit, position }) {
    const values = [facilityId];
    let after = '';
    if (position) {
      after = ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
      const createdAt = toMySqlDateTime(position.createdAt);
      values.push(createdAt, createdAt, position.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `${MEMBERSHIP_SELECT} WHERE m.facility_id = ?${after}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, values,
    );
    return rows.map(mapMembership);
  }

  async function getMembership({ facilityId, membershipId }) {
    const [rows] = await pool.execute(
      `${MEMBERSHIP_SELECT} WHERE m.facility_id = ? AND m.id = ?`,
      [facilityId, membershipId],
    );
    return rows.length ? mapMembership(rows[0]) : null;
  }

  async function assign({ facilityId, userId, createdByUserId, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [facilities] = await connection.execute(
        'SELECT id FROM facilities WHERE id = ? FOR UPDATE', [facilityId],
      );
      if (!facilities.length) return await rollbackValue(connection, 'resource_not_found');
      const [users] = await connection.execute(
        'SELECT id, deactivated_at FROM users WHERE id = ? FOR UPDATE', [userId],
      );
      if (!users.length) return await rollbackValue(connection, 'resource_not_found');
      if (users[0].deactivated_at != null) return await rollbackValue(connection, 'resource_inactive');
      const [roles] = await connection.execute(
        "SELECT role_code FROM user_roles WHERE user_id = ? AND role_code = 'PROPIETARIO'",
        [userId],
      );
      if (!roles.length) return await rollbackValue(connection, 'membership_conflict');
      const [current] = await connection.execute(
        'SELECT id FROM facility_memberships WHERE facility_id = ? AND user_id = ? AND active = 1',
        [facilityId, userId],
      );
      if (current.length) return await rollbackValue(connection, 'membership_conflict');
      const [insert] = await connection.execute(
        `INSERT INTO facility_memberships
         (facility_id, user_id, membership_type, active, created_at, created_by_user_id)
         VALUES (?, ?, 'PROPIETARIO', 1, ?, ?)`,
        [facilityId, userId, toMySqlDateTime(now), createdByUserId],
      );
      const membership = await load(connection, facilityId, insert.insertId);
      await connection.commit();
      return membership;
    } catch (caught) {
      await connection.rollback();
      if (caught.code === 'ER_DUP_ENTRY') return 'membership_conflict';
      throw caught;
    } finally {
      connection.release();
    }
  }

  async function revoke({ facilityId, membershipId, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT active FROM facility_memberships WHERE id = ? AND facility_id = ? FOR UPDATE',
        [membershipId, facilityId],
      );
      if (!rows.length) return await rollbackValue(connection, null);
      if (Number(rows[0].active) === 0) {
        const membership = await load(connection, facilityId, membershipId);
        await connection.rollback();
        return { membership, changed: false };
      }
      await connection.execute(
        `UPDATE facility_memberships SET active = 0, deactivated_at = ?
         WHERE id = ? AND facility_id = ?`,
        [toMySqlDateTime(now), membershipId, facilityId],
      );
      const membership = await load(connection, facilityId, membershipId);
      await connection.commit();
      return { membership, changed: true };
    } catch (caught) {
      await connection.rollback();
      throw caught;
    } finally {
      connection.release();
    }
  }

  async function listOwnedFacilities({ userId, limit, position }) {
    const values = [userId];
    let after = '';
    if (position) {
      after = ' AND (f.name > ? OR (f.name = ? AND f.id > ?))';
      values.push(position.name, position.name, position.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `${FACILITY_SELECT}
       JOIN facility_memberships m ON m.facility_id = f.id
       JOIN users u ON u.id = m.user_id AND u.deactivated_at IS NULL
       JOIN user_roles r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
       WHERE m.user_id = ? AND m.active = 1${after}
       ORDER BY f.name ASC, f.id ASC LIMIT ?`, values,
    );
    return rows.map(mapFacility);
  }

  async function getOwnedFacility({ userId, facilityId }) {
    const [rows] = await pool.execute(
      `${FACILITY_SELECT}
       JOIN facility_memberships m ON m.facility_id = f.id
       JOIN users u ON u.id = m.user_id AND u.deactivated_at IS NULL
       JOIN user_roles r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
       WHERE m.user_id = ? AND m.facility_id = ? AND m.active = 1`,
      [userId, facilityId],
    );
    return rows.length ? mapFacility(rows[0]) : null;
  }
}

async function load(connection, facilityId, membershipId) {
  const [rows] = await connection.execute(
    `${MEMBERSHIP_SELECT} WHERE m.facility_id = ? AND m.id = ?`,
    [facilityId, membershipId],
  );
  return mapMembership(rows[0]);
}

async function rollbackValue(connection, value) {
  await connection.rollback();
  return value;
}

function mapMembership(row) {
  return {
    id: String(row.id), facilityId: String(row.facility_id), userId: String(row.user_id),
    membershipRole: row.membership_type, active: Number(row.active) === 1,
    grantedAt: toInstantString(row.created_at),
    revokedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
    createdByUserId: String(row.created_by_user_id),
    user: { id: String(row.user_id), name: row.user_name, email: row.user_email },
  };
}

function mapFacility(row) {
  return {
    id: String(row.id), name: row.name, timeZone: row.timezone,
    minimumAdvanceMinutes: Number(row.minimum_advance_minutes),
    maximumAdvanceMinutes: Number(row.maximum_advance_minutes),
    createdAt: toInstantString(row.created_at),
    deactivatedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
    state: row.deactivated_at == null ? 'active' : 'inactive',
    city: row.city, address: row.address, description: row.description,
    publicationState: row.publication_status,
    publishedAt: row.published_at == null ? null : toInstantString(row.published_at),
    publishedByUserId: row.published_by_user_id == null ? null : String(row.published_by_user_id),
    unpublishedAt: row.unpublished_at == null ? null : toInstantString(row.unpublished_at),
  };
}
