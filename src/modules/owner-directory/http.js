import { Router } from 'express';
import { appError } from '../../shared/errors.js';
import { validateEmptyQuery, validateIdRequest } from '../admin/validation.js';

const BASE = '/api/v1/admin/owners';

export function createOwnerDirectoryRouter({ ownerDirectory, requireIdentity }) {
  if (!ownerDirectory || typeof requireIdentity !== 'function') throw new TypeError('Owner directory dependencies are required');
  const router = Router();
  router.use(BASE, requireIdentity, (request, _response, next) => {
    if (!request.context.user.roles?.includes('ADMINISTRADOR')) return next(appError('forbidden', 'Administrator role is required'));
    next();
  });

  router.get(BASE, async (request, response) => {
    const keys = Object.keys(request.query);
    if (keys.some((key) => !['q', 'limit', 'cursor'].includes(key))) throw invalidRequest();
    const raw = request.query;
    const query = raw.q === undefined ? '' : typeof raw.q === 'string' ? raw.q.trim().normalize('NFC').toLowerCase() : null;
    if (query === null || query.length > 100 || (raw.q !== undefined && query.length === 0)) throw invalidRequest();
    const limit = raw.limit === undefined ? 25 : typeof raw.limit === 'string' && /^[1-9]\d*$/.test(raw.limit)
      ? Number(raw.limit) : NaN;
    if (!Number.isInteger(limit) || limit > 100) throw invalidRequest();
    response.json(await ownerDirectory.listOwners({ actor: request.context.user, query, limit, cursor: raw.cursor }));
  });

  router.get(`${BASE}/:ownerId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { ownerId } = validateIdRequest('ownerId', request.params.ownerId);
    response.json({ owner: await ownerDirectory.getOwner({ actor: request.context.user, ownerId }) });
  });

  for (const [method, suspended] of [['post', true], ['delete', false]]) {
    router[method](`${BASE}/:ownerId/suspension`, async (request, response) => {
      validateEmptyQuery(request.query);
      if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined
        || request.headers['idempotency-key'] !== undefined) throw invalidRequest();
      const { ownerId } = validateIdRequest('ownerId', request.params.ownerId);
      response.json(await ownerDirectory[suspended ? 'suspendOwner' : 'reactivateOwner']({
        actor: request.context.user, ownerId,
      }));
    });
  }
  return router;
}

function invalidRequest() { return appError('invalid_request', 'The request is invalid'); }
