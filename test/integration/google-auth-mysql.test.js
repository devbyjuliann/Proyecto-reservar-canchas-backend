import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { loadDatabaseConfig } from '../../src/config/database.js';
import { createMySqlPool } from '../../src/database/pool.js';
import { createAuthModule, createGoogleVerifier, createMySqlAuthAdapter } from '../../src/modules/auth/index.js';
import { createMySqlUsersAdapter } from '../../src/modules/users/index.js';
import { createOwnerDirectoryModule, createMySqlOwnerDirectoryAdapter } from '../../src/modules/owner-directory/index.js';
import { createSystemClock } from '../../src/shared/clock.js';
import { toMySqlDateTime } from '../../src/shared/time.js';

const AVAILABLE = process.env.NODE_ENV === 'test' && process.env.DB_NAME?.endsWith('_test');
const CLIENT_ID = 'google-integration-client';
const SECRET = 'signed-only-for-integration-tests';

describe('Google identity with MySQL and real sessions', { skip: !AVAILABLE }, () => {
  let pool;
  let adapter;
  let auth;
  let app;
  const userIds = [];
  const previousLimit = process.env.AUTH_TEST_GOOGLE_LIMIT;

  before(() => {
    process.env.AUTH_TEST_GOOGLE_LIMIT = '100';
    pool = createMySqlPool(loadDatabaseConfig());
    adapter = createMySqlAuthAdapter({ pool });
    auth = createAuthModule({ adapter, clock: createSystemClock(),
      verifyGoogleCredential: createGoogleVerifier({ clientId: CLIENT_ID, environment: 'test', testSecret: SECRET }),
      frontendOrigin: 'http://localhost:5173', sendPasswordResetEmail: async () => {},
    });
    const users = createMySqlUsersAdapter({ pool });
    app = createApp({ environment: 'test', frontendOrigin: 'http://localhost:5173', auth,
      booking: { async getAvailability() { return { options: [] }; } },
      ownerDirectory: createOwnerDirectoryModule({ adapter: createMySqlOwnerDirectoryAdapter({ pool }), clock: createSystemClock() }),
      findActiveUserById: (id) => users.findById(id), logger: { error() {} } });
  });

  after(async () => {
    for (const id of userIds) {
      await pool.execute('DELETE FROM user_external_identities WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_credentials WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
      await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    }
    await pool?.end();
    if (previousLimit === undefined) delete process.env.AUTH_TEST_GOOGLE_LIMIT;
    else process.env.AUTH_TEST_GOOGLE_LIMIT = previousLimit;
  });

  function credential({ email, subject = randomUUID(), hd, name, verified = true,
    audience = CLIENT_ID, issuer = 'accounts.google.com', expires = Math.floor(Date.now() / 1000) + 3600 }) {
    const payload = Buffer.from(JSON.stringify({ sub: subject, email, email_verified: verified,
      aud: audience, iss: issuer, exp: expires, ...(hd ? { hd } : {}), ...(name ? { name } : {}) })).toString('base64url');
    return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
  }

  async function local(email) {
    const user = await auth.register({ name: 'Nombre local', email, password: 'valid password here' });
    userIds.push(user.id);
    return user;
  }

  it('creates a Google-only USUARIO with no password and authenticates through the normal session/cookie', async () => {
    const email = `google-new-${randomUUID()}@example.test`;
    const token = credential({ email, name: 'Nombre Google' });
    const first = await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(200);
    const id = first.body.user.id;
    userIds.push(id);
    assert.deepEqual(first.body.user.roles, ['USUARIO']);
    assert.equal(first.body.user.name, 'Nombre Google');
    assert.ok(first.headers['set-cookie']?.[0].includes('reserva_session='));
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    const me = await request(app).get('/api/v1/me').set('Cookie', cookie).expect(200);
    assert.equal(me.body.user.id, id);
    const [password] = await pool.execute('SELECT user_id FROM user_credentials WHERE user_id = ?', [id]);
    assert.equal(password.length, 0);
    const [identities] = await pool.execute('SELECT provider, provider_subject FROM user_external_identities WHERE user_id = ?', [id]);
    assert.equal(identities[0].provider, 'GOOGLE');
    await request(app).post('/api/v1/auth/sessions').send({ email, password: 'valid password here' }).expect(401);
    const again = await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(200);
    assert.equal(again.body.user.id, id);
    const [users] = await pool.execute('SELECT COUNT(*) AS total FROM users WHERE email = ?', [email]);
    assert.equal(Number(users[0].total), 1);
    assert.equal(again.body.user.name, 'Nombre Google');
    const renamedEmail = await request(app).post('/api/v1/auth/google')
      .send({ credential: credential({ subject: identities[0].provider_subject,
        email: `changed-${randomUUID()}@example.test` }) }).expect(200);
    assert.equal(renamedEmail.body.user.id, id);
    assert.equal(renamedEmail.body.user.email, email);
  });

  it('auto-links verified Gmail and Workspace while retaining the password, local name and roles', async () => {
    for (const { email, hd } of [
      { email: `gmail-${randomUUID()}@gmail.com` },
      { email: `workspace-${randomUUID()}@equipo.test`, hd: 'equipo.test' },
    ]) {
      const user = await local(email);
      await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'ADMINISTRADOR')", [user.id]);
      const linked = await request(app).post('/api/v1/auth/google')
        .send({ credential: credential({ email, hd, name: 'No reemplazar' }) }).expect(200);
      assert.equal(linked.body.user.id, user.id);
      assert.equal(linked.body.user.name, 'Nombre local');
      assert.ok(linked.body.user.roles.includes('ADMINISTRADOR'));
      assert.equal((await auth.login({ email, password: 'valid password here' })).user.id, user.id);
    }
  });

  it('serializes concurrent creation for the same Google identity without duplicate users', async () => {
    const email = `concurrent-${randomUUID()}@example.test`;
    const token = credential({ email });
    const results = await Promise.all([
      auth.loginWithGoogle({ credential: token }), auth.loginWithGoogle({ credential: token }),
    ]);
    assert.equal(results[0].user.id, results[1].user.id);
    userIds.push(results[0].user.id);
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM users WHERE email = ?', [email]);
    assert.equal(Number(rows[0].total), 1);
  });

  it('requires password login then an authenticated local session to link an external-domain email', async () => {
    const email = `external-${randomUUID()}@other.test`;
    const user = await local(email);
    const google = credential({ email });
    const denied = await request(app).post('/api/v1/auth/google').send({ credential: google }).expect(409);
    assert.equal(denied.body.error.code, 'google_link_requires_confirmation');
    const [before] = await pool.execute('SELECT id FROM user_external_identities WHERE user_id = ?', [user.id]);
    assert.equal(before.length, 0);
    await request(app).post('/api/v1/auth/google/link').send({ credential: google }).expect(401);
    await request(app).post('/api/v1/auth/google/link').set('X-User-Id', user.id)
      .send({ credential: google }).expect(401);
    const session = await request(app).post('/api/v1/auth/sessions')
      .send({ email, password: 'valid password here' }).expect(200);
    const cookie = session.headers['set-cookie'][0].split(';')[0];
    const mismatched = await request(app).post('/api/v1/auth/google/link').set('Cookie', cookie)
      .send({ credential: credential({ email: `other-${randomUUID()}@external.test` }) }).expect(409);
    assert.equal(mismatched.body.error.code, 'google_identity_conflict');
    await request(app).post('/api/v1/auth/google/link').set('Cookie', cookie)
      .send({ credential: google, actor: { id: '99999' }, sessionId: '99999' }).expect(400);
    const [noInjectedLink] = await pool.execute('SELECT id FROM user_external_identities WHERE user_id = ?', [user.id]);
    assert.equal(noInjectedLink.length, 0);
    await pool.execute('UPDATE sessions SET created_at = DATE_SUB(created_at, INTERVAL 16 MINUTE) WHERE user_id = ?', [user.id]);
    const stale = await request(app).post('/api/v1/auth/google/link').set('Cookie', cookie)
      .send({ credential: google }).expect(401);
    assert.equal(stale.body.error.code, 'google_link_requires_recent_login');
    const fresh = await request(app).post('/api/v1/auth/sessions')
      .send({ email, password: 'valid password here' }).expect(200);
    const freshCookie = fresh.headers['set-cookie'][0].split(';')[0];
    await request(app).post('/api/v1/auth/google/link').set('Cookie', freshCookie)
      .send({ credential: google }).expect(200);
    const next = await request(app).post('/api/v1/auth/google').send({ credential: google }).expect(200);
    assert.equal(next.body.user.id, user.id);
    assert.equal((await auth.login({ email, password: 'valid password here' })).user.id, user.id);
  });

  it('rejects a Google subject belonging to another account and a different subject on the same account', async () => {
    const first = await local(`first-${randomUUID()}@other.test`);
    const second = await local(`second-${randomUUID()}@other.test`);
    const subject = randomUUID();
    const firstCookie = (await request(app).post('/api/v1/auth/sessions')
      .send({ email: first.email, password: 'valid password here' }).expect(200)).headers['set-cookie'][0].split(';')[0];
    const secondCookie = (await request(app).post('/api/v1/auth/sessions')
      .send({ email: second.email, password: 'valid password here' }).expect(200)).headers['set-cookie'][0].split(';')[0];
    await request(app).post('/api/v1/auth/google/link').set('Cookie', firstCookie)
      .send({ credential: credential({ email: first.email, subject }) }).expect(200);
    const conflict = await request(app).post('/api/v1/auth/google/link').set('Cookie', secondCookie)
      .send({ credential: credential({ email: second.email, subject }) }).expect(409);
    assert.equal(conflict.body.error.code, 'google_identity_conflict');
    await request(app).post('/api/v1/auth/google/link').set('Cookie', firstCookie)
      .send({ credential: credential({ email: first.email, subject: randomUUID() }) }).expect(409);
    const [rows] = await pool.execute('SELECT user_id FROM user_external_identities WHERE provider_subject = ?', [subject]);
    assert.equal(String(rows[0].user_id), first.id);
  });

  it('rechecks session revocation inside the linking transaction', async () => {
    const email = `revoke-${randomUUID()}@external.test`;
    const user = await local(email);
    const session = await auth.login({ email, password: 'valid password here' });
    await pool.execute('UPDATE sessions SET revoked_at = ? WHERE id = ?',
      [toMySqlDateTime(createSystemClock().now()), session.sessionId]);
    const result = await adapter.linkGoogleIdentity({ userId: user.id, sessionId: session.sessionId,
      subject: randomUUID(), email, now: createSystemClock().now() });
    assert.equal(result, 'session_inactive');
    const [identities] = await pool.execute('SELECT id FROM user_external_identities WHERE user_id = ?', [user.id]);
    assert.equal(identities.length, 0);
  });

  it('rejects invalid signature/audience/issuer/expiry/email and deactivated users', async () => {
    const email = `invalid-${randomUUID()}@gmail.com`;
    for (const token of [credential({ email, audience: 'wrong' }), credential({ email, issuer: 'other' }),
      credential({ email, expires: 0 }), credential({ email, verified: false }), 'bad.signature']) {
      await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(401);
    }
    const user = await local(email);
    const token = credential({ email });
    await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(200);
    await pool.execute('UPDATE users SET deactivated_at = ? WHERE id = ?', [toMySqlDateTime(createSystemClock().now()), user.id]);
    const denied = await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(401);
    assert.equal(denied.body.error.code, 'invalid_credentials');
  });

  it('preserves an Owner suspension and keeps Google-only password recovery generic', async () => {
    const email = `owner-google-${randomUUID()}@example.test`;
    const token = credential({ email });
    const signedIn = await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(200);
    const userId = signedIn.body.user.id;
    userIds.push(userId);
    await pool.execute("INSERT INTO user_roles (user_id, role_code) VALUES (?, 'PROPIETARIO')", [userId]);
    await pool.execute('UPDATE users SET owner_suspended_at = ? WHERE id = ?', [toMySqlDateTime(createSystemClock().now()), userId]);
    const again = await request(app).post('/api/v1/auth/google').send({ credential: token }).expect(200);
    assert.ok(again.body.user.roles.includes('PROPIETARIO'));
    const cookie = again.headers['set-cookie'][0].split(';')[0];
    const denied = await request(app).get('/api/v1/owner/facilities').set('Cookie', cookie).expect(403);
    assert.equal(denied.body.error.code, 'owner_suspended');
    const [rows] = await pool.execute('SELECT owner_suspended_at FROM users WHERE id = ?', [userId]);
    assert.ok(rows[0].owner_suspended_at);
    const known = await request(app).post('/api/v1/auth/password-reset/request').send({ email }).expect(200);
    const unknown = await request(app).post('/api/v1/auth/password-reset/request')
      .send({ email: `missing-${randomUUID()}@example.test` }).expect(200);
    assert.deepEqual(known.body, unknown.body);
    const [resets] = await pool.execute('SELECT id FROM password_reset_tokens WHERE user_id = ?', [userId]);
    assert.equal(resets.length, 0);
  });
});
