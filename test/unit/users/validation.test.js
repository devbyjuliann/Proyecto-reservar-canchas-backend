import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidEmail,
  normalizeEmail,
  validateCreateUserInput,
  validateRole,
} from '../../../src/modules/users/index.js';

test('normalizeEmail trims and lowercases without provider-specific rewriting', () => {
  assert.equal(normalizeEmail('  Person.Name+tag@Example.COM  '), 'person.name+tag@example.com');
});

test('email validation accepts a minimal conventional address', () => {
  assert.equal(isValidEmail('person@example.com'), true);
  assert.equal(isValidEmail('person@example'), false);
  assert.equal(isValidEmail('person @example.com'), false);
});

test('create user validation normalizes name and email', () => {
  assert.deepEqual(
    validateCreateUserInput({ name: '  Ada Lovelace ', email: ' ADA@EXAMPLE.COM ' }),
    { name: 'Ada Lovelace', email: 'ada@example.com' },
  );
});

test('create user validation rejects malformed email', () => {
  assert.throws(
    () => validateCreateUserInput({ name: 'Ada', email: 'not-an-email' }),
    { code: 'USERS_VALIDATION_ERROR' },
  );
});

test('only the two persisted roles are accepted', () => {
  assert.equal(validateRole('USUARIO'), 'USUARIO');
  assert.equal(validateRole('ADMINISTRADOR'), 'ADMINISTRADOR');
  assert.throws(() => validateRole('SUPERADMIN'), {
    code: 'USERS_VALIDATION_ERROR',
  });
});
