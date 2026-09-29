import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAuthModule, hashPassword, verifyPassword } from '../../../src/modules/auth/index.js';

const NOW = '2026-09-25T12:00:00.000000Z';
const TOKEN = 'A'.repeat(43);
const USER = Object.freeze({
  id: '7',
  name: 'Ana Perez',
  email: 'ana@example.com',
  createdAt: NOW,
  roles: ['USUARIO'],
});

describe('authentication module', () => {
  it('registers atomically through the adapter with only USUARIO', async () => {
    let received;
    const auth = fixture({
      async register(input) {
        received = input;
        return USER;
      },
    });
    const user = await auth.register({
      name: 'Ana Perez',
      email: 'ANA@EXAMPLE.COM',
      password: 'password value',
    });
    assert.equal(user, USER);
    assert.equal(received.email, 'ana@example.com');
    assert.equal(received.credential.hash.length, 64);
    assert.equal(received.now, NOW);
    assert.deepEqual(user.roles, ['USUARIO']);
  });

  it('maps duplicate email storage errors to one stable error', async () => {
    const auth = fixture({
      async register() {
        const error = new Error('duplicate details');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      },
    });
    await assert.rejects(auth.register({
      name: 'Ana', email: 'ana@example.com', password: 'password value',
    }), {
      code: 'email_already_registered',
      message: 'The email is already registered',
    });
  });

  it('creates a 30-day session and persists only a token hash', async () => {
    const credential = await hashPassword('password value');
    let sessionInput;
    const auth = fixture({
      async findAccountByEmail() {
        return { user: USER, deactivatedAt: null, credential };
      },
      async createSession(input) {
        sessionInput = input;
        return { id: '99' };
      },
    });
    const result = await auth.login({ email: USER.email, password: 'password value' });
    assert.equal(result.token, TOKEN);
    assert.equal(result.sessionId, '99');
    assert.equal(result.expiresAt, '2026-10-25T12:00:00.000000Z');
    assert.equal(sessionInput.token, undefined);
    assert.equal(sessionInput.tokenHash.length, 32);
    assert.equal(sessionInput.expiresAt, result.expiresAt);
  });

  it('uses the same public error for missing, incorrect, and inactive accounts', async () => {
    const credential = await hashPassword('password value');
    const cases = [
      null,
      { user: USER, deactivatedAt: null, credential },
      { user: USER, deactivatedAt: NOW, credential },
    ];
    const passwords = ['wrong', 'wrong', 'password value'];
    for (let index = 0; index < cases.length; index += 1) {
      const auth = fixture({ async findAccountByEmail() { return cases[index]; } });
      await assert.rejects(
        auth.login({ email: USER.email, password: passwords[index] }),
        { code: 'invalid_credentials', message: 'The credentials are invalid' },
      );
    }
  });

  it('rejects a login when the user becomes inactive before session creation', async () => {
    const credential = await hashPassword('password value');
    const auth = fixture({
      async findAccountByEmail() {
        return { user: USER, deactivatedAt: null, credential };
      },
      async createSession() { return null; },
    });
    await assert.rejects(
      auth.login({ email: USER.email, password: 'password value' }),
      { code: 'invalid_credentials' },
    );
  });

  it('delegates expiration/revocation checks and ignores malformed tokens', async () => {
    const calls = [];
    const auth = fixture({
      async findActiveSession(input) {
        calls.push(['find', input]);
        return { sessionId: '99', user: USER };
      },
      async revokeSession(input) {
        calls.push(['revoke', input]);
      },
    });
    assert.equal(await auth.resolveSession('invalid'), null);
    await auth.revokeSession('invalid');
    assert.equal(calls.length, 0);
    assert.equal((await auth.resolveSession(TOKEN)).sessionId, '99');
    await auth.revokeSession(TOKEN);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].now, NOW);
    assert.deepEqual(calls[0][1].tokenHash, calls[1][1].tokenHash);
  });

  it('normalizes the administrator email, validates the new password, and uses a fresh scrypt credential', async () => {
    let received;
    const auth = fixture({
      async resetAdministratorPassword(input) {
        received = input;
        return true;
      },
    });
    assert.equal(await auth.resetAdministratorPassword({
      email: '  ADMIN@EXAMPLE.COM ', password: 'new password value',
    }), true);
    assert.equal(received.email, 'admin@example.com');
    assert.equal(received.now, NOW);
    assert.equal(received.credential.algorithm, 'SCRYPT');
    assert.equal(received.credential.hash.length, 64);
    assert.equal(received.credential.salt.length >= 16, true);
    assert.equal(await verifyPassword('new password value', received.credential), true);
    await assert.rejects(auth.resetAdministratorPassword({
      email: 'admin@example.com', password: 'short',
    }), { code: 'invalid_request' });
  });
});

function fixture(overrides = {}) {
  const adapter = {
    async register() { return USER; },
    async findAccountByEmail() { return null; },
    async createSession() { return { id: '99' }; },
    async findActiveSession() { return null; },
    async revokeSession() {},
    async bootstrapAdministrator() { return USER; },
    async resetAdministratorPassword() { return false; },
    ...overrides,
  };
  return createAuthModule({
    adapter,
    clock: { now: () => NOW },
    generateToken: () => TOKEN,
  });
}
