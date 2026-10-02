import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { appError } from '../../shared/errors.js';
import {
  readSessionCookie,
  sessionCookieName,
  sessionCookieOptions,
} from './session-cookie.js';

function authRateLimit(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(_request, _response, next) {
      next(appError('rate_limit_exceeded', 'Too many authentication attempts. Try again later'));
    },
  });
}

function testRateLimit(variable, fallback, environment) {
  if (environment !== 'test' || process.env[variable] === undefined) return fallback;
  const value = Number(process.env[variable]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${variable} must be a positive integer`);
  }
  return value;
}

export function createAuthRouter({ auth, environment, requireIdentity }) {
  if (!auth || typeof requireIdentity !== 'function') {
    throw new TypeError('auth and requireIdentity are required');
  }

  const router = Router();
  const registrationLimit = authRateLimit(60 * 60 * 1000,
    testRateLimit('AUTH_TEST_REGISTRATION_LIMIT', 5, environment));
  const loginLimit = authRateLimit(15 * 60 * 1000,
    testRateLimit('AUTH_TEST_LOGIN_LIMIT', 10, environment));
  const resetRequestLimit = authRateLimit(60 * 60 * 1000,
    testRateLimit('AUTH_TEST_RESET_REQUEST_LIMIT', 5, environment));
  const resetConfirmLimit = authRateLimit(15 * 60 * 1000,
    testRateLimit('AUTH_TEST_RESET_CONFIRM_LIMIT', 10, environment));

  router.post('/api/v1/auth/registrations', registrationLimit, async (request, response) => {
    const user = await auth.register(request.body);
    response.status(201).json({ user: presentUser(user) });
  });

  router.post('/api/v1/auth/sessions', loginLimit, async (request, response) => {
    const result = await auth.login(request.body);
    response.cookie(
      sessionCookieName(environment),
      result.token,
      sessionCookieOptions(environment, result.expiresAt),
    );
    response.json({ user: presentUser(result.user) });
  });

  router.post('/api/v1/auth/password-reset/request', resetRequestLimit, async (request, response) => {
    await auth.requestPasswordReset(request.body);
    response.json({ message: 'Si existe una cuenta asociada a ese correo, recibirás instrucciones para restablecer tu contraseña.' });
  });

  router.post('/api/v1/auth/password-reset/confirm', resetConfirmLimit, async (request, response) => {
    await auth.confirmPasswordReset(request.body);
    response.json({ message: 'Contraseña actualizada' });
  });

  router.delete('/api/v1/auth/session', async (request, response) => {
    if (hasBody(request)) throw appError('invalid_request', 'The request is invalid');
    await auth.revokeSession(readSessionCookie(request, environment));
    response.clearCookie(
      sessionCookieName(environment),
      sessionCookieOptions(environment),
    );
    response.status(204).end();
  });

  router.get('/api/v1/me', requireIdentity, (request, response) => {
    response.json({ user: presentUser(request.context.user) });
  });

  return router;
}

function presentUser(user) {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    roles: [...user.roles],
  };
}

function hasBody(request) {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  return contentLength > 0 || request.headers['transfer-encoding'] !== undefined;
}
