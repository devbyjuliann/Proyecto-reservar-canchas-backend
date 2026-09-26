import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBookingModule } from '../../../src/modules/booking/booking.js';
import { toInstantString } from '../../../src/shared/time.js';

const NOW = '2026-09-24T14:30:00.000000Z';

function booking(overrides = {}) {
  return {
    id: '901',
    userId: '7',
    court: { id: '12', name: 'Cancha 1' },
    facility: { id: '3', name: 'Centro Deportivo' },
    startAt: '2026-09-28T21:00:00.000000Z',
    endAt: '2026-09-28T22:00:00.000000Z',
    timeZone: 'America/Bogota',
    status: 'CONFIRMADA',
    createdAt: NOW,
    cancelledAt: null,
    ...overrides,
  };
}

function moduleWith(adapter, now = NOW) {
  return createBookingModule({ adapter, clock: { now: () => now } });
}

describe('booking module cancellation', () => {
  it('cancels an owned confirmed booking strictly before its start', async () => {
    let selectedAction;
    const adapter = {
      async cancelBooking({ decide }) {
        selectedAction = decide({ booking: booking(), now: NOW });
        return {
          booking: booking({
            status: 'CANCELADA',
            cancelledAt: NOW,
          }),
          now: NOW,
        };
      },
    };

    const result = await moduleWith(adapter).cancelBooking({
      actor: { id: '7' },
      bookingId: '901',
    });
    assert.equal(selectedAction, 'cancel');
    assert.equal(result.booking.status, 'CANCELADA');
  });

  it('treats a repeated owner cancellation as an unchanged success', async () => {
    let selectedAction;
    const cancelledAt = '2026-09-23T10:00:00.000000Z';
    const adapter = {
      async cancelBooking({ decide }) {
        const cancelled = booking({ status: 'CANCELADA', cancelledAt });
        selectedAction = decide({ booking: cancelled, now: NOW });
        return { booking: cancelled, now: NOW };
      },
    };

    const result = await moduleWith(adapter).cancelBooking({
      actor: { id: '7' },
      bookingId: '901',
    });
    assert.equal(selectedAction, 'unchanged');
    assert.equal(result.booking.cancelledAt, cancelledAt);
  });

  it('rejects cancellation at the exact start and after completion', async () => {
    const adapter = {
      async cancelBooking({ decide }) {
        decide({
          booking: booking({
            startAt: '2026-09-24T14:30:00.000000Z',
            endAt: '2026-09-24T15:30:00.000000Z',
          }),
          now: NOW,
        });
      },
    };
    await assert.rejects(
      moduleWith(adapter).cancelBooking({ actor: { id: '7' }, bookingId: '901' }),
      { code: 'booking_already_started' },
    );

    const completedAdapter = {
      async cancelBooking({ decide }) {
        decide({
          booking: booking({
            startAt: '2026-09-24T12:00:00.000000Z',
            endAt: NOW,
          }),
          now: NOW,
        });
      },
    };
    await assert.rejects(
      moduleWith(completedAdapter).cancelBooking({ actor: { id: '7' }, bookingId: '901' }),
      { code: 'invalid_booking_state' },
    );
  });

  it('rejects cancellation by a different user', async () => {
    const adapter = {
      async cancelBooking({ decide }) {
        decide({ booking: booking(), now: NOW });
      },
    };
    await assert.rejects(
      moduleWith(adapter).cancelBooking({ actor: { id: '8' }, bookingId: '901' }),
      { code: 'forbidden' },
    );
  });
});

describe('booking module orchestration', () => {
  const context = {
    date: '2026-09-28',
    timeZone: 'America/Bogota',
    weeklyPeriods: [{ weekday: 1, startTime: '16:00:00', endTime: '17:00:00' }],
    exception: null,
    allowedDurationsMinutes: [60],
    startIntervalMinutes: 30,
    minimumSeparationMinutes: 0,
    bookingWindow: { minimumAdvanceMinutes: 15, maximumAdvanceMinutes: 43_200 },
    bookings: [],
    unavailabilities: [],
  };

  it('uses the domain evaluator for availability and confirmation', async () => {
    let confirmationDecision;
    const adapter = {
      async readAvailabilityContext() {
        return { court: { id: '12' }, context };
      },
      async confirmBooking({ evaluate }) {
        confirmationDecision = evaluate({ context, now: NOW });
        return {
          kind: 'succeeded',
          booking: booking(),
          now: NOW,
          replayed: false,
        };
      },
    };
    const bookingModule = moduleWith(adapter);
    const availability = await bookingModule.getAvailability({
      courtId: '12',
      date: '2026-09-28',
    });
    const confirmation = await bookingModule.confirmBooking({
      actor: { id: '7' },
      request: {
        courtId: '12',
        localDate: '2026-09-28',
        startTime: '16:00:00',
        durationMinutes: 60,
      },
      idempotencyKey: 'attempt-1',
    });

    assert.equal(availability.options.length, 1);
    assert.equal(confirmationDecision.accepted, true);
    assert.equal(
      toInstantString(confirmationDecision.option.startAt),
      availability.options[0].startAt,
    );
    assert.equal(confirmation.booking.id, '901');
  });

  it('derives effective states and emits an opaque next cursor', async () => {
    let receivedCursor;
    const adapter = {
      async listOwnBookings({ cursor }) {
        receivedCursor = cursor;
        if (cursor) return [];
        return [
          booking({
            id: '902',
            startAt: '2026-09-24T12:00:00.000000Z',
            endAt: '2026-09-24T13:00:00.000000Z',
          }),
          booking({ id: '901' }),
        ];
      },
    };
    const bookingModule = moduleWith(adapter);
    const first = await bookingModule.listOwnBookings({
      actor: { id: '7' },
      limit: 1,
    });
    assert.equal(first.items[0].status, 'COMPLETADA');
    assert.equal(typeof first.page.nextCursor, 'string');

    await bookingModule.listOwnBookings({
      actor: { id: '7' },
      limit: 1,
      cursor: first.page.nextCursor,
    });
    assert.deepEqual(receivedCursor, {
      startAt: '2026-09-24T12:00:00.000000Z',
      id: '902',
    });
  });
});

describe('booking administrative orchestration', () => {
  const admin = { id: '7', roles: ['ADMINISTRADOR'] };

  it('captures the administrative clock once and forwards the same instant to the adapter', async () => {
    let calls = 0;
    let received;
    const bookingModule = createBookingModule({
      clock: { now: () => { calls += 1; return NOW; } },
      adapter: {
        async createCourt(input) {
          received = input;
          return {
            court: {
              id: '12', facility: { id: '3', name: 'Centro Deportivo' }, name: 'Cancha 1',
              description: null, minimumSeparationMinutes: 0, startIntervalMinutes: 30,
              allowedDurationsMinutes: [60], createdAt: NOW, deactivatedAt: null, state: 'active',
            },
            operation: { changed: true, changes: [{ id: '501', courtId: '12', conflictsCreated: 0 }] },
          };
        },
      },
    });

    const result = await bookingModule.createCourt({
      actor: admin,
      facilityId: '3',
      name: 'Cancha 1',
      minimumSeparationMinutes: 0,
      startIntervalMinutes: 30,
      allowedDurationsMinutes: [60],
    });

    assert.equal(calls, 1);
    assert.equal(received.now, NOW);
    assert.equal(received.actorUserId, '7');
    assert.equal(result.operation.changes[0].id, '501');
  });

  it('requires the persisted administrator role for operational mutations', async () => {
    const bookingModule = moduleWith({ async deactivateCourt() {} });
    await assert.rejects(
      bookingModule.deactivateCourt({ actor: { id: '7', roles: [] }, courtId: '12' }),
      { code: 'forbidden' },
    );
  });

  it('uses assessExistingBooking for compatible-to-incompatible transitions only', async () => {
    let assessment;
    const assessmentContext = {
      date: '2026-09-28', timeZone: 'America/Bogota',
      weeklyPeriods: [{ weekday: 1, startTime: '16:00:00', endTime: '17:00:00' }],
      exception: null, allowedDurationsMinutes: [60], startIntervalMinutes: 30,
      minimumSeparationMinutes: 0,
      bookingWindow: { minimumAdvanceMinutes: 15, maximumAdvanceMinutes: 43_200 },
      bookings: [], unavailabilities: [],
    };
    const bookingModule = moduleWith({
      async replaceWeeklySchedule(input) {
        assessment = input.assessExistingBooking({
          context: {
            ...assessmentContext,
            weeklyPeriods: [{ weekday: 1, startTime: '18:00:00', endTime: '19:00:00' }],
          },
          booking: {
            id: '901', status: 'CONFIRMADA', startAt: '2026-09-28T21:00:00.000000Z',
            endAt: '2026-09-28T22:00:00.000000Z', timeZone: 'America/Bogota',
          },
        });
        return { weeklySchedule: { courtId: '12', periods: [] }, operation: { changed: true, changes: [] } };
      },
    });
    await bookingModule.replaceWeeklySchedule({ actor: admin, courtId: '12', periods: [] });
    assert.equal(assessment.compatible, false);
    assert.ok(assessment.reasons.includes('OUTSIDE_OPERATING_HOURS'));
  });

  it('generates and consumes an opaque conflict cursor through the second page', async () => {
    const received = [];
    const conflicts = [
      { id: '703', detectedAt: '2026-09-24T15:03:00.000000Z' },
      { id: '702', detectedAt: '2026-09-24T15:02:00.000000Z' },
      { id: '701', detectedAt: '2026-09-24T15:01:00.000000Z' },
    ];
    const bookingModule = moduleWith({
      async listOperationalConflicts({ cursor, limit }) {
        received.push(cursor);
        return cursor === undefined ? conflicts.slice(0, limit) : conflicts.slice(2);
      },
    });

    const first = await bookingModule.listOperationalConflicts({
      actor: admin,
      courtId: '12',
      limit: 2,
    });
    assert.deepEqual(first.items.map(({ id }) => id), ['703', '702']);
    assert.equal(typeof first.page.nextCursor, 'string');

    const second = await bookingModule.listOperationalConflicts({
      actor: admin,
      courtId: '12',
      limit: 2,
      cursor: first.page.nextCursor,
    });
    assert.deepEqual(received[1], {
      detectedAt: '2026-09-24T15:02:00.000000Z',
      id: '702',
    });
    assert.deepEqual(second.items.map(({ id }) => id), ['701']);
    assert.equal(second.page.nextCursor, null);
    assert.ok(second.items.every(({ id }) => typeof id === 'string'));
  });

  it('maps malformed, truncated, and manipulated administrative cursors to invalid_request', async () => {
    const bookingModule = moduleWith({
      async listOperationalConflicts() {
        return [
          { id: '702', detectedAt: '2026-09-24T15:02:00.000000Z' },
          { id: '701', detectedAt: '2026-09-24T15:01:00.000000Z' },
        ];
      },
    });
    const first = await bookingModule.listOperationalConflicts({ actor: admin, limit: 1 });
    const payload = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString('utf8'));
    payload.filters = { courtId: '99' };
    const manipulated = Buffer.from(JSON.stringify(payload)).toString('base64url');

    for (const cursor of ['not-base64!', first.page.nextCursor.slice(0, -1), manipulated]) {
      await assert.rejects(
        bookingModule.listOperationalConflicts({ actor: admin, limit: 1, cursor }),
        { code: 'invalid_request' },
      );
    }
  });

  it('binds the shared cursor format to its collection and filters', async () => {
    const bookingModule = moduleWith({
      async listDateExceptions() {
        return [
          { courtId: '12', localDate: '2026-09-30', mode: 'CLOSED', periods: [] },
          { courtId: '12', localDate: '2026-09-29', mode: 'CLOSED', periods: [] },
        ];
      },
      async listUnavailabilities() { return []; },
    });
    const first = await bookingModule.listDateExceptions({
      actor: admin,
      courtId: '12',
      limit: 1,
    });
    assert.equal(typeof first.page.nextCursor, 'string');
    await assert.rejects(
      bookingModule.listUnavailabilities({
        actor: admin,
        courtId: '12',
        limit: 1,
        cursor: first.page.nextCursor,
      }),
      { code: 'invalid_request' },
    );
  });
});
