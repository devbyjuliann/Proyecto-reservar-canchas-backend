import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOKING_STATUS,
  createBookingDomain,
  effectiveBookingStatus,
} from '../../../src/modules/booking/domain/index.js';

const MONDAY = '2026-09-28';

function context(overrides = {}) {
  return {
    date: MONDAY,
    timeZone: 'America/Bogota',
    weeklyPeriods: [
      { weekday: 1, startTime: '09:00', endTime: '13:00' },
    ],
    exception: null,
    allowedDurationsMinutes: [30],
    startIntervalMinutes: 30,
    minimumSeparationMinutes: 0,
    bookingWindow: {
      minimumAdvanceMinutes: 15,
      maximumAdvanceMinutes: 43_200,
    },
    bookings: [],
    unavailabilities: [],
    ...overrides,
  };
}

function domain(now = '2026-09-28T13:00:00Z') {
  return createBookingDomain({ clock: { now: () => now } });
}

function starts(options) {
  return options.map(({ startTime, durationMinutes }) => `${startTime}/${durationMinutes}`);
}

describe('booking domain', () => {
  it('generates each duration on a grid anchored independently to each period', () => {
    const options = domain().generateAvailability(context({
      weeklyPeriods: [
        { weekday: 1, startTime: '09:10', endTime: '10:40' },
        { weekday: 1, startTime: '14:20', endTime: '15:20' },
      ],
      allowedDurationsMinutes: [60, 30],
    }));

    assert.deepEqual(starts(options), [
      '09:10:00/30',
      '09:10:00/60',
      '09:40:00/30',
      '09:40:00/60',
      '10:10:00/30',
      '14:20:00/30',
      '14:20:00/60',
      '14:50:00/30',
    ]);
  });

  it('rejects overlapping periods but permits adjacent semi-open periods', () => {
    const overlapping = context({
      weeklyPeriods: [
        { weekday: 1, startTime: '09:00', endTime: '11:00' },
        { weekday: 1, startTime: '10:59', endTime: '12:00' },
      ],
    });
    assert.throws(
      () => domain().generateAvailability(overlapping),
      (error) => error.code === 'OVERLAPPING_OPERATING_PERIODS',
    );

    const adjacent = context({
      weeklyPeriods: [
        { weekday: 1, startTime: '09:00', endTime: '10:00' },
        { weekday: 1, startTime: '10:00', endTime: '11:00' },
      ],
    });
    assert.equal(domain().generateAvailability(adjacent).length, 4);
  });

  it('uses a custom exception as a complete replacement for the weekly schedule', () => {
    const options = domain().generateAvailability(context({
      exception: {
        localDate: MONDAY,
        mode: 'CUSTOM_PERIODS',
        periods: [{ startTime: '16:00', endTime: '17:00' }],
      },
    }));

    assert.deepEqual(starts(options), ['16:00:00/30', '16:30:00/30']);
  });

  it('returns no options when the replacing exception closes the day', () => {
    const options = domain().generateAvailability(context({
      exception: { localDate: MONDAY, mode: 'CLOSED', periods: [] },
    }));
    assert.deepEqual(options, []);
  });

  it('uses semi-open overlap rules for unavailability intervals', () => {
    const input = context({
      weeklyPeriods: [{ weekday: 1, startTime: '09:00', endTime: '11:00' }],
      unavailabilities: [{
        startAt: '2026-09-28T15:00:00Z',
        endAt: '2026-09-28T15:30:00Z',
      }],
    });

    assert.deepEqual(starts(domain().generateAvailability(input)), [
      '09:00:00/30',
      '09:30:00/30',
      '10:30:00/30',
    ]);
  });

  it('applies minimum separation to confirmed bookings and ignores cancelled ones', () => {
    const input = context({
      weeklyPeriods: [{ weekday: 1, startTime: '09:00', endTime: '13:00' }],
      minimumSeparationMinutes: 15,
      bookings: [
        {
          status: BOOKING_STATUS.CONFIRMED,
          startAt: '2026-09-28T15:00:00Z',
          endAt: '2026-09-28T16:00:00Z',
        },
        {
          status: BOOKING_STATUS.CANCELLED,
          startAt: '2026-09-28T17:00:00Z',
          endAt: '2026-09-28T17:30:00Z',
        },
      ],
    });

    assert.deepEqual(starts(domain().generateAvailability(input)), [
      '09:00:00/30',
      '11:30:00/30',
      '12:00:00/30',
      '12:30:00/30',
    ]);
  });

  it('allows an option exactly at the minimum-separation boundary', () => {
    const input = context({
      weeklyPeriods: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }],
      minimumSeparationMinutes: 15,
      bookings: [{
        status: BOOKING_STATUS.CONFIRMED,
        startAt: '2026-09-28T15:15:00Z',
        endAt: '2026-09-28T15:45:00Z',
      }],
    });

    assert.equal(domain().validateOption(input, {
      startTime: '09:30',
      durationMinutes: 30,
    }).reservable, true);
  });

  it('includes both exact limits of the booking window', () => {
    const input = context({
      weeklyPeriods: [{ weekday: 1, startTime: '12:00', endTime: '13:00' }],
    });

    assert.equal(
      domain('2026-09-28T16:45:00Z').validateOption(input, {
        startTime: '12:00', durationMinutes: 30,
      }).reservable,
      true,
    );
    assert.equal(
      domain('2026-08-29T17:00:00Z').validateOption(input, {
        startTime: '12:00', durationMinutes: 30,
      }).reservable,
      true,
    );
    assert.deepEqual(
      domain('2026-09-28T16:45:00.000000001Z').validateOption(input, {
        startTime: '12:00', durationMinutes: 30,
      }).reasons,
      ['OUTSIDE_BOOKING_WINDOW'],
    );
    assert.deepEqual(
      domain('2026-08-29T16:59:59.999999999Z').validateOption(input, {
        startTime: '12:00', durationMinutes: 30,
      }).reasons,
      ['OUTSIDE_BOOKING_WINDOW'],
    );
  });

  it('validates one confirmation option with the same rules used by generation', () => {
    const input = context({
      allowedDurationsMinutes: [30, 60],
      unavailabilities: [{
        startAt: '2026-09-28T15:30:00Z',
        endAt: '2026-09-28T16:00:00Z',
      }],
    });
    const bookingDomain = domain();
    const generated = bookingDomain.generateAvailability(input);

    assert.equal(
      bookingDomain.validateOption(input, { startTime: '09:00', durationMinutes: 30 }).reservable,
      generated.some((option) => option.startTime === '09:00:00' && option.durationMinutes === 30),
    );
    assert.deepEqual(
      bookingDomain.validateOption(input, { startTime: '10:00', durationMinutes: 60 }).reasons,
      ['UNAVAILABLE'],
    );
    assert.deepEqual(
      bookingDomain.validateOption(input, { startTime: '09:15', durationMinutes: 45 }).reasons,
      ['DURATION_NOT_ALLOWED', 'START_NOT_ON_GRID'],
    );
  });

  it('assesses an existing booking without conflicting with its own ID', () => {
    const booking = {
      id: 42,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T14:00:00Z',
      endAt: '2026-09-28T14:30:00Z',
    };

    assert.deepEqual(domain().assessExistingBooking(context({ bookings: [booking] }), booking), {
      applicable: true,
      compatible: true,
      reasons: [],
    });
  });

  it('preserves other confirmed neighbors and minimum separation during assessment', () => {
    const booking = {
      id: 42,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T14:00:00Z',
      endAt: '2026-09-28T14:30:00Z',
    };
    const neighbor = {
      id: 43,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T14:40:00Z',
      endAt: '2026-09-28T15:10:00Z',
    };

    assert.deepEqual(domain().assessExistingBooking(context({
      minimumSeparationMinutes: 15,
      bookings: [booking, neighbor],
    }), booking), {
      applicable: true,
      compatible: false,
      reasons: ['BOOKING_CONFLICT'],
    });
  });

  it('does not apply the advance booking window to an existing booking', () => {
    const booking = {
      id: 42,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T17:00:00Z',
      endAt: '2026-09-28T17:30:00Z',
    };

    assert.deepEqual(
      domain('2026-09-28T17:10:00Z').assessExistingBooking(context({ bookings: [booking] }), booking),
      { applicable: true, compatible: true, reasons: [] },
    );
  });

  it('reports why a preexisting booking is incompatible with current rules', () => {
    const booking = {
      id: 42,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T14:00:00Z',
      endAt: '2026-09-28T15:00:00Z',
    };

    assert.deepEqual(domain().assessExistingBooking(context({ bookings: [booking] }), booking), {
      applicable: true,
      compatible: false,
      reasons: ['DURATION_NOT_ALLOWED'],
    });
  });

  it('does not assess a confirmed booking that is effectively completed', () => {
    const booking = {
      id: 42,
      status: BOOKING_STATUS.CONFIRMED,
      startAt: '2026-09-28T14:00:00Z',
      endAt: '2026-09-28T14:30:00Z',
    };

    assert.deepEqual(
      domain('2026-09-28T14:30:00Z').assessExistingBooking(context(), booking),
      { applicable: false, compatible: false, reasons: [] },
    );
  });

  it('derives CONFIRMADA, CANCELADA, and COMPLETADA at the exact end instant', () => {
    const booking = { status: BOOKING_STATUS.CONFIRMED, endAt: '2026-09-28T15:00:00Z' };
    assert.equal(
      effectiveBookingStatus(booking, '2026-09-28T14:59:59.999999999Z'),
      BOOKING_STATUS.CONFIRMED,
    );
    assert.equal(
      effectiveBookingStatus(booking, '2026-09-28T15:00:00Z'),
      BOOKING_STATUS.COMPLETED,
    );
    assert.equal(
      effectiveBookingStatus(
        { ...booking, status: BOOKING_STATUS.CANCELLED },
        '2026-09-29T15:00:00Z',
      ),
      BOOKING_STATUS.CANCELLED,
    );
  });

  it('rejects nonexistent and ambiguous IANA local times', () => {
    const nonexistent = context({
      date: '2026-03-08',
      timeZone: 'America/New_York',
      weeklyPeriods: [{ weekday: 7, startTime: '00:00', endTime: '04:00' }],
      bookingWindow: { minimumAdvanceMinutes: 0, maximumAdvanceMinutes: 525_600 },
    });
    assert.throws(
      () => domain('2026-01-01T00:00:00Z').validateOption(nonexistent, {
        startTime: '02:30', durationMinutes: 30,
      }),
      (error) => error.code === 'INVALID_LOCAL_TIME_IN_TIME_ZONE',
    );

    const ambiguous = context({
      date: '2026-11-01',
      timeZone: 'America/New_York',
      weeklyPeriods: [{ weekday: 7, startTime: '00:00', endTime: '03:00' }],
      bookingWindow: { minimumAdvanceMinutes: 0, maximumAdvanceMinutes: 525_600 },
    });
    assert.throws(
      () => domain('2026-09-01T00:00:00Z').validateOption(ambiguous, {
        startTime: '01:30', durationMinutes: 30,
      }),
      (error) => error.code === 'INVALID_LOCAL_TIME_IN_TIME_ZONE',
    );
  });

  it('omits DST-invalid generated candidates while retaining valid options', () => {
    const springForward = context({
      date: '2026-03-08',
      timeZone: 'America/New_York',
      weeklyPeriods: [{ weekday: 7, startTime: '00:00', endTime: '04:00' }],
      bookingWindow: { minimumAdvanceMinutes: 0, maximumAdvanceMinutes: 525_600 },
    });
    const springStarts = starts(
      domain('2026-01-01T00:00:00Z').generateAvailability(springForward),
    );
    assert.equal(springStarts.some((value) => value.startsWith('02:')), false);
    assert.equal(springStarts.includes('03:00:00/30'), true);

    const fallBack = context({
      date: '2026-11-01',
      timeZone: 'America/New_York',
      weeklyPeriods: [{ weekday: 7, startTime: '00:00', endTime: '03:00' }],
      bookingWindow: { minimumAdvanceMinutes: 0, maximumAdvanceMinutes: 525_600 },
    });
    const fallStarts = starts(
      domain('2026-09-01T00:00:00Z').generateAvailability(fallBack),
    );
    assert.equal(fallStarts.some((value) => value.startsWith('01:')), false);
    assert.equal(fallStarts.includes('02:00:00/30'), true);
  });

  it('rejects operating periods and existing bookings that cross local midnight', () => {
    assert.throws(
      () => domain().generateAvailability(context({
        weeklyPeriods: [{ weekday: 1, startTime: '23:00', endTime: '01:00' }],
      })),
      (error) => error.code === 'PERIOD_CROSSES_MIDNIGHT',
    );
    assert.throws(
      () => domain().generateAvailability(context({
        bookings: [{
          status: BOOKING_STATUS.CONFIRMED,
          startAt: '2026-09-29T04:30:00Z',
          endAt: '2026-09-29T05:30:00Z',
        }],
      })),
      (error) => error.code === 'BOOKING_CROSSES_MIDNIGHT',
    );
  });
});
