import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

import { createApp } from '../../src/app/create-app.js';
import { appError } from '../../src/shared/errors.js';

const ORIGIN = 'https://app.example.test';

function fixture() {
  const calls = { request: [], confirm: [] };
  const app = createApp({
    environment: 'production', frontendOrigin: ORIGIN,
    booking: { async getAvailability() { return { options: [] }; } },
    findActiveUserById: async () => null,
    auth: {
      async requestPasswordReset(input) { calls.request.push(input); },
      async confirmPasswordReset(input) {
        calls.confirm.push(input);
        throw appError('invalid_password_reset_token', 'The reset link is invalid or expired');
      },
      async resolveSession() { return null; }, async revokeSession() {},
    }, logger: { error() {} },
  });
  return { app, calls };
}

describe('password reset HTTP contract', () => {
  it('returns the same public response for any accepted address and no cookie', async () => {
    const { app, calls } = fixture();
    const known = await request(app).post('/api/v1/auth/password-reset/request')
      .set('Origin', ORIGIN).send({ email: 'known@example.test' }).expect(200);
    const unknown = await request(app).post('/api/v1/auth/password-reset/request')
      .set('Origin', ORIGIN).send({ email: 'unknown@example.test' }).expect(200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(known.headers['set-cookie'], undefined);
    assert.equal(calls.request.length, 2);
  });

  it('does not expose token details and requires a trusted Origin', async () => {
    const { app, calls } = fixture();
    await request(app).post('/api/v1/auth/password-reset/request')
      .set('Origin', 'https://other.example.test').send({ email: 'known@example.test' }).expect(403);
    assert.equal(calls.request.length, 0);
    const response = await request(app).post('/api/v1/auth/password-reset/confirm')
      .set('Origin', ORIGIN).send({ token: 'A'.repeat(43), newPassword: 'new password value' }).expect(400);
    assert.equal(response.body.error.code, 'invalid_password_reset_token');
    assert.equal(JSON.stringify(response.body).includes('A'.repeat(43)), false);
  });

  it('limits requests and confirmations separately from login and registration', async () => {
    const { app, calls } = fixture();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/v1/auth/password-reset/request')
        .set('Origin', ORIGIN).send({ email: 'known@example.test' }).expect(200);
    }
    await request(app).post('/api/v1/auth/password-reset/request')
      .set('Origin', ORIGIN).send({ email: 'other@example.test' }).expect(429);
    assert.equal(calls.request.length, 5);
    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/v1/auth/password-reset/confirm')
        .set('Origin', ORIGIN).send({ token: 'A'.repeat(43), newPassword: 'new password value' }).expect(400);
    }
    await request(app).post('/api/v1/auth/password-reset/confirm')
      .set('Origin', ORIGIN).send({ token: 'A'.repeat(43), newPassword: 'new password value' }).expect(429);
    assert.equal(calls.confirm.length, 10);
  });
});
