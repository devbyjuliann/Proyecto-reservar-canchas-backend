import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_PASSWORD_BYTES,
  validateLogin,
  validatePassword,
  validateRegistration,
} from '../../../src/modules/auth/index.js';

describe('authentication validation', () => {
  it('requires 12 password characters without trimming or normalizing them', () => {
    assert.throws(() => validatePassword('12345678901'), { code: 'invalid_request' });
    assert.equal(validatePassword('  AbCdEfGhIj  '), '  AbCdEfGhIj  ');
    assert.equal(validatePassword('Ábcdefghijkl'), 'Ábcdefghijkl');
  });

  it('limits passwords by their UTF-8 byte length', () => {
    assert.equal(Buffer.byteLength('a'.repeat(MAX_PASSWORD_BYTES)), MAX_PASSWORD_BYTES);
    assert.equal(validatePassword('a'.repeat(MAX_PASSWORD_BYTES)).length, MAX_PASSWORD_BYTES);
    assert.throws(
      () => validatePassword('a'.repeat(MAX_PASSWORD_BYTES + 1)),
      { code: 'invalid_request' },
    );
  });

  it('normalizes email and rejects client-controlled identity and roles', () => {
    const registration = validateRegistration({
      name: '  Ana Perez  ',
      email: '  ANA@EXAMPLE.COM ',
      password: 'password value',
    });
    assert.equal(registration.name, 'Ana Perez');
    assert.equal(registration.email, 'ana@example.com');
    assert.throws(() => validateRegistration({
      ...registration,
      password: 'password value',
      roles: ['ADMINISTRADOR'],
    }), { code: 'invalid_request' });
    for (const field of ['userId', 'state']) {
      assert.throws(() => validateRegistration({
        name: 'Ana',
        email: 'ana@example.com',
        password: 'password value',
        [field]: 'controlled',
      }), { code: 'invalid_request' });
    }
  });

  it('allows short login attempts so incorrect credentials remain indistinguishable', () => {
    assert.deepEqual(validateLogin({ email: ' ANA@example.com ', password: 'wrong' }), {
      email: 'ana@example.com',
      password: 'wrong',
    });
  });
});
