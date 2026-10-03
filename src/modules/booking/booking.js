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

export function createBookingModule({ adapter, clock, notifications, logger = console }) {
  if (!adapter) throw new TypeError('A booking adapter is required');
  if (typeof clock?.now !== 'function') throw new TypeError('A clock is required');

  return Object.freeze({
    getAvailability,
    getFacilityCredit,
    confirmBooking,
    approveTestPayment,
    createPaymentAttempt,
    settlePayment,
    getLatestWompiTransaction,
    listOwnBookings,
    listOwnerBookings,
    cancelBooking,
    cancelExceptionBooking,
    rescheduleBooking,
    listBookingChanges,
    requestBookingException,
    listOwnerExceptions,
    decideBookingException,
    cancelOwnerBooking,
    markNoShow,
    updateCancellationPolicy,
    updateDepositPolicy,
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
        cancellationMinMinutes: snapshot.court.cancellationMinMinutes,
        depositPercentage: snapshot.court.depositPercentage,
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

  async function getFacilityCredit({ actor, facilityId }) {
    const credit = await adapter.getFacilityCredit({ facilityId, userId: String(actor.id) });
    if (!credit) throw bookingError('resource_not_found');
    return { facilityId: String(facilityId), balanceMinor: credit.balanceMinor, currency: 'COP' };
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
        useCreditMinor: request.useCreditMinor ?? 0,
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
    const booking = presentBooking(result.booking, result.now);
    // Confirmation is emitted only after a deposit is approved, never for a held checkout slot.
    if (!result.replayed && booking.status === BOOKING_STATUS.CONFIRMED) {
      await notifyBookingEvent('confirmation', actor, booking, result.booking.customerName);
    }
    return { booking, checkout: result.checkout, replayed: result.replayed };
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

  async function approveTestPayment({ bookingId, providerReference, amountMinor }) {
    const result = await adapter.approveTestPayment({ bookingId, providerReference, amountMinor });
    if (!result.replayed) {
      const booking = presentBooking(result.booking, toInstantString(clock.now()));
      await notifyBookingEvent('confirmation', {
        id: result.booking.userId,
        email: result.booking.customerEmail,
      }, booking, result.booking.customerName);
      return { ...result, booking };
    }
    return { ...result, booking: presentBooking(result.booking, toInstantString(clock.now())) };
  }

  async function createPaymentAttempt({ actor, bookingId, provider, reference }) {
    return adapter.createPaymentAttempt({ bookingId, userId: String(actor.id), provider, reference });
  }

  async function getLatestWompiTransaction({ actor, bookingId }) {
    return adapter.getLatestWompiTransaction({ bookingId, userId: String(actor.id) });
  }

  async function settlePayment(input) {
    const result = await adapter.settlePayment(input);
    if (result.confirmed && result.booking) {
      const presented = presentBooking(result.booking, toInstantString(clock.now()));
      await notifyBookingEvent('confirmation', { id: result.booking.userId, email: result.booking.customerEmail },
        presented, result.booking.customerName);
    }
    return result;
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
       noShowAt: row.noShowAt,
       paymentStatus: row.paymentStatus,
       depositPercentage: row.depositPercentage,
       depositAmountMinor: row.depositAmountMinor,
       amountPaidMinor: row.amountPaidMinor,
       paymentExpiresAt: row.paymentExpiresAt,
       voluntaryRescheduleCount: row.voluntaryRescheduleCount,
    }));
    const last = rows[limit - 1];
    return { items, page: { nextCursor: rows.length > limit
      ? encodeAdminCursor('owner-bookings', filters, { startAt: last.startAt, id: last.id })
      : null } };
  }

  async function cancelBooking({ actor, bookingId, expectedStartAt }) {
    if (expectedStartAt !== undefined) {
      try {
        if (toInstantString(expectedStartAt) !== expectedStartAt) throw new Error();
      } catch { throw bookingError('invalid_request'); }
    }
    const result = await adapter.cancelBooking({
      userId: String(actor.id),
      bookingId,
      decide({ booking, now }) {
        if (String(booking.userId) !== String(actor.id)) {
          throw bookingError('forbidden');
        }
        if (expectedStartAt && booking.startAt !== expectedStartAt) throw bookingError('booking_conflict');
        if (booking.status === BOOKING_STATUS.CANCELLED) return 'unchanged';

        const effectiveStatus = effectiveBookingStatus(booking, now);
        if (effectiveStatus === BOOKING_STATUS.COMPLETED) {
          throw bookingError('invalid_booking_state');
        }
        if (compareInstants(now, booking.startAt) >= 0) {
          throw bookingError('booking_cancellation_window_closed');
        }
        if (compareInstants(now, Temporal.Instant.from(booking.startAt)
          .subtract({ minutes: booking.cancellationMinMinutes ?? 120 }).toString()) > 0) {
          throw bookingError('booking_cancellation_window_closed');
        }
        return 'cancel';
      },
    });
    if (!result) throw bookingError('resource_not_found');
    const booking = presentBooking(result.booking, result.now);
    if (result.changed) await notifyBookingEvent('cancellation', actor, booking, result.booking.customerName);
    return { booking };
  }

  async function rescheduleBooking({ actor, bookingId, request, idempotencyKey }) {
    const requestHash = createHash('sha256').update(JSON.stringify({ bookingId, ...request })).digest();
    const result = await adapter.rescheduleBooking({ bookingId, userId: String(actor.id), request,
      idempotencyKey, requestHash,
      decide({ booking, now, exceptionApproved }) {
        if (booking.status !== BOOKING_STATUS.CONFIRMED || booking.noShowAt
          || compareInstants(now, booking.endAt) >= 0) {
          throw bookingError('invalid_booking_state');
        }
        const cutoff = Temporal.Instant.from(booking.startAt)
          .subtract({ minutes: booking.cancellationMinMinutes ?? 120 }).toString();
        if (compareInstants(now, cutoff) > 0 && !exceptionApproved) {
          throw bookingError('booking_cancellation_window_closed');
        }
        if (!exceptionApproved && (booking.voluntaryRescheduleCount ?? 0) >= 1) {
          throw bookingError('voluntary_reschedule_limit_reached');
        }
        return compareInstants(now, cutoff) > 0;
      },
      evaluate({ context, now, durationMinutes }) {
        let decision;
        try {
          decision = createBookingDomain({ clock: { now: () => now } }).validateOption(context,
            { startTime: request.startTime, durationMinutes });
        } catch (error) {
          if (error?.code === 'INVALID_LOCAL_TIME_IN_TIME_ZONE') {
            return { accepted: false, code: 'invalid_booking_option' };
          }
          throw error;
        }
        if (!decision.reservable) return { accepted: false,
          code: decision.reasons.map((reason) => REJECTION_CODES[reason]).find(Boolean) ?? 'internal_error' };
        return { accepted: true, option: decision.option };
      },
    });
    const booking = presentBooking(result.booking, result.now);
    if (!result.replayed) await notifyBookingEvent('reschedule', actor, booking,
      result.booking.customerName, { previous: result.previous });
    return { booking, replayed: result.replayed };
  }

  async function cancelExceptionBooking({ actor, bookingId }) {
    const result = await adapter.cancelExceptionBooking({ userId: String(actor.id), bookingId });
    const booking = presentBooking(result.booking, result.now);
    await notifyBookingEvent('cancellation', actor, booking, result.booking.customerName);
    return { booking };
  }

  async function listBookingChanges({ actor, bookingId }) {
    const items = await adapter.listBookingChanges({ userId: String(actor.id), bookingId });
    if (!items) throw bookingError('resource_not_found');
    return { items };
  }

  async function requestBookingException({ actor, bookingId, category, note }) {
    return { exception: await adapter.requestBookingException({ bookingId, userId: String(actor.id), category, note }) };
  }

  async function listOwnerExceptions({ actor }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    return { items: await adapter.listOwnerExceptions({ ownerUserId: String(actor.id) }) };
  }

  async function decideBookingException({ actor, exceptionId, decision }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    const result = await adapter.decideBookingException({ exceptionId, ownerUserId: String(actor.id), decision });
    await notifyCustomer('exceptionDecision', { email: result.booking.customerEmail },
      presentBooking(result.booking, toInstantString(clock.now())), { decision, category: result.exception.category });
    return { exception: result.exception };
  }

  async function cancelOwnerBooking({ actor, bookingId, reason, reasonCode }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    const result = await adapter.cancelOwnerBooking({ bookingId, ownerUserId: String(actor.id), reason, reasonCode });
    const booking = presentBooking(result.booking, toInstantString(clock.now()));
    await notifyCustomer('customerOwnerCancellation', { email: result.booking.customerEmail }, booking, { reason });
    return { booking };
  }

  async function markNoShow({ actor, bookingId }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    const result = await adapter.markNoShow({ bookingId, ownerUserId: String(actor.id) });
    return { booking: presentBooking(result.booking, toInstantString(clock.now())) };
  }

  async function updateCancellationPolicy({ actor, courtId, cancellationMinMinutes }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    return adapter.updateCancellationPolicy({ courtId, ownerUserId: String(actor.id), minutes: cancellationMinMinutes });
  }

  async function updateDepositPolicy({ actor, courtId, depositPercentage }) {
    assertOperationalActor(actor);
    if (!actor.ownerScope) throw bookingError('forbidden');
    return adapter.updateDepositPolicy({ courtId, ownerUserId: String(actor.id), percentage: depositPercentage });
  }

  async function notifyBookingEvent(kind, actor, booking, customerName, details = {}) {
    await notifyCustomer(kind, actor, booking, details);
    await notifyOwners(kind, booking, customerName ?? actor?.name, details);
  }

  async function notifyCustomer(kind, actor, booking, details = {}) {
    if (!notifications?.[kind]) return;
    try {
      if (!actor?.email) throw new Error('Recipient unavailable');
      await notifications[kind]({ email: actor.email, booking, ...details });
    } catch {
      logger.error?.(`Booking ${kind} email delivery failed`);
    }
  }

  async function notifyOwners(kind, booking, customerName, details = {}) {
    const notification = kind === 'confirmation' ? notifications?.ownerConfirmation
      : kind === 'reschedule' ? notifications?.ownerReschedule : notifications?.ownerCancellation;
    if (!notification || typeof adapter.listOperationalOwnerRecipients !== 'function') return;
    let recipients;
    try {
      recipients = await adapter.listOperationalOwnerRecipients({ facilityId: booking.facility.id });
    } catch {
      logger.error?.('Owner booking recipient lookup failed');
      return;
    }
    const emails = new Set();
    for (const recipient of recipients) {
      const email = recipient?.email?.trim().toLowerCase();
      if (!email || emails.has(email)) continue;
      emails.add(email);
      try {
        await notification({ email: recipient.email, customerName: customerName ?? 'Cliente', booking, ...details });
      } catch {
        logger.error?.('owner_booking_email_failed');
      }
    }
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
    cancellationMinMinutes: booking.cancellationMinMinutes ?? 120,
    cancellationReason: booking.cancellationReason ?? null,
    economicOutcome: booking.economicOutcome ?? null,
    noShowAt: booking.noShowAt ?? null,
    paymentStatus: booking.paymentStatus ?? null,
    depositPercentage: booking.depositPercentage ?? null,
    depositAmountMinor: booking.depositAmountMinor ?? null,
    amountPaidMinor: booking.amountPaidMinor ?? null,
    paymentExpiresAt: booking.paymentExpiresAt ?? null,
    voluntaryRescheduleCount: booking.voluntaryRescheduleCount ?? null,
    exceptionApproved: booking.exceptionApproved ?? false,
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
