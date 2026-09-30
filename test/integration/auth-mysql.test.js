import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMigrator } from '../../src/database/migrator.js';
import { createMigrationConnection } from '../../src/database/mysql.js';
import { createMySqlPool } from '../../src/database/pool.js';
import {
  createAuthModule,
  createMySqlAuthAdapter,
  hashPassword,
  hashSessionToken,
} from '../../src/modules/auth/index.js';

const REQUIRED_DB_ENV = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const MYSQL_AVAILABLE = process.env.NODE_ENV === 'test'
  && REQUIRED_DB_ENV.every((name) => process.env[name] !== undefined)
  && process.env.DB_NAME.endsWith('_test');
const NOW = '2026-09-25T12:00:00.000000Z';
const TEST_EMAIL_SUFFIX = '@auth-integration.test';

describe('authentication MySQL integration', { skip: !MYSQL_AVAILABLE, timeout: 30_000 }, () => {
  let pool;
  let adapter;
  let auth;

  before(async () => {
    const config = loadDatabaseConfig({ forMigrations: true });
    const migrationConnection = await createMigrationConnection(config);
    try {
      await createMigrator(migrationConnection).up();
    } finally {
      await migrationConnection.end();
    }
    pool = createMySqlPool(loadDatabaseConfig());
    adapter = createMySqlAuthAdapter({ pool });
    auth = createAuthModule({ adapter, clock: { now: () => NOW } });
  });

  afterEach(async () => {
    if (!pool) return;
    const [users] = await pool.execute(
      'SELECT id FROM users WHERE email LIKE ?',
      [`%${TEST_EMAIL_SUFFIX}`],
    );
    const ids = users.map(({ id }) => id);
    for (const id of ids) {
      await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_credentials WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    }
  });

  after(async () => {
    await pool?.end();
  });

  it('registers user, credential, and only USUARIO atomically', async () => {
    const email = uniqueEmail();
    const user = await auth.register(registration(email));
    assert.deepEqual(user.roles, ['USUARIO']);

    const [credentials] = await pool.execute(
      `SELECT c.password_hash, c.password_salt, c.algorithm, ur.role_code
       FROM user_credentials AS c
       JOIN user_roles AS ur ON ur.user_id = c.user_id
       WHERE c.user_id = ?`,
      [user.id],
    );
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].password_hash.length, 64);
    assert.equal(credentials[0].password_salt.length >= 16, true);
    assert.equal(credentials[0].algorithm, 'SCRYPT');
    assert.equal(credentials[0].role_code, 'USUARIO');
  });

  it('rolls back the user when credential persistence fails', async () => {
    const email = uniqueEmail();
    const credential = await hashPassword('password value');
    await assert.rejects(adapter.register({
      name: 'Rollback User',
      email,
      credential: { ...credential, salt: Buffer.alloc(15) },
      now: NOW,
    }));
    const [rows] = await pool.execute(
      `SELECT u.id, c.user_id AS credential_user_id, ur.user_id AS role_user_id
       FROM users AS u
       LEFT JOIN user_credentials AS c ON c.user_id = u.id
       LEFT JOIN user_roles AS ur ON ur.user_id = u.id
       WHERE u.email = ?`,
      [email],
    );
    assert.equal(rows.length, 0);
  });

  it('allows one concurrent registration for the same normalized email', async () => {
    const email = uniqueEmail();
    const results = await Promise.allSettled([
      auth.register(registration(email.toUpperCase())),
      auth.register(registration(`  ${email}  `)),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.code, 'email_already_registered');
    const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    assert.equal(rows.length, 1);
  });

  it('creates, resolves, expires, and revokes sessions using only the token hash', async () => {
    const user = await auth.register(registration(uniqueEmail()));
    const login = await auth.login({ email: user.email, password: 'password value' });
    const [rows] = await pool.execute(
      'SELECT id, token_hash, expires_at, revoked_at FROM sessions WHERE id = ?',
      [login.sessionId],
    );
    assert.deepEqual(rows[0].token_hash, hashSessionToken(login.token));
    assert.equal(String(rows[0].token_hash).includes(login.token), false);
    assert.equal((await auth.resolveSession(login.token)).user.id, user.id);

    await auth.revokeSession(login.token);
    assert.equal(await auth.resolveSession(login.token), null);
    const [revoked] = await pool.execute('SELECT revoked_at FROM sessions WHERE id = ?', [login.sessionId]);
    assert.notEqual(revoked[0].revoked_at, null);

    const second = await auth.login({ email: user.email, password: 'password value' });
    const futureAuth = createAuthModule({
      adapter,
      clock: { now: () => '2026-10-25T12:00:00.000001Z' },
    });
    assert.equal(await futureAuth.resolveSession(second.token), null);
  });

  it('resets only an administrator credential with scrypt and revokes every active session', async () => {
    const email = uniqueEmail();
    const administrator = await auth.register(registration(email));
    await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'ADMINISTRADOR')", [administrator.id]);
    const first = await auth.login({ email, password: 'password value' });
    const second = await auth.login({ email, password: 'password value' });

    assert.equal(await auth.resetAdministratorPassword({
      email: ` ${email.toUpperCase()} `,
      password: 'replacement password value',
    }), true);
    assert.equal(await auth.resolveSession(first.token), null);
    assert.equal(await auth.resolveSession(second.token), null);
    const [credentials] = await pool.execute(
      'SELECT algorithm, password_hash, password_salt FROM user_credentials WHERE user_id = ?',
      [administrator.id],
    );
    const [sessions] = await pool.execute('SELECT revoked_at FROM sessions WHERE user_id = ?', [administrator.id]);
    assert.equal(credentials[0].algorithm, 'SCRYPT');
    assert.equal(credentials[0].password_hash.length, 64);
    assert.equal(credentials[0].password_salt.length >= 16, true);
    assert.equal(sessions.every((session) => session.revoked_at !== null), true);

    await assert.rejects(auth.login({ email, password: 'password value' }), { code: 'invalid_credentials' });
    assert.equal((await auth.login({ email, password: 'replacement password value' })).user.id, administrator.id);

    const user = await auth.register(registration(uniqueEmail()));
    assert.equal(await auth.resetAdministratorPassword({
      email: user.email, password: 'replacement password value',
    }), false);
    assert.equal((await auth.login({ email: user.email, password: 'password value' })).user.id, user.id);
  });

  it('permits only one initial administrator bootstrap', async (context) => {
    const [existing] = await pool.execute(
      "SELECT user_id FROM user_roles WHERE role_code = 'ADMINISTRADOR' LIMIT 1",
    );
    if (existing.length > 0) {
      context.skip('The configured test database already contains an administrator');
      return;
    }

    const attempts = [uniqueEmail(), uniqueEmail()].map((email) =>
      auth.bootstrapAdministrator(registration(email)));
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected.reason.code, 'administrator_already_exists');
    const [administrators] = await pool.execute(
      `SELECT ur.user_id, GROUP_CONCAT(roles.role_code ORDER BY roles.role_code) AS roles
       FROM user_roles AS ur
       JOIN user_roles AS roles ON roles.user_id = ur.user_id
       WHERE ur.role_code = 'ADMINISTRADOR'
       GROUP BY ur.user_id`,
    );
    assert.equal(administrators.length, 1);
    assert.equal(administrators[0].roles, 'ADMINISTRADOR,USUARIO');
  });
});

function uniqueEmail() {
  return `${randomUUID()}${TEST_EMAIL_SUFFIX}`;
}

function registration(email) {
  return { name: 'Auth Integration', email, password: 'password value' };
}
