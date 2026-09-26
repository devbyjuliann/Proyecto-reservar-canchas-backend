import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../../../src/modules/auth/index.js';

describe('authentication cryptography', () => {
  it('uses unique salts and hashes for the same password', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    assert.equal(first.salt.length >= 16, true);
    assert.equal(second.salt.length >= 16, true);
    assert.notDeepEqual(first.salt, second.salt);
    assert.notDeepEqual(first.hash, second.hash);
    assert.deepEqual(first.parameters, second.parameters);
  });

  it('accepts the correct password and rejects an incorrect password', async () => {
    const credential = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', credential), true);
    assert.equal(await verifyPassword('incorrect password', credential), false);
  });

  it('uses the increased cost for new hashes and still verifies stored legacy parameters', async () => {
    const password = 'correct horse battery staple';
    const legacy = await hashPassword(password, {
      parameters: { cost: 16_384, blockSize: 8, parallelization: 1, keyLength: 64 },
    });
    const current = await hashPassword(password);

    assert.equal(current.parameters.cost, 32_768);
    assert.equal(current.parameters.blockSize, 8);
    assert.equal(current.parameters.parallelization, 1);
    assert.equal(await verifyPassword(password, legacy), true);
    assert.equal(await verifyPassword('incorrect password', legacy), false);
    assert.equal(await verifyPassword(password, current), true);
  });

  it('creates deterministic 32-byte token hashes without retaining the token', () => {
    const first = hashSessionToken('opaque-token');
    const second = hashSessionToken('opaque-token');
    assert.equal(first.length, 32);
    assert.deepEqual(first, second);
    assert.equal(first.includes(Buffer.from('opaque-token')), false);
  });

  it('generates independent 32-byte session tokens', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();
    assert.notEqual(first, second);
    assert.equal(Buffer.from(first, 'base64url').length, 32);
    assert.equal(Buffer.from(second, 'base64url').length, 32);
  });
});
