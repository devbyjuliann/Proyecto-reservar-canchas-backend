import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { appError } from '../../src/shared/errors.js';

const ORIGIN = 'https://app.example.test';

function fixture() {
  const calls = { login: 0, registration: 0 };
  const user = { id: '1', name: 'Usuario', email: 'test@example.test', roles: ['USUARIO'] };
  const app = createApp({
    environment: 'production',
    frontendOrigin: ORIGIN,
    booking: { async getAvailability() { return { options: [] }; } },
    findActiveUserById: async () => null,
    auth: {
      async register() { calls.registration += 1; return user; },
      async login() { calls.login += 1; throw appError('invalid_credentials', 'Invalid credentials'); },
      async resolveSession() { return null; },
      async revokeSession() {},
    },
    logger: { error() {} },
  });
  return { app, calls };
}

describe('authentication rate limits', () => {
  it('limits login attempts independently without revealing whether an email exists', async () => {
    const { app, calls } = fixture();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/sessions')
        .set('Origin', ORIGIN)
        .send({ email: `unknown-${attempt}@example.test`, password: 'incorrect' })
        .expect(401);
    }

    const blocked = await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', ORIGIN)
      .send({ email: 'known@example.test', password: 'incorrect' })
      .expect(429);
    assert.deepEqual(blocked.body, {
      error: { code: 'rate_limit_exceeded', message: 'Too many authentication attempts. Try again later' },
    });
    assert.equal(JSON.stringify(blocked.body).includes('known@example.test'), false);
    assert.equal(calls.login, 10);

    await request(app)
      .post('/api/v1/auth/registrations')
      .set('Origin', ORIGIN)
      .send({ name: 'Usuario', email: 'known@example.test', password: 'password value' })
      .expect(201);
    assert.equal(calls.registration, 1);
  });

  it('limits registrations independently and leaves other routes available', async () => {
    const { app, calls } = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/registrations')
        .set('Origin', ORIGIN)
        .send({ name: 'Usuario', email: `new-${attempt}@example.test`, password: 'password value' })
        .expect(201);
    }

    const blocked = await request(app)
      .post('/api/v1/auth/registrations')
      .set('Origin', ORIGIN)
      .send({ name: 'Usuario', email: 'any@example.test', password: 'password value' })
      .expect(429);
    assert.deepEqual(blocked.body, {
      error: { code: 'rate_limit_exceeded', message: 'Too many authentication attempts. Try again later' },
    });
    assert.equal(calls.registration, 5);

    await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', ORIGIN)
      .send({ email: 'any@example.test', password: 'incorrect' })
      .expect(401);
    assert.equal(calls.login, 1);
    await request(app).get('/health').expect(200);
  });

  it('separates forwarded client IPs when the reverse proxy is on loopback', async () => {
    const { app, calls } = fixture();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app)
        .post('/api/v1/auth/sessions')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: 'unknown@example.test', password: 'incorrect' })
        .expect(401);
    }
    await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', '198.51.100.10')
      .send({ email: 'unknown@example.test', password: 'incorrect' })
      .expect(429);
    await request(app)
      .post('/api/v1/auth/sessions')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', '198.51.100.11')
      .send({ email: 'unknown@example.test', password: 'incorrect' })
      .expect(401);
    assert.equal(calls.login, 11);
  });
});
