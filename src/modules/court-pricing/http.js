import { Router } from 'express';
import { z } from 'zod';

import { validateEmptyQuery, validateIdRequest } from '../admin/validation.js';
import { appError } from '../../shared/errors.js';

const payload = z.object({
  priceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('COP'),
}).strict();

export function createCourtPricingRouter({ pricing, requireIdentity }) {
  if (!pricing || typeof requireIdentity !== 'function') {
    throw new TypeError('Court pricing and requireIdentity are required');
  }
  const router = Router();
  for (const scope of ['admin', 'owner']) {
    const base = `/api/v1/${scope}/courts/:courtId/prices`;
    router.use(base, requireIdentity, scope === 'admin' ? requireAdministrator : requireOwner);
    router.get(base, async (request, response) => {
      validateEmptyQuery(request.query);
      response.json(await pricing.listPrices({ actor: request.context.user,
        courtId: validateIdRequest('courtId', request.params.courtId).courtId, scope }));
    });
    router.put(`${base}/:durationMinutes`, async (request, response) => {
      validateEmptyQuery(request.query);
      const result = payload.safeParse(request.body);
      if (!result.success) throw invalidRequest();
      response.json(await pricing.setPrice({ actor: request.context.user, scope,
        courtId: validateIdRequest('courtId', request.params.courtId).courtId,
        durationMinutes: duration(request.params.durationMinutes),
        priceMinor: result.data.priceMinor }));
    });
    router.delete(`${base}/:durationMinutes`, async (request, response) => {
      validateEmptyQuery(request.query);
      rejectBody(request);
      response.json(await pricing.removePrice({ actor: request.context.user, scope,
        courtId: validateIdRequest('courtId', request.params.courtId).courtId,
        durationMinutes: duration(request.params.durationMinutes) }));
    });
  }
  return router;
}

function duration(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)
    || Number(value) > 65_535) throw invalidRequest();
  return Number(value);
}

function requireAdministrator(request, _response, next) {
  if (!request.context.user.roles?.includes('ADMINISTRADOR')) {
    next(appError('forbidden', 'The user cannot perform this operation'));
    return;
  }
  next();
}

function requireOwner(request, _response, next) {
  if (!request.context.user.roles?.includes('PROPIETARIO')) {
    next(appError('forbidden', 'The user cannot perform this operation'));
    return;
  }
  next();
}

function rejectBody(request) {
  if (Number(request.headers['content-length'] ?? 0) > 0
    || request.headers['transfer-encoding'] !== undefined) throw invalidRequest();
}

function invalidRequest() {
  return appError('invalid_request', 'The request is invalid');
}
