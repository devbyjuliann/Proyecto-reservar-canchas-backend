import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const OWNER_SELECT = `SELECT u.id, u.name, u.email, u.created_at, u.deactivated_at,
  u.owner_suspended_at, COUNT(DISTINCT CASE WHEN m.active = 1 THEN m.facility_id END) AS facility_count
  FROM users u
  JOIN user_roles r ON r.user_id = u.id AND r.role_code = 'PROPIETARIO'
  LEFT JOIN facility_memberships m ON m.user_id = u.id`;

export function createMySqlOwnerDirectoryAdapter({ pool }) {
  if (!pool?.execute) throw new TypeError('A mysql2 promise pool is required');
  return Object.freeze({ listOwners, getOwner, changeSuspension, isSuspended });

  async function isSuspended(userId) {
    const [rows] = await pool.execute('SELECT owner_suspended_at FROM users WHERE id = ?', [userId]);
    return rows.length === 1 && rows[0].owner_suspended_at !== null;
  }

  async function listOwners({ query, afterId, limit }) {
    const values = [];
    let where = '';
    if (query) {
      const needle = `%${query.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
      where = " WHERE (u.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!')";
      values.push(needle, needle);
    }
    if (afterId) {
      where += where ? ' AND u.id > ?' : ' WHERE u.id > ?';
      values.push(afterId);
    }
    const [rows] = await pool.execute(`${OWNER_SELECT}${where}
      GROUP BY u.id, u.name, u.email, u.created_at, u.deactivated_at, u.owner_suspended_at
      ORDER BY u.id ASC LIMIT ?`, [...values, limit]);
    return rows.map(present);
  }

  async function getOwner(ownerId) {
    const [rows] = await pool.execute(`${OWNER_SELECT} WHERE u.id = ?
      GROUP BY u.id, u.name, u.email, u.created_at, u.deactivated_at, u.owner_suspended_at`, [ownerId]);
    if (!rows.length) return null;
    const [memberships] = await pool.execute(
      `SELECT m.id, m.facility_id, m.membership_type, m.active, m.created_at, m.deactivated_at,
        f.name AS facility_name, f.deactivated_at AS facility_deactivated_at, f.publication_status
       FROM facility_memberships m JOIN facilities f ON f.id = m.facility_id
       WHERE m.user_id = ? ORDER BY m.id DESC`, [ownerId],
    );
    const [roles] = await pool.execute('SELECT role_code FROM user_roles WHERE user_id = ? ORDER BY role_code', [ownerId]);
    return { ...present(rows[0]), roles: roles.map((role) => role.role_code), memberships: memberships.map((row) => ({
      id: String(row.id), membershipRole: row.membership_type, active: Number(row.active) === 1,
      grantedAt: toInstantString(row.created_at),
      revokedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
      facility: { id: String(row.facility_id), name: row.facility_name,
        state: row.facility_deactivated_at == null ? 'active' : 'inactive',
        publicationState: row.publication_status },
    })) };
  }

  async function changeSuspension({ ownerId, suspended, now }) {
    const [result] = await pool.execute(
      `UPDATE users u
       SET u.owner_suspended_at = ?
       WHERE u.id = ? AND u.deactivated_at IS NULL
         AND ${suspended ? 'u.owner_suspended_at IS NULL' : 'u.owner_suspended_at IS NOT NULL'}
         AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role_code = 'PROPIETARIO')`,
      [suspended ? toMySqlDateTime(now) : null, ownerId],
    );
    const owner = await getOwner(ownerId);
    return owner ? { owner, changed: result.affectedRows === 1 } : null;
  }
}

function present(row) {
  return {
    id: String(row.id), name: row.name, email: row.email,
    createdAt: toInstantString(row.created_at),
    deactivatedAt: row.deactivated_at == null ? null : toInstantString(row.deactivated_at),
    ownerSuspendedAt: row.owner_suspended_at == null ? null : toInstantString(row.owner_suspended_at),
    state: row.deactivated_at != null ? 'inactive' : row.owner_suspended_at == null ? 'active' : 'suspended',
    facilityCount: Number(row.facility_count),
  };
}
