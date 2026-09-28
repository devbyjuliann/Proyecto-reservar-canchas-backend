import { Router } from 'express';

import { appError } from '../../shared/errors.js';
import { validateOwnerBookingsQuery } from './validation.js';
import {
  validateBookingConfiguration, validateCourtPatch, validateCreateCourt,
  validateCreateFacility, validateCreateUnavailability, validateDateException,
  validateEmptyQuery, validateFacilityBookingPolicy, validateFacilityPatch,
  validateIdRequest, validateLocalDateRequest, validatePageQuery,
  validateStatePageQuery, validateWeeklySchedule,
} from '../admin/validation.js';

const PREFIX = '/api/v1/owner';

export function createOwnerOperationsRouter({ facilities, booking, memberships, requireIdentity }) {
  if (!facilities || !booking || !memberships?.requireCourtMembership
    || typeof requireIdentity !== 'function') throw new TypeError('Owner operations dependencies are required');
  const router = Router();
  router.use(PREFIX, requireIdentity, requireOwnerRole, rejectIdempotencyKey);

  const actor = (request) => ({ ...request.context.user, ownerScope: true });
  const facilityId = (request) => validateIdRequest('facilityId', request.params.facilityId).facilityId;
  const courtId = (request) => validateIdRequest('courtId', request.params.courtId).courtId;
  const localDate = (request) => validateLocalDateRequest(request.params.localDate).localDate;
  async function ownFacility(request, id) {
    await memberships.requireMembership({ actor: request.context.user, facilityId: id });
  }
  async function ownCourt(request, id) {
    await memberships.requireCourtMembership({ actor: request.context.user, courtId: id });
  }

  router.get(`${PREFIX}/bookings`, async (request, response) => {
    const input = validateOwnerBookingsQuery(request.query);
    if (input.facilityId) await ownFacility(request, input.facilityId);
    if (input.courtId) {
      const facility = await memberships.requireCourtMembership({ actor: request.context.user,
        courtId: input.courtId });
      if (input.facilityId && facility.id !== input.facilityId) {
        throw appError('resource_not_found', 'The requested resource was not found');
      }
    }
    response.json(await booking.listOwnerBookings({ actor: actor(request), ...input }));
  });

  router.post(`${PREFIX}/facilities`, async (request, response) => {
    validateEmptyQuery(request.query);
    const result = await facilities.createFacility({ actor: actor(request), ...validateCreateFacility(request.body) });
    response.location(`${PREFIX}/facilities/${result.facility.id}`).status(201).json(result);
  });

  router.patch(`${PREFIX}/facilities/:facilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = facilityId(request);
    await ownFacility(request, id);
    response.json(await facilities.updateFacility({ actor: actor(request), facilityId: id,
      ...validateFacilityPatch(request.body) }));
  });

  router.put(`${PREFIX}/facilities/:facilityId/booking-policy`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = facilityId(request);
    await ownFacility(request, id);
    response.json(await booking.replaceFacilityBookingPolicy({ actor: actor(request), facilityId: id,
      ...validateFacilityBookingPolicy(request.body) }));
  });

  router.post(`${PREFIX}/facilities/:facilityId/deactivation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const id = facilityId(request);
    await ownFacility(request, id);
    response.json(await booking.deactivateFacility({ actor: actor(request), facilityId: id }));
  });

  router.get(`${PREFIX}/facilities/:facilityId/courts`, async (request, response) => {
    const id = facilityId(request);
    await ownFacility(request, id);
    response.json(await facilities.listCourts({ actor: actor(request), facilityId: id,
      ...validateStatePageQuery(request.query) }));
  });

  router.post(`${PREFIX}/facilities/:facilityId/courts`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = facilityId(request);
    await ownFacility(request, id);
    const result = await booking.createCourt({ actor: actor(request), facilityId: id,
      ...validateCreateCourt(request.body) });
    response.location(`${PREFIX}/courts/${result.court.id}`).status(201).json(result);
  });

  router.get(`${PREFIX}/courts/:courtId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json({ court: await facilities.getCourt({ actor: actor(request), courtId: id }) });
  });

  router.patch(`${PREFIX}/courts/:courtId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await facilities.updateCourt({ actor: actor(request), courtId: id,
      ...validateCourtPatch(request.body) }));
  });

  router.get(`${PREFIX}/courts/:courtId/booking-configuration`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await booking.getCourtBookingConfiguration({ actor: actor(request), courtId: id }));
  });

  router.put(`${PREFIX}/courts/:courtId/booking-configuration`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    const configuration = validateBookingConfiguration(request.body);
    if (configuration.courtId !== id) throw invalidRequest();
    response.json(await booking.replaceCourtBookingConfiguration({ actor: actor(request),
      bookingConfiguration: configuration, courtId: id }));
  });

  router.get(`${PREFIX}/courts/:courtId/weekly-schedule`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json({ weeklySchedule: await booking.getWeeklySchedule({ actor: actor(request), courtId: id }) });
  });

  router.put(`${PREFIX}/courts/:courtId/weekly-schedule`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await booking.replaceWeeklySchedule({ actor: actor(request), courtId: id,
      ...validateWeeklySchedule(request.body) }));
  });

  router.get(`${PREFIX}/courts/:courtId/date-exceptions`, async (request, response) => {
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await booking.listDateExceptions({ actor: actor(request), courtId: id,
      ...validatePageQuery(request.query) }));
  });

  router.get(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    const date = localDate(request);
    await ownCourt(request, id);
    response.json({ dateException: await booking.getDateException({ actor: actor(request),
      courtId: id, localDate: date }) });
  });

  router.put(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    const date = localDate(request);
    await ownCourt(request, id);
    response.json(await booking.putDateException({ actor: actor(request), courtId: id,
      localDate: date, ...validateDateException(request.body) }));
  });

  router.delete(`${PREFIX}/courts/:courtId/date-exceptions/:localDate`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const id = courtId(request);
    const date = localDate(request);
    await ownCourt(request, id);
    response.json(await booking.deleteDateException({ actor: actor(request), courtId: id, localDate: date }));
  });

  router.get(`${PREFIX}/courts/:courtId/unavailabilities`, async (request, response) => {
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await booking.listUnavailabilities({ actor: actor(request), courtId: id,
      ...validatePageQuery(request.query) }));
  });

  router.post(`${PREFIX}/courts/:courtId/unavailabilities`, async (request, response) => {
    validateEmptyQuery(request.query);
    const id = courtId(request);
    await ownCourt(request, id);
    const result = await booking.createUnavailability({ actor: actor(request), courtId: id,
      ...validateCreateUnavailability(request.body) });
    response.location(`${PREFIX}/unavailabilities/${result.unavailability.id}`).status(201).json(result);
  });

  router.get(`${PREFIX}/unavailabilities/:unavailabilityId`, async (request, response) => {
    validateEmptyQuery(request.query);
    const { unavailabilityId } = validateIdRequest('unavailabilityId', request.params.unavailabilityId);
    await memberships.requireUnavailabilityMembership({ actor: request.context.user, unavailabilityId });
    response.json({ unavailability: await booking.getUnavailability({ actor: actor(request), unavailabilityId }) });
  });

  router.post(`${PREFIX}/courts/:courtId/deactivation`, async (request, response) => {
    validateEmptyQuery(request.query);
    rejectBody(request);
    const id = courtId(request);
    await ownCourt(request, id);
    response.json(await booking.deactivateCourt({ actor: actor(request), courtId: id }));
  });

  return router;
}

function requireOwnerRole(request, _response, next) {
  if (!request.context.user.roles?.includes('PROPIETARIO')) {
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
