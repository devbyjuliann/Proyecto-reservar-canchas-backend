import { Router } from 'express';

import { appError } from '../../shared/errors.js';
import {
  rejectBody,
  validateAdminPage,
  validateApplication,
  validateEmptyQuery,
  validateId,
  validateOwnPage,
  validateRejection,
} from './validation.js';

const OWN = '/api/v1/me/owner-applications';
const ADMIN = '/api/v1/admin/owner-applications';

export function createOwnerApplicationsRouter({ ownerApplications, requireIdentity }) {
  if (!ownerApplications || typeof requireIdentity !== 'function') {
    throw new TypeError('ownerApplications and requireIdentity are required');
  }
  const router = Router();
  router.use(OWN, requireIdentity);
  router.use(ADMIN, requireIdentity, requireAdministrator, rejectIdempotencyKey);

  router.post(OWN, async (request, response) => {
    validateEmptyQuery(request.query);
    const application = await ownerApplications.create({
      actor: request.context.user, ...validateApplication(request.body),
    });
    response.location(`${OWN}/${application.id}`).status(201).json({ ownerApplication: application });
  });

  router.get(OWN, async (request, response) => {
    response.json(await ownerApplications.listOwn({
      actor: request.context.user, ...validateOwnPage(request.query),
    }));
  });

  router.get(`${OWN}/:applicationId`, async (request, response) => {
    validateEmptyQuery(request.query);
    response.json({ ownerApplication: await ownerApplications.getOwn({
      actor: request.context.user, applicationId: validateId(request.params.applicationId),
    }) });
  });

  router.get(ADMIN, async (request, response) => {
    response.json(await ownerApplications.listAdmin({
      actor: request.context.user, ...validateAdminPage(request.query),
    }));
  });

  router.get(`${ADMIN}/:applicationId`, async (request, response) => {
    validateEmptyQuery(request.query);
    response.json({ ownerApplication: await ownerApplications.getAdmin({
      actor: request.context.user, applicationId: validateId(request.params.applicationId),
    }) });
  });

  router.post(`${ADMIN}/:applicationId/approval`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    response.json(await ownerApplications.approve({
      actor: request.context.user, applicationId: validateId(request.params.applicationId),
    }));
  });

  router.post(`${ADMIN}/:applicationId/rejection`, async (request, response) => {
    validateEmptyQuery(request.query);
    response.json(await ownerApplications.reject({
      actor: request.context.user, applicationId: validateId(request.params.applicationId),
      ...validateRejection(request.body),
    }));
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
