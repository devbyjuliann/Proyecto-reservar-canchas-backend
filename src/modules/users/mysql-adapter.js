export function createMySqlUsersAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) {
    throw new TypeError('A mysql2 promise pool is required');
  }

  return Object.freeze({ createUser, findById, assignRole });

  async function createUser({ name, email }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO users (name, email) VALUES (?, ?)',
        [name, email],
      );
      await connection.execute(
        "INSERT INTO user_roles (user_id, role_code) VALUES (?, 'USUARIO')",
        [result.insertId],
      );
      await connection.commit();
      return await findById(result.insertId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function findById(userId) {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.created_at, ur.role_code
       FROM users AS u
       LEFT JOIN user_roles AS ur ON ur.user_id = u.id
       WHERE u.id = ? AND u.deactivated_at IS NULL
       ORDER BY ur.role_code`,
      [userId],
    );
    return mapUserRows(rows);
  }

  async function assignRole(userId, roleCode) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        `SELECT id
         FROM users
         WHERE id = ? AND deactivated_at IS NULL
         FOR UPDATE`,
        [userId],
      );
      if (users.length === 0) {
        await connection.rollback();
        return null;
      }

      await connection.execute(
        `INSERT INTO user_roles (user_id, role_code)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE role_code = VALUES(role_code)`,
        [userId, roleCode],
      );
      await connection.commit();
      return await findById(userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function mapUserRows(rows) {
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];
  return {
    id: first.id,
    name: first.name,
    email: first.email,
    createdAt: first.created_at,
    roles: rows.flatMap((row) => (row.role_code ? [row.role_code] : [])),
  };
}
