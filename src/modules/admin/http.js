import { Router } from 'express';

import { appError } from '../../shared/errors.js';
import {
  validateBookingConfiguration,
  validateConflictQuery,
  validateCourtPatch,
  validateCreateCourt,
  validateCreateFacility,
  validateCreateUnavailability,
  validateDateException,
  validateEmptyQuery,
  validateFacilityBookingPolicy,
  validateFacilityPatch,
  validateIdRequest,
  validateLocalDateRequest,
  validatePageQuery,
  validateStatePageQuery,
  validateWeeklySchedule,
} from './validation.js';

const PREFIX = '/api/v1/admin';

export function createAdminRouter({ facilities, booking, requireIdentity }) {
  if (!facilities || !booking || typeof requireIdentity !== 'function') {
    throw new TypeError('facilities, booking, and requireIdentity are required');
  }

  const router = Router();
  router.use(PREFIX, requireIdentity, requireAdministrator, rejectIdempotencyKey, rejectBusinessMutation);

  router.get(`${PREFIX}/facilities`, async (request, response) => {
    response.json(await facilities.listFacilities(input(request, validateStatePageQuery(request.query))));
  });

  router.post(`${PREFIX}/facilities`, async (request, response) => {
    validateEmptyQuery(request.query);
    const result = await facilities.createFacility(input(request, validateCreateFacility(request.body)));
    response.location(`${PREFIX}/facilities/${result.facility.id}`).status(201).json(result);
  });

  router.get(`${PREFIX}/facilities/:facilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json({ facility: await facilities.getFacility(input(request, { facilityId })) });
  });

  router.patch(`${PREFIX}/facilities/:facilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await facilities.updateFacility(input(request, {
      facilityId,
      ...validateFacilityPatch(request.body),
    })));
  });

  router.put(`${PREFIX}/facilities/:facilityId/booking-policy`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await booking.replaceFacilityBookingPolicy(input(request, {
      facilityId,
      ...validateFacilityBookingPolicy(request.body),
    })));
  });

  router.post(`${PREFIX}/facilities/:facilityId/deactivation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await booking.deactivateFacility(input(request, { facilityId })));
  });

  router.post(`${PREFIX}/facilities/:facilityId/reactivation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await facilities.reactivateFacility(input(request, { facilityId })));
  });

  router.get(`${PREFIX}/facilities/:facilityId/courts`, async (request, response) => {
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    response.json(await facilities.listCourts(input(request, {
      facilityId,
      ...validateStatePageQuery(request.query),
    })));
  });

  router.post(`${PREFIX}/facilities/:facilityId/courts`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { facilityId } = validateIdRequest('facilityId', request.params.facilityId);
    const result = await booking.createCourt(input(request, {
      facilityId,
      ...validateCreateCourt(request.body),
    }));
    response.location(`${PREFIX}/courts/${result.court.id}`).status(201).json(result);
  });

  router.get(`${PREFIX}/courts/:courtId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json({ court: await facilities.getCourt(input(request, { courtId })) });
  });

  router.patch(`${PREFIX}/courts/:courtId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await facilities.updateCourt(input(request, {
      courtId,
      ...validateCourtPatch(request.body),
    })));
  });

  router.get(`${PREFIX}/courts/:courtId/booking-configuration`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await booking.getCourtBookingConfiguration(input(request, { courtId })));
  });

  router.put(`${PREFIX}/courts/:courtId/booking-configuration`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    const configuration = validateBookingConfiguration(request.body);
    if (configuration.courtId !== courtId) throw invalidRequest();
    response.json(await booking.replaceCourtBookingConfiguration(input(request, configuration)));
  });

  router.get(`${PREFIX}/courts/:courtId/weekly-schedule`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json({ weeklySchedule: await booking.getWeeklySchedule(input(request, { courtId })) });
  });

  router.put(`${PREFIX}/courts/:courtId/weekly-schedule`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await booking.replaceWeeklySchedule(input(request, {
      courtId,
      ...validateWeeklySchedule(request.body),
    })));
  });

  router.get(`${PREFIX}/courts/:courtId/date-exceptions`, async (request, response) => {
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await booking.listDateExceptions(input(request, {
      courtId,
      ...validatePageQuery(request.query),
    })));
  });

  router.get(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    const { localDate } = validateLocalDateRequest(request.params.localDate);
    response.json({
      dateException: await booking.getDateException(input(request, { courtId, localDate })),
    });
  });

  router.put(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    const { localDate } = validateLocalDateRequest(request.params.localDate);
    response.json(await booking.putDateException(input(request, {
      courtId,
      localDate,
      ...validateDateException(request.body),
    })));
  });

  router.delete(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    const { localDate } = validateLocalDateRequest(request.params.localDate);
    response.json(await booking.deleteDateException(input(request, { courtId, localDate })));
  });

  router.get(`${PREFIX}/courts/:courtId/unavailabilities`, async (request, response) => {
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await booking.listUnavailabilities(input(request, {
      courtId,
      ...validatePageQuery(request.query),
    })));
  });

  router.post(`${PREFIX}/courts/:courtId/unavailabilities`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    const result = await booking.createUnavailability(input(request, {
      courtId,
      ...validateCreateUnavailability(request.body),
    }));
    response.location(`${PREFIX}/unavailabilities/${result.unavailability.id}`).status(201).json(result);
  });

  router.get(`${PREFIX}/unavailabilities/:unavailabilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { unavailabilityId } = validateIdRequest(
      'unavailabilityId',
      request.params.unavailabilityId,
    );
    response.json({
      unavailability: await booking.getUnavailability(input(request, { unavailabilityId })),
    });
  });

  router.post(`${PREFIX}/courts/:courtId/deactivation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const { courtId } = validateIdRequest('courtId', request.params.courtId);
    response.json(await booking.deactivateCourt(input(request, { courtId })));
  });

  router.get(`${PREFIX}/operational-conflicts`, async (request, response) => {
    response.json(await booking.listOperationalConflicts(input(
      request,
      validateConflictQuery(request.query),
    )));
  });

  router.get(`${PREFIX}/operational-conflicts/:conflictId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { conflictId } = validateIdRequest('conflictId', request.params.conflictId);
    response.json(await booking.getOperationalConflict(input(request, { conflictId })));
  });

  return router;
}

function input(request, values) {
  return { actor: request.context.user, ...values };
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

function rejectBusinessMutation(request, _response, next) {
  const path = request.path;
  const method = request.method;
  const businessWrite = (method === 'POST' && (/^\/facilities(?:\/[^/]+\/courts)?$/.test(path)
    || /^\/courts\/[^/]+\/(?:unavailabilities|deactivation)$/.test(path)))
    || (method === 'PATCH' && /^\/(?:facilities|courts)\/[^/]+$/.test(path))
    || (method === 'PUT' && (/^\/facilities\/[^/]+\/booking-policy$/.test(path)
      || /^\/courts\/[^/]+\/(?:booking-configuration|weekly-schedule|date-exceptions\/[^/]+)$/.test(path)))
    || (method === 'DELETE' && /^\/courts\/[^/]+\/date-exceptions\/[^/]+$/.test(path));
  if (businessWrite) return next(appError('forbidden', 'Business operations belong to the owner'));
  next();
}

function rejectBody(request) {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > 0 || request.headers['transfer-encoding'] !== undefined) {
    throw invalidRequest();
  }
}

function invalidRequest() {
  return appError('invalid_request', 'The request is invalid');
}
