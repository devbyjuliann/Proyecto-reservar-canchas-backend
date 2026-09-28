import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const SELECT = `SELECT a.id, a.user_id, a.business_name, a.message, a.status,
  a.created_at, a.decided_at, a.decided_by_user_id, a.rejection_reason,
  u.name AS applicant_name, u.email AS applicant_email
  FROM owner_applications a JOIN users u ON u.id = a.user_id`;

export function createMySqlOwnerApplicationsAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) {
    throw new TypeError('A mysql2 promise pool is required');
  }
  return Object.freeze({ create, list, get, decide });

  async function create({ userId, businessName, message, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        'SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL FOR UPDATE',
        [userId],
      );
      if (!users.length) {
        await connection.rollback();
        return 'inactive';
      }
      const [roles] = await connection.execute(
        "SELECT role_code FROM user_roles WHERE user_id = ? AND role_code = 'PROPIETARIO'",
        [userId],
      );
      if (roles.length) {
        await connection.rollback();
        return 'already_owner';
      }
      const [pending] = await connection.execute(
        "SELECT id FROM owner_applications WHERE user_id = ? AND status = 'PENDIENTE'",
        [userId],
      );
      if (pending.length) {
        await connection.rollback();
        return 'owner_application_pending';
      }
      const [insert] = await connection.execute(
        `INSERT INTO owner_applications
          (user_id, business_name, message, status, created_at)
         VALUES (?, ?, ?, 'PENDIENTE', ?)`,
        [userId, businessName, message, toMySqlDateTime(now)],
      );
      const application = await load(connection, insert.insertId);
      await connection.commit();
      return application;
    } catch (caught) {
      await connection.rollback();
      if (caught.code === 'ER_DUP_ENTRY') return 'owner_application_pending';
      throw caught;
    } finally {
      connection.release();
    }
  }

  async function list({ kind, userId, status, limit, position }) {
    const conditions = [];
    const values = [];
    if (kind === 'own') {
      conditions.push('a.user_id = ?');
      values.push(userId);
    } else if (status !== 'all') {
      conditions.push('a.status = ?');
      values.push(status);
    }
    const ascending = kind === 'admin' && status === 'PENDIENTE';
    if (position) {
      const comparison = ascending ? '>' : '<';
      conditions.push(`(a.created_at ${comparison} ? OR (a.created_at = ? AND a.id ${comparison} ?))`);
      const createdAt = toMySqlDateTime(position.createdAt);
      values.push(createdAt, createdAt, position.id);
    }
    values.push(limit);
    const [rows] = await pool.execute(
      `${SELECT} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY a.created_at ${ascending ? 'ASC' : 'DESC'}, a.id ${ascending ? 'ASC' : 'DESC'}
       LIMIT ?`,
      values,
    );
    return rows.map((row) => mapApplication(row, kind === 'admin'));
  }

  async function get({ applicationId, userId }) {
    const [rows] = await pool.execute(
      `${SELECT} WHERE a.id = ?${userId === undefined ? '' : ' AND a.user_id = ?'}`,
      userId === undefined ? [applicationId] : [applicationId, userId],
    );
    return rows.length ? mapApplication(rows[0], userId === undefined) : null;
  }

  async function decide({ applicationId, reviewerId, decision, reason, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [initial] = await connection.execute(
        'SELECT user_id FROM owner_applications WHERE id = ?', [applicationId],
      );
      if (!initial.length) {
        await connection.rollback();
        return null;
      }
      if (String(initial[0].user_id) === reviewerId) {
        await connection.rollback();
        return 'forbidden';
      }
      const [reviewers] = await connection.execute(
        `SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
         WHERE u.id = ? AND u.deactivated_at IS NULL AND r.role_code = 'ADMINISTRADOR'`,
        [reviewerId],
      );
      if (!reviewers.length) {
        await connection.rollback();
        return 'forbidden';
      }
      // Lock the applicant before the application: creation follows the same order.
      const [users] = await connection.execute(
        'SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL FOR UPDATE',
        [initial[0].user_id],
      );
      if (!users.length) {
        await connection.rollback();
        return 'invalid_owner_application_state';
      }
      const [applications] = await connection.execute(
        'SELECT user_id, status FROM owner_applications WHERE id = ? FOR UPDATE',
        [applicationId],
      );
      if (!applications.length || applications[0].status !== 'PENDIENTE'
        || String(applications[0].user_id) !== String(initial[0].user_id)) {
        await connection.rollback();
        return 'invalid_owner_application_state';
      }
      await connection.execute(
        `UPDATE owner_applications
         SET status = ?, decided_at = ?, decided_by_user_id = ?, rejection_reason = ?
         WHERE id = ?`,
        [decision, toMySqlDateTime(now), reviewerId, reason ?? null, applicationId],
      );
      let user;
      if (decision === 'APROBADA') {
        const [roles] = await connection.execute(
          "SELECT role_code FROM user_roles WHERE user_id = ? AND role_code = 'PROPIETARIO'",
          [initial[0].user_id],
        );
        if (!roles.length) {
          await connection.execute(
            "INSERT INTO user_roles (user_id, role_code) VALUES (?, 'PROPIETARIO')",
            [initial[0].user_id],
          );
        }
        const [currentRoles] = await connection.execute(
          'SELECT role_code FROM user_roles WHERE user_id = ? ORDER BY role_code',
          [initial[0].user_id],
        );
        user = { id: String(initial[0].user_id), roles: currentRoles.map((row) => row.role_code) };
      }
      const application = await load(connection, applicationId, true);
      await connection.commit();
      return user ? { ownerApplication: application, user } : { ownerApplication: application };
    } catch (caught) {
      await connection.rollback();
      throw caught;
    } finally {
      connection.release();
    }
  }
}

async function load(connection, id, includeUser = false) {
  const [rows] = await connection.execute(`${SELECT} WHERE a.id = ?`, [id]);
  return rows.length ? mapApplication(rows[0], includeUser) : null;
}

function mapApplication(row, includeUser) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    businessName: row.business_name,
    message: row.message,
    status: row.status,
    createdAt: toInstantString(row.created_at),
    decidedAt: row.decided_at == null ? null : toInstantString(row.decided_at),
    reviewerUserId: row.decided_by_user_id == null ? null : String(row.decided_by_user_id),
    decisionReason: row.rejection_reason,
    ...(includeUser ? { user: { id: String(row.user_id), name: row.applicant_name, email: row.applicant_email } } : {}),
  };
}
