import { toInstantString, toMySqlDateTime } from '../../shared/time.js';

const BOOTSTRAP_LOCK = 'reserva_canchas_bootstrap_admin';

export function createMySqlAuthAdapter({ pool }) {
  if (!pool?.execute || !pool?.getConnection) {
    throw new TypeError('A mysql2 promise pool is required');
  }

  return Object.freeze({
    register,
    findAccountByEmail,
    createSession,
    findActiveSession,
    revokeSession,
    bootstrapAdministrator,
    resetAdministratorPassword,
    issuePasswordReset,
    invalidatePasswordReset,
    consumePasswordReset,
  });

  async function register({ name, email, credential, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const user = await insertUserWithCredential(connection, {
        name,
        email,
        credential,
        now,
        roles: ['USUARIO'],
      });
      await connection.commit();
      return user;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function findAccountByEmail(email) {
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.created_at, u.deactivated_at,
              c.password_hash, c.password_salt, c.algorithm,
              c.scrypt_cost, c.scrypt_block_size, c.scrypt_parallelization,
              ur.role_code
       FROM users AS u
       JOIN user_credentials AS c ON c.user_id = u.id
       LEFT JOIN user_roles AS ur ON ur.user_id = u.id
       WHERE u.email = ?
       ORDER BY ur.role_code`,
      [email],
    );
    if (rows.length === 0) return null;
    const user = mapUserRows(rows);
    return {
      user,
      deactivatedAt: rows[0].deactivated_at === null
        ? null
        : toInstantString(rows[0].deactivated_at),
      credential: mapCredential(rows[0]),
    };
  }

  async function createSession({ userId, tokenHash, now, expiresAt }) {
    const [result] = await pool.execute(
      `INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
       SELECT id, ?, ?, ?
       FROM users
       WHERE id = ? AND deactivated_at IS NULL`,
      [tokenHash, toMySqlDateTime(now), toMySqlDateTime(expiresAt), userId],
    );
    if (result.affectedRows === 0) return null;
    return { id: String(result.insertId) };
  }

  async function findActiveSession({ tokenHash, now }) {
    const [rows] = await pool.execute(
      `SELECT s.id AS session_id, u.id, u.name, u.email, u.created_at, ur.role_code
       FROM sessions AS s
       JOIN users AS u ON u.id = s.user_id
       LEFT JOIN user_roles AS ur ON ur.user_id = u.id
       WHERE s.token_hash = ?
         AND s.revoked_at IS NULL
         AND s.expires_at > ?
         AND u.deactivated_at IS NULL
       ORDER BY ur.role_code`,
      [tokenHash, toMySqlDateTime(now)],
    );
    if (rows.length === 0) return null;
    return { sessionId: String(rows[0].session_id), user: mapUserRows(rows) };
  }

  async function revokeSession({ tokenHash, now }) {
    await pool.execute(
      `UPDATE sessions
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE token_hash = ?`,
      [toMySqlDateTime(now), tokenHash],
    );
  }

  async function bootstrapAdministrator({ name, email, credential, now }) {
    const connection = await pool.getConnection();
    let locked = false;
    try {
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [BOOTSTRAP_LOCK]);
      locked = Number(lockRows[0]?.acquired) === 1;
      if (!locked) throw new Error('Could not acquire administrator bootstrap lock');
      await connection.beginTransaction();
      const [administrators] = await connection.execute(
        "SELECT user_id FROM user_roles WHERE role_code = 'ADMINISTRADOR' LIMIT 1",
      );
      if (administrators.length > 0) {
        const error = new Error('An administrator already exists');
        error.code = 'ADMINISTRATOR_ALREADY_EXISTS';
        throw error;
      }
      const user = await insertUserWithCredential(connection, {
        name,
        email,
        credential,
        now,
        roles: ['USUARIO', 'ADMINISTRADOR'],
      });
      await connection.commit();
      return user;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      if (locked) {
        try {
          await connection.execute('SELECT RELEASE_LOCK(?)', [BOOTSTRAP_LOCK]);
        } catch {
          // Releasing the connection also releases its advisory lock.
        }
      }
      connection.release();
    }
  }

  async function resetAdministratorPassword({ email, credential, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [administrators] = await connection.execute(
        `SELECT u.id FROM users AS u
         JOIN user_roles AS ur ON ur.user_id = u.id
         WHERE u.email = ? AND ur.role_code = 'ADMINISTRADOR'
         FOR UPDATE`,
        [email],
      );
      if (administrators.length === 0) {
        await connection.rollback();
        return false;
      }
      const timestamp = toMySqlDateTime(now);
      const userId = administrators[0].id;
      await connection.execute(
        `UPDATE user_credentials
         SET password_hash = ?, password_salt = ?, algorithm = ?, scrypt_cost = ?,
             scrypt_block_size = ?, scrypt_parallelization = ?, updated_at = ?
         WHERE user_id = ?`,
        [
          credential.hash,
          credential.salt,
          credential.algorithm,
          credential.parameters.cost,
          credential.parameters.blockSize,
          credential.parameters.parallelization,
          timestamp,
          userId,
        ],
      );
      await connection.execute(
        'UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?',
        [timestamp, userId],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function issuePasswordReset({ userId, tokenHash, now, expiresAt }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        'SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL FOR UPDATE', [userId],
      );
      if (!users.length) { await connection.rollback(); return false; }
      const timestamp = toMySqlDateTime(now);
      await connection.execute(
        'UPDATE password_reset_tokens SET consumed_at = GREATEST(?, created_at) WHERE user_id = ? AND consumed_at IS NULL',
        [timestamp, userId],
      );
      await connection.execute(
        'INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [userId, tokenHash, timestamp, toMySqlDateTime(expiresAt)],
      );
      await connection.commit();
      return true;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async function invalidatePasswordReset({ tokenHash, now }) {
    await pool.execute(
      'UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
      [toMySqlDateTime(now), tokenHash],
    );
  }

  async function consumePasswordReset({ tokenHash, credential, now }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [tokens] = await connection.execute(
        'SELECT user_id FROM password_reset_tokens WHERE token_hash = ?', [tokenHash],
      );
      if (!tokens.length) { await connection.rollback(); return false; }
      const userId = tokens[0].user_id;
      // Both issuing and consuming lock the user before touching token rows.
      const [users] = await connection.execute(
        'SELECT id FROM users WHERE id = ? AND deactivated_at IS NULL FOR UPDATE', [userId],
      );
      if (!users.length) { await connection.rollback(); return false; }
      const timestamp = toMySqlDateTime(now);
      const [consumed] = await connection.execute(
        `UPDATE password_reset_tokens SET consumed_at = ?
         WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        [timestamp, tokenHash, userId, timestamp],
      );
      if (!consumed.affectedRows) { await connection.rollback(); return false; }
      await connection.execute(
        `UPDATE user_credentials
         SET password_hash = ?, password_salt = ?, algorithm = ?, scrypt_cost = ?,
             scrypt_block_size = ?, scrypt_parallelization = ?, updated_at = ?
         WHERE user_id = ?`,
        [credential.hash, credential.salt, credential.algorithm, credential.parameters.cost,
          credential.parameters.blockSize, credential.parameters.parallelization, timestamp, userId],
      );
      await connection.execute(
        'UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?',
        [timestamp, userId],
      );
      await connection.execute(
        'UPDATE password_reset_tokens SET consumed_at = GREATEST(?, created_at) WHERE user_id = ? AND consumed_at IS NULL',
        [timestamp, userId],
      );
      await connection.commit();
      return true;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
}

async function insertUserWithCredential(connection, { name, email, credential, now, roles }) {
  const timestamp = toMySqlDateTime(now);
  const [result] = await connection.execute(
    'INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)',
    [name, email, timestamp],
  );
  await connection.execute(
    `INSERT INTO user_credentials
       (user_id, password_hash, password_salt, algorithm,
        scrypt_cost, scrypt_block_size, scrypt_parallelization, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      result.insertId,
      credential.hash,
      credential.salt,
      credential.algorithm,
      credential.parameters.cost,
      credential.parameters.blockSize,
      credential.parameters.parallelization,
      timestamp,
      timestamp,
    ],
  );
  for (const role of roles) {
    await connection.execute(
      'INSERT INTO user_roles (user_id, role_code) VALUES (?, ?)',
      [result.insertId, role],
    );
  }
  return {
    id: String(result.insertId),
    name,
    email,
    createdAt: toInstantString(now),
    roles: [...roles].sort(),
  };
}

function mapCredential(row) {
  return {
    algorithm: row.algorithm,
    hash: Buffer.from(row.password_hash),
    salt: Buffer.from(row.password_salt),
    parameters: {
      cost: Number(row.scrypt_cost),
      blockSize: Number(row.scrypt_block_size),
      parallelization: Number(row.scrypt_parallelization),
    },
  };
}

function mapUserRows(rows) {
  const first = rows[0];
  return {
    id: String(first.id),
    name: first.name,
    email: first.email,
    createdAt: toInstantString(first.created_at),
    roles: rows.flatMap((row) => (row.role_code ? [row.role_code] : [])),
  };
}
