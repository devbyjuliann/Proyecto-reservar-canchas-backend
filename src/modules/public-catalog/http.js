import { Router } from 'express';

import { appError } from '../../shared/errors.js';
import { rejectBody, validateEmptyQuery, validateFilters, validateId } from './validation.js';

export function createPublicCatalogRouter({ catalog, facilities, requireIdentity }) {
  if (!catalog || !facilities || typeof requireIdentity !== 'function') {
    throw new TypeError('Catalog, facilities, and requireIdentity are required');
  }
  const router = Router();
  const publication = '/api/v1/admin/facilities/:facilityId/publication';
  router.use(publication, requireIdentity, requireAdministrator, rejectIdempotencyKey);

  router.get('/api/v1/facilities', async (request, response) => {
    response.json(await catalog.listFacilities(validateFilters(request.query, 'facilities')));
  });

  router.get('/api/v1/facilities/:facilityId/courts', async (request, response) => {
    response.json(await catalog.listFacilityCourts({
      facilityId: validateId(request.params.facilityId),
      ...validateFilters(request.query, 'facility-courts'),
    }));
  });

  router.get('/api/v1/facilities/:facilityId', async (request, response) => {
    validateEmptyQuery(request.query);
    response.json({ facility: await catalog.getFacility(validateId(request.params.facilityId)) });
  });

  router.get('/api/v1/courts', async (request, response) => {
    response.json(await catalog.listCourts(validateFilters(request.query, 'courts')));
  });

  router.get('/api/v1/courts/:courtId', async (request, response) => {
    validateEmptyQuery(request.query);
    response.json({ court: await catalog.getCourt(validateId(request.params.courtId)) });
  });

  router.post(publication, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const facilityId = validateId(request.params.facilityId);
    const operation = await catalog.publish({ actor: request.context.user, facilityId });
    response.json({ facility: await facilities.getFacility({
      actor: request.context.user, facilityId,
    }), operation: { changed: operation.changed, changes: [] } });
  });

  router.delete(publication, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const facilityId = validateId(request.params.facilityId);
    const operation = await catalog.unpublish({ actor: request.context.user, facilityId });
    response.json({ facility: await facilities.getFacility({
      actor: request.context.user, facilityId,
    }), operation: { changed: operation.changed, changes: [] } });
  });

  return router;
}

function requireAdministrator(request, _response, next) {
  if (!request.context.user.roles?.includes('ADMINISTRADOR')) {
    next(appError('forbidden', 'The user cannot perform this operation'));
    return;
  }
  next();
}

function rejectIdempotencyKey(request, _response, next) {
  if (request.headers['idempotency-key'] !== undefined) {
    next(appError('invalid_request', 'The request is invalid'));
    return;
  }
  next();
}
