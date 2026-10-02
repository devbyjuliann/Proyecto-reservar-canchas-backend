import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';

const ORIGIN = 'https://app.example.test';
const user = { id: '3', name: 'Usuario', email: 'user@example.test', roles: ['USUARIO'] };

function fixture() {
  const calls = { google: 0, link: 0, password: 0 };
  const app = createApp({ environment: 'production', frontendOrigin: ORIGIN,
    booking: { async getAvailability() { return { options: [] }; } },
    findActiveUserById: async () => user,
    auth: {
      async loginWithGoogle() {
        calls.google += 1;
        return { user, token: 'session-value', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      },
      async linkGoogle({ sessionId }) { calls.link += 1; if (!sessionId) throw new Error('Missing session'); return user; },
      async login() { calls.password += 1; return { user, token: 'session-value',
        expiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
      async resolveSession(token) { return token === 'session-value' ? { user, sessionId: '8' } : null; },
      async revokeSession() {},
    }, logger: { error() {} },
  });
  return { app, calls };
}

describe('Google auth HTTP boundary', () => {
  it('issues the existing opaque session cookie and /me reads the same local user', async () => {
    const { app, calls } = fixture();
    const login = await request(app).post('/api/v1/auth/google').set('Origin', ORIGIN)
      .send({ credential: 'verified-id-token' }).expect(200);
    assert.deepEqual(login.body, { user });
    assert.ok(login.headers['set-cookie'][0].includes('__Host-reserva_session=session-value'));
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const me = await request(app).get('/api/v1/me').set('Cookie', cookie).expect(200);
    assert.deepEqual(me.body, { user });
    const link = await request(app).post('/api/v1/auth/google/link').set('Origin', ORIGIN)
      .set('Cookie', cookie).send({ credential: 'verified-id-token' }).expect(200);
    assert.deepEqual(link.body, { user });
    assert.equal(calls.link, 1);
  });

  it('requires the trusted Origin and a local session to link', async () => {
    const { app, calls } = fixture();
    await request(app).post('/api/v1/auth/google').set('Origin', 'https://other.example.test')
      .send({ credential: 'token' }).expect(403);
    await request(app).post('/api/v1/auth/google/link').set('Origin', ORIGIN)
      .send({ credential: 'token' }).expect(401);
    await request(app).post('/api/v1/auth/google/link').set('Origin', ORIGIN)
      .send({ credential: 'token', actor: user, sessionId: '8' }).expect(401);
    await request(app).post('/api/v1/auth/google/link').set('Origin', 'https://other.example.test')
      .set('Cookie', '__Host-reserva_session=session-value').send({ credential: 'token' }).expect(403);
    assert.equal(calls.google, 0);
    assert.equal(calls.link, 0);
  });

  it('limits Google attempts separately without consuming the password-login quota', async () => {
    const { app, calls } = fixture();
    for (let index = 0; index < 10; index += 1) {
      await request(app).post('/api/v1/auth/google').set('Origin', ORIGIN)
        .send({ credential: `attempt-${index}` }).expect(200);
    }
    await request(app).post('/api/v1/auth/google').set('Origin', ORIGIN)
      .send({ credential: 'blocked' }).expect(429);
    await request(app).post('/api/v1/auth/sessions').set('Origin', ORIGIN)
      .send({ email: user.email, password: 'valid password here' }).expect(200);
    assert.equal(calls.google, 10);
    assert.equal(calls.password, 1);
  });
});
