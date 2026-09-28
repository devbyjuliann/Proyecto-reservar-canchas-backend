import { createHash } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';

import { compareInstants, toInstantString } from '../../shared/time.js';
import {
  BOOKING_STATUS,
  createBookingDomain,
  effectiveBookingStatus,
} from './domain/index.js';
import { bookingError } from './errors.js';

const REJECTION_CODES = Object.freeze({
  DURATION_NOT_ALLOWED: 'invalid_booking_option',
  START_NOT_ON_GRID: 'invalid_booking_option',
  OUTSIDE_OPERATING_HOURS: 'invalid_booking_option',
  UNAVAILABLE: 'option_not_available',
  BOOKING_CONFLICT: 'booking_conflict',
  OUTSIDE_BOOKING_WINDOW: 'option_not_available',
});

export function createBookingModule({ adapter, clock }) {
  if (!adapter) throw new TypeError('A booking adapter is required');
  if (typeof clock?.now !== 'function') throw new TypeError('A clock is required');

  return Object.freeze({
    getAvailability,
    confirmBooking,
    listOwnBookings,
    listOwnerBookings,
    cancelBooking,
    replaceFacilityBookingPolicy,
    deactivateFacility,
    createCourt,
    getCourtBookingConfiguration,
    replaceCourtBookingConfiguration,
    getWeeklySchedule,
    replaceWeeklySchedule,
    listDateExceptions,
    getDateException,
    putDateException,
    deleteDateException,
    listUnavailabilities,
    createUnavailability,
    getUnavailability,
    deactivateCourt,
    listOperationalConflicts,
    getOperationalConflict,
  });

  async function getAvailability({ courtId, date }) {
    const now = toInstantString(clock.now());
    const snapshot = await adapter.readAvailabilityContext({ courtId, date });
    if (!snapshot) throw bookingError('resource_not_found');

    const options = runDomain(now, (domain) =>
      domain.generateAvailability(snapshot.context));
    const pricedOptions = options.filter((option) => snapshot.prices?.has(option.durationMinutes));
    return {
      court: {
        id: String(snapshot.court.id),
        timeZone: snapshot.context.timeZone,
      },
      date,
      generatedAt: now,
      options: pricedOptions.map(({ startTime, durationMinutes, startAt, endAt }) => ({
        startTime,
        durationMinutes,
        priceMinor: snapshot.prices.get(durationMinutes),
        currency: 'COP',
        startAt: toInstantString(startAt),
        endAt: toInstantString(endAt),
      })),
    };
  }

  async function confirmBooking({ actor, request, idempotencyKey }) {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({
        courtId: request.courtId,
        localDate: request.localDate,
        startTime: request.startTime,
        durationMinutes: request.durationMinutes,
        expectedPriceMinor: request.expectedPriceMinor,
        currency: request.currency,
      }))
      .digest();

    const result = await adapter.confirmBooking({
      userId: String(actor.id),
      request,
      idempotencyKey,
      requestHash,
      evaluate({ context, now }) {
        let evaluation;
        try {
          evaluation = createBookingDomain({ clock: { now: () => now } })
            .validateOption(context, {
              startTime: request.startTime,
              durationMinutes: request.durationMinutes,
            });
        } catch (error) {
          if (
            error?.code === 'INVALID_LOCAL_TIME_IN_TIME_ZONE'
            && String(error.message).startsWith('option.')
          ) {
            return { accepted: false, code: 'invalid_booking_option' };
          }
          throw error;
        }

        if (!evaluation.reservable) {
          return {
            accepted: false,
            code: evaluation.reasons.map((reason) => REJECTION_CODES[reason]).find(Boolean)
              ?? 'internal_error',
          };
        }
        return { accepted: true, option: evaluation.option };
      },
    });

    if (result.kind === 'rejected') throw bookingError(result.code, result.code === 'booking_price_changed'
      ? { details: { currentPriceMinor: result.currentPriceMinor ?? null, currency: 'COP' } }
      : undefined);
    return { booking: presentBooking(result.booking, result.now), replayed: result.replayed };
  }

  async function listOwnBookings({ actor, limit, cursor }) {
    const decodedCursor = cursor === undefined ? undefined : decodeCursor(cursor);
    const now = toInstantString(clock.now());
    const rows = await adapter.listOwnBookings({
      userId: String(actor.id),
      limit: limit + 1,
      cursor: decodedCursor,
    });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((booking) => presentBooking(booking, now)),
      page: {
        nextCursor: hasMore && last
          ? encodeCursor({ startAt: last.startAt, id: String(last.id) })
          : null,
      },
    };
  }

  async function listOwnerBookings({ actor, limit, cursor, ...input }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    const filters = { userId: String(actor.id) };
    for (const name of ['facilityId', 'courtId', 'status', 'startFrom', 'startBefore']) {
      if (input[name] !== undefined) filters[name] = input[name];
    }
    const position = cursor === undefined ? undefined
      : decodeAdminCursor(cursor, 'owner-bookings', filters);
    const now = toInstantString(clock.now());
    const rows = await adapter.listOwnerBookings({ ...input, userId: String(actor.id),
      now, limit: limit + 1, cursor: position });
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      persistedStatus: row.status,
      status: effectiveBookingStatus(row, now),
      startAt: row.startAt,
      endAt: row.endAt,
      timeZone: row.timeZone,
      durationMinutes: Temporal.Instant.from(row.startAt).until(row.endAt).total('minutes'),
      court: row.court,
      facility: row.facility,
      user: row.user,
      priceMinor: row.priceMinor,
      currency: row.currency,
    }));
    const last = rows[limit - 1];
    return { items, page: { nextCursor: rows.length > limit
      ? encodeAdminCursor('owner-bookings', filters, { startAt: last.startAt, id: last.id })
      : null } };
  }

  async function cancelBooking({ actor, bookingId }) {
    const result = await adapter.cancelBooking({
      userId: String(actor.id),
      bookingId,
      decide({ booking, now }) {
        if (String(booking.userId) !== String(actor.id)) {
          throw bookingError('forbidden');
        }
        if (booking.status === BOOKING_STATUS.CANCELLED) return 'unchanged';

        const effectiveStatus = effectiveBookingStatus(booking, now);
        if (effectiveStatus === BOOKING_STATUS.COMPLETED) {
          throw bookingError('invalid_booking_state');
        }
        if (compareInstants(now, booking.startAt) >= 0) {
          throw bookingError('booking_already_started');
        }
        return 'cancel';
      },
    });
    if (!result) throw bookingError('resource_not_found');
    return { booking: presentBooking(result.booking, result.now) };
  }

  async function replaceFacilityBookingPolicy({ actor, facilityId, policy, ...input }) {
    return adminMutation(actor, 'replaceFacilityBookingPolicy', {
      facilityId,
      policy: policy ?? input,
      assessExistingBooking,
    });
  }

  async function deactivateFacility({ actor, facilityId }) {
    return adminMutation(actor, 'deactivateFacility', { facilityId });
  }

  async function createCourt({ actor, facilityId, court, ...input }) {
    return adminMutation(actor, 'createCourt', { facilityId, court: court ?? input });
  }

  async function getCourtBookingConfiguration({ actor, courtId }) {
    return adminRead(actor, 'getCourtBookingConfiguration', { courtId });
  }

  async function replaceCourtBookingConfiguration({ actor, courtId, bookingConfiguration, ...input }) {
    return adminMutation(actor, 'replaceCourtBookingConfiguration', {
      courtId,
      bookingConfiguration: bookingConfiguration ?? input,
      assessExistingBooking,
    });
  }

  async function getWeeklySchedule({ actor, courtId }) {
    return adminRead(actor, 'getWeeklySchedule', { courtId });
  }

  async function replaceWeeklySchedule({ actor, courtId, weeklySchedule, periods }) {
    return adminMutation(actor, 'replaceWeeklySchedule', {
      courtId,
      weeklySchedule: weeklySchedule ?? { periods },
      assessExistingBooking,
    });
  }

  async function listDateExceptions({ actor, courtId, limit = 25, cursor }) {
    return adminList(actor, 'listDateExceptions', {
      courtId,
      limit,
      cursor,
      kind: 'date-exceptions',
      filters: { courtId: String(courtId) },
      position(row) {
        return { localDate: row.localDate };
      },
    });
  }

  async function getDateException({ actor, courtId, localDate }) {
    return adminRead(actor, 'getDateException', { courtId, localDate });
  }

  async function putDateException({ actor, courtId, localDate, dateException, ...input }) {
    return adminMutation(actor, 'putDateException', {
      courtId,
      localDate,
      dateException: dateException ?? input,
      assessExistingBooking,
    });
  }

  async function deleteDateException({ actor, courtId, localDate }) {
    return adminMutation(actor, 'deleteDateException', {
      courtId,
      localDate,
      assessExistingBooking,
    });
  }

  async function listUnavailabilities({ actor, courtId, limit = 25, cursor }) {
    return adminList(actor, 'listUnavailabilities', {
      courtId,
      limit,
      cursor,
      kind: 'unavailabilities',
      filters: { courtId: String(courtId) },
      position(row) {
        return { startAt: toInstantString(row.startAt), id: String(row.id) };
      },
    });
  }

  async function createUnavailability({ actor, courtId, unavailability, ...input }) {
    return adminMutation(actor, 'createUnavailability', {
      courtId,
      unavailability: unavailability ?? input,
      assessExistingBooking,
    });
  }

  async function getUnavailability({ actor, unavailabilityId }) {
    return adminRead(actor, 'getUnavailability', { unavailabilityId });
  }

  async function deactivateCourt({ actor, courtId }) {
    return adminMutation(actor, 'deactivateCourt', { courtId });
  }

  async function listOperationalConflicts({ actor, limit = 25, cursor, ...filters }) {
    const normalizedFilters = Object.fromEntries(
      ['courtId', 'bookingId', 'operationalChangeId']
        .filter((name) => filters[name] !== undefined)
        .map((name) => [name, String(filters[name])]),
    );
    return adminList(actor, 'listOperationalConflicts', {
      ...filters,
      limit,
      cursor,
      kind: 'operational-conflicts',
      filters: normalizedFilters,
      position(row) {
        return { detectedAt: toInstantString(row.detectedAt), id: String(row.id) };
      },
    });
  }

  async function getOperationalConflict({ actor, conflictId }) {
    return adminRead(actor, 'getOperationalConflict', { conflictId });
  }

  async function adminRead(actor, adapterMethod, input) {
    assertOperationalActor(actor);
    const now = toInstantString(clock.now());
    const result = await adapter[adapterMethod]({
      ...input,
      actorUserId: String(actor.id),
      now,
    });
    if (result == null) throw bookingError('resource_not_found');
    return result;
  }

  async function adminMutation(actor, adapterMethod, input) {
    assertOperationalActor(actor);
    const now = toInstantString(clock.now());
    const operationInput = input.assessExistingBooking
      ? {
          ...input,
          assessExistingBooking(payload) {
            return input.assessExistingBooking({ ...payload, now });
          },
        }
      : input;
    const result = await adapter[adapterMethod]({
      ...operationInput,
      actorUserId: String(actor.id),
      ...(actor.ownerScope ? { ownerUserId: String(actor.id) } : {}),
      now,
    });
    if (result == null) throw bookingError('resource_not_found');
    return result;
  }

  async function adminList(actor, adapterMethod, {
    cursor,
    kind,
    filters,
    position,
    limit,
    ...input
  }) {
    assertOperationalActor(actor);
    const now = toInstantString(clock.now());
    const decodedCursor = cursor === undefined
      ? undefined
      : decodeAdminCursor(cursor, kind, filters);
    const rows = await adapter[adapterMethod]({
      ...input,
      actorUserId: String(actor.id),
      now,
      limit: limit + 1,
      cursor: decodedCursor,
    });
    if (rows == null) throw bookingError('resource_not_found');
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return {
      items,
      page: {
        nextCursor: hasMore && items.length > 0
          ? encodeAdminCursor(kind, filters, position(items.at(-1)))
          : null,
      },
    };
  }

  function assessExistingBooking({ context, booking, now }) {
    try {
      return createBookingDomain({ clock: { now: () => now } })
        .assessExistingBooking(context, booking);
    } catch (error) {
      throw bookingError('invalid_operational_configuration', { cause: error });
    }
  }

}

function assertAdministrator(actor) {
  if (!actor || !Array.isArray(actor.roles) || !actor.roles.includes('ADMINISTRADOR') || actor.id == null) {
    throw bookingError('forbidden');
  }
}

function assertOperationalActor(actor) {
  if (actor?.ownerScope === true) {
    if (actor.id == null || !actor.roles?.includes('PROPIETARIO')) throw bookingError('forbidden');
    return;
  }
  assertAdministrator(actor);
}

function encodeAdminCursor(kind, filters, position) {
  validateAdminCursorPosition(kind, position);
  return Buffer.from(JSON.stringify({
    v: 1,
    kind,
    filters,
    position,
  })).toString('base64url');
}

function decodeAdminCursor(value, kind, filters) {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();

    const decoded = JSON.parse(bytes.toString('utf8'));
    if (
      !isPlainObject(decoded)
      || Object.keys(decoded).sort().join(',') !== 'filters,kind,position,v'
      || decoded.v !== 1
      || decoded.kind !== kind
      || !isPlainObject(decoded.filters)
      || JSON.stringify(decoded.filters) !== JSON.stringify(filters)
    ) throw new Error();

    return validateAdminCursorPosition(kind, decoded.position);
  } catch (cause) {
    throw bookingError('invalid_request', {
      details: [{ field: 'cursor', message: 'Must be a valid cursor for this collection' }],
      cause,
    });
  }
}

function validateAdminCursorPosition(kind, position) {
  if (!isPlainObject(position)) throw new Error('Invalid cursor position');

  if (kind === 'date-exceptions') {
    if (Object.keys(position).join(',') !== 'localDate') throw new Error('Invalid cursor position');
    try {
      if (Temporal.PlainDate.from(position.localDate).toString() !== position.localDate) {
        throw new Error('Invalid cursor position');
      }
    } catch {
      throw new Error('Invalid cursor position');
    }
    return { localDate: position.localDate };
  }

  const instantField = kind === 'unavailabilities'
    ? 'startAt'
    : kind === 'operational-conflicts'
      ? 'detectedAt'
      : kind === 'owner-bookings'
        ? 'startAt'
      : null;
  if (instantField === null) throw new Error('Invalid cursor kind');
  if (Object.keys(position).sort().join(',') !== ['id', instantField].sort().join(',')) {
    throw new Error('Invalid cursor position');
  }
  if (!isCanonicalId(position.id)) throw new Error('Invalid cursor position');
  const instant = toInstantString(position[instantField]);
  if (instant !== position[instantField]) throw new Error('Invalid cursor position');
  return { [instantField]: instant, id: position.id };
}

function isCanonicalId(value) {
  return typeof value === 'string'
    && /^[1-9]\d*$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function runDomain(now, operation) {
  try {
    return operation(createBookingDomain({ clock: { now: () => now } }));
  } catch (error) {
    throw bookingError('internal_error', { cause: error });
  }
}

function presentBooking(booking, now) {
  return {
    id: String(booking.id),
    court: { id: String(booking.court.id), name: booking.court.name },
    facility: { id: String(booking.facility.id), name: booking.facility.name },
    startAt: toInstantString(booking.startAt),
    endAt: toInstantString(booking.endAt),
    timeZone: booking.timeZone,
    priceMinor: booking.priceMinor ?? null,
    currency: booking.currency ?? null,
    status: effectiveBookingStatus({
      status: booking.status,
      endAt: booking.endAt,
    }, now),
    createdAt: toInstantString(booking.createdAt),
    cancelledAt: booking.cancelledAt == null ? null : toInstantString(booking.cancelledAt),
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({
    v: 1,
    startAt: toInstantString(value.startAt),
    id: value.id,
  })).toString('base64url');
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      decoded?.v !== 1
      || typeof decoded.id !== 'string'
      || !/^[1-9]\d*$/.test(decoded.id)
      || BigInt(decoded.id) > 18_446_744_073_709_551_615n
    ) {
      throw new Error('Invalid cursor');
    }
    const instant = Temporal.Instant.from(decoded.startAt);
    const year = instant.toZonedDateTimeISO('UTC').year;
    if (year < 1000 || year > 9999) throw new Error('Invalid cursor');
    return { startAt: toInstantString(instant.toString()), id: decoded.id };
  } catch (error) {
    throw bookingError('invalid_request', {
      details: [{ field: 'cursor', message: 'Must be a valid cursor' }],
      cause: error,
    });
  }
}
