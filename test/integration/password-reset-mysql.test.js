import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createAuthModule, createMySqlAuthAdapter, hashSessionToken } from '../../src/modules/auth/index.js';

const available = process.env.NODE_ENV === 'test' && process.env.DB_NAME?.endsWith('_test');

describe('password recovery with MySQL', { skip: !available }, () => {
  const pool = available ? createMySqlPool(loadDatabaseConfig()) : null;
  const adapter = pool ? createMySqlAuthAdapter({ pool }) : null;
  const users = [];
  let now = '2026-10-01T12:00:00.000000Z';
  const inbox = [];
  const auth = adapter ? createAuthModule({ adapter, clock: { now: () => now },
    frontendOrigin: 'http://localhost:5177',
    sendPasswordResetEmail: async (message) => { inbox.push(message); },
  }) : null;

  after(async () => {
    for (const id of users) {
      await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_credentials WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    }
    await pool?.end();
  });

  async function createUser() {
    now = '2026-10-01T12:00:00.000000Z';
    const user = await auth.register({ name: 'Reset test', email: `${randomUUID()}@reset.test`, password: 'original password value' });
    users.push(user.id);
    return user;
  }

  async function requestLink(email) {
    await auth.requestPasswordReset({ email });
    return new URL(inbox.at(-1).resetUrl).searchParams.get('token');
  }

  it('keeps absent addresses private and never sends an email', async () => {
    const count = inbox.length;
    assert.equal(await auth.requestPasswordReset({ email: '  UNKNOWN@reset.test ' }), undefined);
    assert.equal(inbox.length, count);
  });

  it('stores only a hash, updates credentials and revokes all sessions on success', async () => {
    const user = await createUser();
    const first = await auth.login({ email: user.email, password: 'original password value' });
    const second = await auth.login({ email: user.email, password: 'original password value' });
    const token = await requestLink(user.email.toUpperCase());
    const [rows] = await pool.execute('SELECT token_hash, expires_at FROM password_reset_tokens WHERE user_id = ?', [user.id]);
    assert.deepEqual(rows[0].token_hash, hashSessionToken(token));
    assert.equal(inbox.at(-1).resetUrl.includes(token), true);
    await auth.confirmPasswordReset({ token, newPassword: 'replacement password value' });
    assert.equal(await auth.resolveSession(first.token), null);
    assert.equal(await auth.resolveSession(second.token), null);
    await assert.rejects(auth.login({ email: user.email, password: 'original password value' }), { code: 'invalid_credentials' });
    assert.equal((await auth.login({ email: user.email, password: 'replacement password value' })).user.id, user.id);
    await assert.rejects(auth.confirmPasswordReset({ token, newPassword: 'third password value' }), { code: 'invalid_password_reset_token' });
  });

  it('expires tokens, rejects unknown ones, and invalidates earlier requests', async () => {
    const user = await createUser();
    const old = await requestLink(user.email);
    const newer = await requestLink(user.email);
    await assert.rejects(auth.confirmPasswordReset({ token: old, newPassword: 'replacement password value' }), { code: 'invalid_password_reset_token' });
    now = '2026-10-01T12:30:00.000000Z';
    await assert.rejects(auth.confirmPasswordReset({ token: newer, newPassword: 'replacement password value' }), { code: 'invalid_password_reset_token' });
    await assert.rejects(auth.confirmPasswordReset({ token: 'A'.repeat(43), newPassword: 'replacement password value' }), { code: 'invalid_password_reset_token' });
    assert.equal((await auth.login({ email: user.email, password: 'original password value' })).user.id, user.id);
  });

  it('allows a suspended Owner to reset without changing suspension or roles', async () => {
    const user = await createUser();
    await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'PROPIETARIO')", [user.id]);
    await pool.execute('UPDATE users SET owner_suspended_at = ? WHERE id = ?', ['2026-10-01 12:00:00.000000', user.id]);
    const token = await requestLink(user.email);
    await auth.confirmPasswordReset({ token, newPassword: 'replacement password value' });
    const [rows] = await pool.execute('SELECT owner_suspended_at FROM users WHERE id = ?', [user.id]);
    assert.ok(rows[0].owner_suspended_at);
    assert.ok((await auth.login({ email: user.email, password: 'replacement password value' })).user.roles.includes('PROPIETARIO'));
  });

  it('allows an Administrator through the web flow without using the emergency CLI', async () => {
    const user = await createUser();
    await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'ADMINISTRADOR')", [user.id]);
    const token = await requestLink(user.email);
    await auth.confirmPasswordReset({ token, newPassword: 'replacement password value' });
    assert.ok((await auth.login({ email: user.email, password: 'replacement password value' })).user.roles.includes('ADMINISTRADOR'));
  });

  it('does not issue a token or reactivate a deactivated account', async () => {
    const user = await createUser();
    await pool.execute('UPDATE users SET deactivated_at = ? WHERE id = ?', ['2026-10-01 12:00:00.000000', user.id]);
    const count = inbox.length;
    await auth.requestPasswordReset({ email: user.email });
    assert.equal(inbox.length, count);
    const [rows] = await pool.execute('SELECT deactivated_at FROM users WHERE id = ?', [user.id]);
    assert.ok(rows[0].deactivated_at);
    await assert.rejects(auth.login({ email: user.email, password: 'original password value' }), { code: 'invalid_credentials' });
  });

  it('rejects an issued token if the account is deactivated before confirmation', async () => {
    const user = await createUser();
    const token = await requestLink(user.email);
    await pool.execute('UPDATE users SET deactivated_at = ? WHERE id = ?', ['2026-10-01 12:00:00.000000', user.id]);
    await assert.rejects(auth.confirmPasswordReset({ token, newPassword: 'replacement password value' }), { code: 'invalid_password_reset_token' });
    const [rows] = await pool.execute('SELECT deactivated_at FROM users WHERE id = ?', [user.id]);
    assert.ok(rows[0].deactivated_at);
  });

  it('consumes a token exactly once under concurrent confirmations', async () => {
    const user = await createUser();
    const token = await requestLink(user.email);
    const results = await Promise.allSettled([
      auth.confirmPasswordReset({ token, newPassword: 'first replacement password' }),
      auth.confirmPasswordReset({ token, newPassword: 'second replacement password' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'invalid_password_reset_token');
  });
});
