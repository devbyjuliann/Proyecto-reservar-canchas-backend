import { appError } from '../shared/errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Idempotency-Key';

export function createHttpSecurity({ environment, frontendOrigin }) {
  if (typeof frontendOrigin !== 'string' || frontendOrigin === '') {
    throw new TypeError('frontendOrigin is required');
  }

  return function httpSecurity(request, response, next) {
    const origin = request.headers.origin;
    const originAllowed = origin === frontendOrigin;
    response.vary('Origin');

    if (originAllowed) {
      response.set('Access-Control-Allow-Origin', frontendOrigin);
      response.set('Access-Control-Allow-Credentials', 'true');
    }

    if (request.method === 'OPTIONS') {
      if (!originAllowed) {
        next(originNotAllowed());
        return;
      }
      response.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.status(204).end();
      return;
    }

    if (MUTATING_METHODS.has(request.method)) {
      const originRequired = environment === 'production';
      if ((originRequired && !originAllowed) || (origin !== undefined && !originAllowed)) {
        next(originNotAllowed());
        return;
      }
    }

    next();
  };
}

function originNotAllowed() {
  return appError('origin_not_allowed', 'The request origin is not allowed');
}
