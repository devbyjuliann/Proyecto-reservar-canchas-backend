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
import { validateGoogleCredential, validateResetConfirm, validateResetRequest } from './validation.js';

const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;
const RESET_DURATION_SECONDS = 30 * 60;
const DUMMY_PASSWORD = 'invalid-login-password';

export function createAuthModule({
  adapter,
  clock,
  generateToken = createRandomSessionToken,
  sendPasswordResetEmail,
  frontendOrigin,
  verifyGoogleCredential,
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
    loginWithGoogle,
    linkGoogle,
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
    if (!account?.credential || !passwordMatches || account.deactivatedAt !== null) {
      throw invalidCredentials();
    }

    return createLocalSession(account.user);
  }

  async function createLocalSession(user) {
    const token = generateToken();
    if (!isSessionToken(token)) throw new Error('Session token generator returned an invalid token');
    const now = clock.now();
    const expiresAt = Temporal.Instant.from(now)
      .add({ seconds: SESSION_DURATION_SECONDS })
      .toString({ fractionalSecondDigits: 6 });
    const session = await adapter.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      now,
      expiresAt,
    });
    if (!session) throw invalidCredentials();
    return { user, sessionId: session.id, token, expiresAt };
  }

  async function verifiedGoogleProfile(input) {
    const credential = validateGoogleCredential(input);
    if (!verifyGoogleCredential) throw appError('google_not_configured', 'Google sign-in is unavailable');
    let claims;
    try { claims = await verifyGoogleCredential(credential); }
    catch { throw appError('invalid_google_credential', 'Google sign-in failed'); }
    let email;
    try { email = validateLogin({ email: claims?.email, password: '' }).email; }
    catch { throw appError('invalid_google_credential', 'Google sign-in failed'); }
    if (claims.email_verified !== true || typeof claims.sub !== 'string'
      || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) {
      throw appError('invalid_google_credential', 'Google sign-in failed');
    }
    const domain = email.split('@')[1];
    const hostedDomain = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
    const allowAutoLink = domain === 'gmail.com'
      || (hostedDomain !== '' && domain === hostedDomain && /^[a-z0-9.-]+$/.test(hostedDomain));
    const name = typeof claims.name === 'string' && claims.name.trim()
      ? claims.name.trim().slice(0, 150) : email.split('@')[0].slice(0, 150);
    return { subject: claims.sub, email, name, allowAutoLink };
  }

  async function loginWithGoogle(input) {
    const profile = await verifiedGoogleProfile(input);
    const result = await adapter.resolveGoogleIdentity({ ...profile, now: clock.now() });
    if (result === 'link_required') {
      throw appError('google_link_requires_confirmation', 'Sign in with your password to link Google');
    }
    if (result === 'inactive') throw invalidCredentials();
    if (!result) throw appError('google_identity_conflict', 'Google sign-in is unavailable for this account');
    return createLocalSession(result);
  }

  async function linkGoogle({ actor, sessionId, sessionCreatedAt, ...input }) {
    if (!sessionId || !actor?.id) throw appError('authentication_required', 'A local session is required');
    let age;
    try { age = Temporal.Instant.from(sessionCreatedAt).until(clock.now()).total('minutes'); }
    catch { throw appError('google_link_requires_recent_login', 'Sign in again before linking Google'); }
    if (age < 0 || age > 15) {
      throw appError('google_link_requires_recent_login', 'Sign in again before linking Google');
    }
    const profile = await verifiedGoogleProfile(input);
    const linked = await adapter.linkGoogleIdentity({ userId: String(actor.id), sessionId, ...profile, now: clock.now() });
    if (linked === 'session_inactive') {
      throw appError('google_link_requires_recent_login', 'Sign in again before linking Google');
    }
    if (!linked) throw appError('google_identity_conflict', 'Google identity cannot be linked');
    return linked;
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
    if (!account?.credential || account.deactivatedAt !== null) {
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
