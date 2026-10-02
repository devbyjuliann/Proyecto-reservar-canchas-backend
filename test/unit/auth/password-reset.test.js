import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAuthModule, hashSessionToken, isSessionToken } from '../../../src/modules/auth/index.js';

const NOW = '2026-10-01T12:00:00.000000Z';

describe('password reset orchestration', () => {
  it('normalizes email, sends a fresh 32-byte secret and persists only its hash for 30 minutes', async () => {
    const deliveries = [];
    const issued = [];
    const auth = createAuthModule({
      adapter: {
        async findAccountByEmail(email) {
          assert.equal(email, 'user@example.test');
          return { user: { id: '3', email }, credential: { algorithm: 'SCRYPT' }, deactivatedAt: null };
        },
        async issuePasswordReset(value) { issued.push(value); return true; },
      },
      clock: { now: () => NOW }, frontendOrigin: 'https://app.example.test',
      sendPasswordResetEmail: async (mail) => { deliveries.push(mail); },
    });
    await auth.requestPasswordReset({ email: ' USER@EXAMPLE.TEST ' });
    await auth.requestPasswordReset({ email: 'user@example.test' });
    const tokens = deliveries.map((mail) => new URL(mail.resetUrl).searchParams.get('token'));
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.equal(tokens.every(isSessionToken), true);
    assert.equal(issued[0].userId, '3');
    assert.deepEqual(issued[0].tokenHash, hashSessionToken(tokens[0]));
    assert.equal(issued[0].expiresAt, '2026-10-01T12:30:00.000000Z');
    assert.equal(deliveries[0].expiresAt, issued[0].expiresAt);
  });

  it('does not send messages for absent or inactive accounts', async () => {
    let sent = 0;
    let issued = 0;
    const auth = createAuthModule({
      adapter: {
        async findAccountByEmail(email) {
          return email === 'inactive@example.test'
            ? { user: { id: '4', email }, deactivatedAt: NOW } : null;
        },
        async issuePasswordReset() { issued += 1; },
      },
      clock: { now: () => NOW }, frontendOrigin: 'https://app.example.test',
      sendPasswordResetEmail: async () => { sent += 1; },
    });
    assert.equal(await auth.requestPasswordReset({ email: 'nobody@example.test' }), undefined);
    assert.equal(await auth.requestPasswordReset({ email: 'inactive@example.test' }), undefined);
    assert.equal(sent, 0);
    assert.equal(issued, 0);
  });

  it('reuses registration password validation and rejects malformed or invalid tokens without consuming', async () => {
    let consumed = 0;
    const auth = createAuthModule({
      adapter: { async consumePasswordReset() { consumed += 1; return false; } },
      clock: { now: () => NOW },
    });
    await assert.rejects(auth.confirmPasswordReset({ token: 'invalid', newPassword: 'valid password here' }), { code: 'invalid_password_reset_token' });
    await assert.rejects(auth.confirmPasswordReset({ token: 'A'.repeat(43), newPassword: 'short' }), { code: 'invalid_request' });
    await assert.rejects(auth.confirmPasswordReset({ token: 'A'.repeat(43), newPassword: 'valid password here' }), { code: 'invalid_password_reset_token' });
    assert.equal(consumed, 1);
  });
});
