import { Temporal } from '@js-temporal/polyfill';

import { appError } from '../../shared/errors.js';
import {
  generateSessionToken as createRandomSessionToken,
  hashPassword,
  hashSessionToken,
  isSessionToken,
  verifyPassword,
} from './crypto.js';
import { validateLogin, validatePassword, validateRegistration } from './validation.js';
import { validateResetConfirm, validateResetRequest } from './validation.js';

const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
const RESET_DURATION_SECONDS = 30 * 60;
const DUMMY_PASSWORD = 'invalid-login-password';

export function createAuthModule({
  adapter,
  clock,
  generateToken = createRandomSessionToken,
  sendPasswordResetEmail,
  frontendOrigin,
}) {
  if (!adapter || typeof clock?.now !== 'function') {
    throw new TypeError('An auth adapter and clock are required');
  }

  const dummyCredentialPromise = hashPassword(DUMMY_PASSWORD);

  return Object.freeze({
    register,
    login,
    resolveSession,
    revokeSession,
    bootstrapAdministrator,
    resetAdministratorPassword,
    requestPasswordReset,
    confirmPasswordReset,
  });

  async function register(input) {
    const registration = validateRegistration(input);
    const credential = await hashPassword(registration.password);
    const now = clock.now();
    try {
      return await adapter.register({
        name: registration.name,
        email: registration.email,
        credential,
        now,
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') {
        throw appError('email_already_registered', 'The email is already registered');
      }
      throw error;
    }
  }

  async function login(input) {
    const attempt = validateLogin(input);
    const account = await adapter.findAccountByEmail(attempt.email);
    const credential = account?.credential ?? await dummyCredentialPromise;
    const passwordMatches = await verifyPassword(attempt.password, credential);
    if (!account || !passwordMatches || account.deactivatedAt !== null) {
      throw invalidCredentials();
    }

    const token = generateToken();
    if (!isSessionToken(token)) throw new Error('Session token generator returned an invalid token');
    const now = clock.now();
    const expiresAt = Temporal.Instant.from(now)
      .add({ seconds: SESSION_DURATION_SECONDS })
      .toString({ fractionalSecondDigits: 6 });
    const session = await adapter.createSession({
      userId: account.user.id,
      tokenHash: hashSessionToken(token),
      now,
      expiresAt,
    });
    if (!session) throw invalidCredentials();
    return { user: account.user, sessionId: session.id, token, expiresAt };
  }

  async function resolveSession(token) {
    if (!isSessionToken(token)) return null;
    return adapter.findActiveSession({ tokenHash: hashSessionToken(token), now: clock.now() });
  }

  async function revokeSession(token) {
    if (!isSessionToken(token)) return;
    await adapter.revokeSession({ tokenHash: hashSessionToken(token), now: clock.now() });
  }

  async function bootstrapAdministrator(input) {
    const registration = validateRegistration(input);
    const credential = await hashPassword(registration.password);
    try {
      return await adapter.bootstrapAdministrator({
        name: registration.name,
        email: registration.email,
        credential,
        now: clock.now(),
      });
    } catch (error) {
      if (error?.code === 'ADMINISTRATOR_ALREADY_EXISTS') {
        throw appError('administrator_already_exists', 'An administrator already exists');
      }
      if (error?.code === 'ER_DUP_ENTRY') {
        throw appError('email_already_registered', 'The email is already registered');
      }
      throw error;
    }
  }

  async function resetAdministratorPassword({ email, password }) {
    const normalizedEmail = validateLogin({ email, password: '' }).email;
    const credential = await hashPassword(validatePassword(password));
    return adapter.resetAdministratorPassword({
      email: normalizedEmail,
      credential,
      now: clock.now(),
    });
  }

  async function requestPasswordReset(input) {
    const { email } = validateResetRequest(input);
    if (typeof sendPasswordResetEmail !== 'function' || !frontendOrigin) {
      throw new Error('Password reset mailer and frontend origin are required');
    }
    const account = await adapter.findAccountByEmail(email);
    await hashPassword(DUMMY_PASSWORD);
    if (!account || account.deactivatedAt !== null) {
      return;
    }
    const token = generateToken();
    if (!isSessionToken(token)) throw new Error('Password reset token generator returned an invalid token');
    const now = clock.now();
    const expiresAt = Temporal.Instant.from(now).add({ seconds: RESET_DURATION_SECONDS })
      .toString({ fractionalSecondDigits: 6 });
    const tokenHash = hashSessionToken(token);
    let created;
    try {
      created = await adapter.issuePasswordReset({ userId: account.user.id, tokenHash, now, expiresAt });
    } catch {
      // Do not expose account existence through an issuance failure.
      return;
    }
    if (!created) return;
    const resetUrl = new URL('/reset-password', frontendOrigin);
    resetUrl.searchParams.set('token', token);
    try {
      await sendPasswordResetEmail({ email: account.user.email, resetUrl: resetUrl.toString(), expiresAt });
    } catch {
      try { await adapter.invalidatePasswordReset({ tokenHash, now: clock.now() }); } catch { /* No public disclosure. */ }
      // The public response remains the same for an address with or without an account.
    }
  }

  async function confirmPasswordReset(input) {
    const { token, newPassword } = validateResetConfirm(input);
    if (!isSessionToken(token)) throw appError('invalid_password_reset_token', 'The reset link is invalid or expired');
    const credential = await hashPassword(newPassword);
    const changed = await adapter.consumePasswordReset({
      tokenHash: hashSessionToken(token), credential, now: clock.now(),
    });
    if (!changed) throw appError('invalid_password_reset_token', 'The reset link is invalid or expired');
  }
}

function invalidCredentials() {
  return appError('invalid_credentials', 'The credentials are invalid');
}
