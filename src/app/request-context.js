import { appError } from '../shared/errors.js';
import { readSessionCookie } from '../modules/auth/session-cookie.js';

const PROVISIONAL_IDENTITY_ENVIRONMENTS = new Set(['development', 'test']);

export function createRequestContext({ environment, findActiveUserById, resolveSession }) {
  if (typeof findActiveUserById !== 'function') {
    throw new TypeError('findActiveUserById is required');
  }

  return async function requestContext(request, _response, next) {
    try {
      if (typeof resolveSession === 'function') {
        const session = await resolveSession(readSessionCookie(request, environment));
        if (session) {
          request.context = Object.freeze({
            user: session.user,
            roles: Object.freeze([...session.user.roles]),
            sessionId: session.sessionId,
            sessionCreatedAt: session.sessionCreatedAt,
          });
          next();
          return;
        }
      }

      if (!PROVISIONAL_IDENTITY_ENVIRONMENTS.has(environment)) throw authenticationRequired();
      const values = headerValues(request.rawHeaders, 'x-user-id');
      if (values.length !== 1 || !isValidId(values[0])) {
        throw authenticationRequired();
      }

      const user = await findActiveUserById(values[0]);
      if (!user) throw authenticationRequired();
      request.context = Object.freeze({
        user,
        roles: Object.freeze([...user.roles]),
        sessionId: null,
        sessionCreatedAt: null,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

function isValidId(value) {
  return /^[1-9]\d*$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function headerValues(rawHeaders, name) {
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === name) values.push(rawHeaders[index + 1]);
  }
  return values;
}

function authenticationRequired() {
  return appError('authentication_required', 'Authentication is required');
}
