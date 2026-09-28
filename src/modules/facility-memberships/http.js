import { Router } from 'express';
import { z } from 'zod';

import { appError } from '../../shared/errors.js';
import { validateEmptyQuery, validateIdRequest, validatePageQuery } from '../admin/validation.js';

const ADMIN = '/api/v1/admin/facilities/:facilityId/memberships';
const OWN = '/api/v1/owner/facilities';
const idSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
);
const createSchema = z.object({
  userId: idSchema,
  membershipRole: z.literal('PROPIETARIO'),
}).strict();

export function createFacilityMembershipsRouter({ memberships, requireIdentity }) {
  if (!memberships || typeof requireIdentity !== 'function') {
    throw new TypeError('memberships and requireIdentity are required');
  }
  const router = Router();
  router.use(ADMIN, requireIdentity, requireAdministrator, rejectIdempotencyKey);
  router.use(OWN, requireIdentity);

  router.get(ADMIN, async (request, response) => {
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await memberships.listMemberships({
      actor: request.context.user, facilityId, ...validatePageQuery(request.query),
    }));
  });

  router.post(ADMIN, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw invalidRequest();
    const membership = await memberships.assignMembership({
      actor: request.context.user, facilityId, userId: parsed.data.userId,
    });
    response.location(`/api/v1/admin/facilities/${facilityId}/memberships/${membership.id}`)
      .status(201).json({ membership });
  });

  router.get(`${ADMIN}/:membershipId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    const { membershipId } = validateIdRequest('membershipId', request.params.membershipId);
    response.json({ membership: await memberships.getMembership({
      actor: request.context.user, facilityId, membershipId,
    }) });
  });

  router.post(`${ADMIN}/:membershipId/revocation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    const { membershipId } = validateIdRequest('membershipId', request.params.membershipId);
    const result = await memberships.revokeMembership({
      actor: request.context.user, facilityId, membershipId,
    });
    response.json({ membership: result.membership, operation: { changed: result.changed, changes: [] } });
  });

  router.get(OWN, async (request, response) => {
    response.json(await memberships.listOwnedFacilities({
      actor: request.context.user, ...validatePageQuery(request.query),
    }));
  });

  router.get(`${OWN}/:facilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json({ facility: await memberships.getOwnedFacility({
      actor: request.context.user, facilityId,
    }) });
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
    next(invalidRequest());
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
