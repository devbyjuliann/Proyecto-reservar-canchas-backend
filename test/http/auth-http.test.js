import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { validateRegistration } from '../../src/modules/auth/index.js';

const FRONTEND_ORIGIN = 'https://app.example.test';
const TOKEN = 'A'.repeat(43);
const USER = Object.freeze({
  id: '7',
  name: 'Ana Perez',
  email: 'ana@example.com',
  createdAt: '2026-09-25T12:00:00.000000Z',
  roles: ['USUARIO'],
});
const ADMIN = Object.freeze({ ...USER, roles: ['ADMINISTRADOR', 'USUARIO'] });

function createFixture({ environment = 'test', sessionUser = null, authOverrides = {}, facilities } = {}) {
  const calls = [];
  const auth = {
    async register(input) {
      validateRegistration(input);
      calls.push(['register', input]);
      return USER;
    },
    async login(input) {
      calls.push(['login', input]);
      return {
        user: USER,
        token: TOKEN,
        expiresAt: '2026-10-25T12:00:00.000000Z',
      };
    },
    async resolveSession(token) {
      calls.push(['resolve', token]);
      return token === TOKEN && sessionUser
        ? { sessionId: '99', user: sessionUser }
        : null;
    },
    async revokeSession(token) {
      calls.push(['revoke', token]);
    },
    ...authOverrides,
  };
  const booking = {
    async getAvailability() { return { options: [] }; },
  };
  const app = createApp({
    auth,
    booking,
    facilities,
    environment,
    frontendOrigin: FRONTEND_ORIGIN,
    findActiveUserById: async (id) => (id === USER.id ? USER : null),
    logger: { error() {} },
  });
  return { app, calls };
}

describe('authentication HTTP contract', () => {
  it('registers without a session and rejects role injection', async () => {
    const { app, calls } = createFixture();
    await request(app)
      .post('/api/v1/auth/registrations')
      .send({ name: USER.name, email: 'ANA@EXAMPLE.COM', password: 'password value' })
      .expect(201)
      .expect(({ body, headers }) => {
        assert.deepEqual(body.user.roles, ['USUARIO']);
        assert.equal(headers['set-cookie'], undefined);
      });
    assert.equal(calls.filter(([name]) => name === 'register').length, 1);

    await request(app)
      .post('/api/v1/auth/registrations')
      .send({
        name: USER.name,
        email: USER.email,
        password: 'password value',
        roles: ['ADMINISTRADOR'],
      })
      .expect(400)
      .expect(({ body }) => assert.equal(body.error.code, 'invalid_request'));
  });

  it('emits the production host cookie with a coherent expiration', async () => {
    const { app } = createFixture({ environment: 'production' });
    const response = await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ email: USER.email, password: 'password value' })
      .expect(200);
    const cookie = response.headers['set-cookie'][0];
    assert.match(cookie, /^__Host-reserva_session=/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Expires=Sun, 25 Oct 2026 12:00:00 GMT/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/);
  });

  it('emits the non-secure local cookie in development and test', async () => {
    for (const environment of ['development', 'test']) {
      const response = await request(createFixture({ environment }).app)
        .post('/api/v1/auth/sessions')
        .send({ email: USER.email, password: 'password value' })
        .expect(200);
      const cookie = response.headers['set-cookie'][0];
      assert.match(cookie, /^reserva_session=/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /; Secure/);
    }
  });

  it('returns current user and roles without cryptographic data', async () => {
    const { app } = createFixture({ environment: 'production', sessionUser: USER });
    const response = await request(app)
      .get('/api/v1/me')
      .set('Cookie', `__Host-reserva_session=${TOKEN}`)
      .expect(200);
    assert.deepEqual(response.body, {
      user: {
        id: USER.id,
        name: USER.name,
        email: USER.email,
        roles: ['USUARIO'],
      },
    });
    assert.equal(JSON.stringify(response.body).includes('hash'), false);
    assert.equal(JSON.stringify(response.body).includes(TOKEN), false);
  });

  it('rejects missing, expired, revoked, and inactive production sessions uniformly', async () => {
    for (const state of ['missing', 'expired', 'revoked', 'inactive']) {
      const { app } = createFixture({
        environment: 'production',
        authOverrides: { async resolveSession() { return null; } },
      });
      await request(app)
        .get('/api/v1/me')
        .set('Cookie', `__Host-reserva_session=${state === 'missing' ? 'invalid' : TOKEN}`)
        .expect(401)
        .expect(({ body }) => assert.equal(body.error.code, 'authentication_required'));
    }
  });

  it('ignores X-User-Id in production and retains it in development/test', async () => {
    await request(createFixture({ environment: 'production' }).app)
      .get('/api/v1/me')
      .set('X-User-Id', USER.id)
      .expect(401);
    for (const environment of ['development', 'test']) {
      await request(createFixture({ environment }).app)
        .get('/api/v1/me')
        .set('X-User-Id', USER.id)
        .expect(200)
        .expect(({ body }) => assert.deepEqual(body.user.roles, ['USUARIO']));
    }
  });

  it('revokes and clears the cookie idempotently', async () => {
    const { app, calls } = createFixture({ environment: 'production' });
    for (const cookie of [`__Host-reserva_session=${TOKEN}`, undefined]) {
      let operation = request(app)
        .delete('/api/v1/auth/session')
        .set('Origin', FRONTEND_ORIGIN);
      if (cookie) operation = operation.set('Cookie', cookie);
      const response = await operation.expect(204);
      assert.match(response.headers['set-cookie'][0], /^__Host-reserva_session=;/);
    }
    assert.deepEqual(
      calls.filter(([name]) => name === 'revoke').map(([, token]) => token),
      [TOKEN, undefined],
    );
  });

  it('enforces explicit credentialed CORS and Origin in production', async () => {
    const { app, calls } = createFixture({ environment: 'production' });
    await request(app)
      .options('/api/v1/auth/sessions')
      .set('Origin', FRONTEND_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .expect('Access-Control-Allow-Origin', FRONTEND_ORIGIN)
      .expect('Access-Control-Allow-Credentials', 'true')
      .expect(204);

    await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', 'https://evil.example')
      .send({ email: USER.email, password: 'password value' })
      .expect(403)
      .expect(({ body, headers }) => {
        assert.equal(body.error.code, 'origin_not_allowed');
        assert.equal(headers['access-control-allow-origin'], undefined);
      });
    await request(app)
      .post('/api/v1/auth/sessions')
      .send({ email: USER.email, password: 'password value' })
      .expect(403);
    assert.equal(calls.some(([name]) => name === 'login'), false);
  });

  it('rejects an untrusted Origin for a cookie-authenticated mutation', async () => {
    const { app, calls } = createFixture({ environment: 'production', sessionUser: USER });
    await request(app)
      .delete('/api/v1/auth/session')
      .set('Cookie', `__Host-reserva_session=${TOKEN}`)
      .set('Origin', 'https://other.example.test')
      .expect(403)
      .expect(({ body }) => assert.equal(body.error.code, 'origin_not_allowed'));
    assert.equal(calls.some(([name]) => name === 'revoke'), false);
  });

  it('trusts only loopback proxies in production and leaves local tests unproxied', () => {
    assert.equal(createFixture({ environment: 'production' }).app.get('trust proxy'), 'loopback');
    assert.equal(createFixture({ environment: 'test' }).app.get('trust proxy'), false);
  });

  it('authorizes persisted administrator sessions and forbids USUARIO', async () => {
    const facilities = {
      async listFacilities() { return { items: [], page: { nextCursor: null } }; },
    };
    const adminApp = createFixture({
      environment: 'production', sessionUser: ADMIN, facilities,
    }).app;
    await request(adminApp)
      .get('/api/v1/admin/facilities')
      .set('Cookie', `__Host-reserva_session=${TOKEN}`)
      .expect(200);

    const userApp = createFixture({
      environment: 'production', sessionUser: USER, facilities,
    }).app;
    await request(userApp)
      .get('/api/v1/admin/facilities')
      .set('Cookie', `__Host-reserva_session=${TOKEN}`)
      .expect(403)
      .expect(({ body }) => assert.equal(body.error.code, 'forbidden'));
  });
});
