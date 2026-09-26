import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export const PASSWORD_ALGORITHM = 'SCRYPT';
export const SCRYPT_PARAMETERS = Object.freeze({
  cost: 32_768,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
});

export async function hashPassword(password, {
  salt = randomBytes(16),
  parameters = SCRYPT_PARAMETERS,
} = {}) {
  const normalizedSalt = Buffer.from(salt);
  if (normalizedSalt.length < 16) throw new TypeError('Password salt must contain at least 16 bytes');
  const hash = await derive(password, normalizedSalt, parameters);
  return Object.freeze({
    algorithm: PASSWORD_ALGORITHM,
    hash,
    salt: normalizedSalt,
    parameters: Object.freeze({ ...parameters }),
  });
}

export async function verifyPassword(password, credential) {
  if (credential?.algorithm !== PASSWORD_ALGORITHM) {
    throw new Error('Unsupported password algorithm');
  }
  const expected = Buffer.from(credential.hash);
  const actual = await derive(password, Buffer.from(credential.salt), {
    cost: credential.parameters.cost,
    blockSize: credential.parameters.blockSize,
    parallelization: credential.parameters.parallelization,
    keyLength: expected.length,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function isSessionToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return Buffer.from(value, 'base64url').length === 32;
}

async function derive(password, salt, parameters) {
  return scrypt(password, salt, parameters.keyLength, {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelization,
    maxmem: 64 * 1024 * 1024,
  });
}
