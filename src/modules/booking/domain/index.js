import { Temporal } from '@js-temporal/polyfill';

export const BOOKING_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDIENTE_PAGO',
  CONFIRMED: 'CONFIRMADA',
  CANCELLED: 'CANCELADA',
  COMPLETED: 'COMPLETADA',
});

const REJECTION = Object.freeze({
  DURATION_NOT_ALLOWED: 'DURATION_NOT_ALLOWED',
  START_NOT_ON_GRID: 'START_NOT_ON_GRID',
  OUTSIDE_OPERATING_HOURS: 'OUTSIDE_OPERATING_HOURS',
  UNAVAILABLE: 'UNAVAILABLE',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  OUTSIDE_BOOKING_WINDOW: 'OUTSIDE_BOOKING_WINDOW',
  INTERVAL_NOT_RECONSTRUCTABLE: 'INTERVAL_NOT_RECONSTRUCTABLE',
});

function fail(code, message) {
  const error = new RangeError(message);
  error.name = 'BookingDomainError';
  error.code = code;
  throw error;
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_CONFIGURATION', `${name} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('INVALID_CONFIGURATION', `${name} must be a positive integer`);
  }
  return value;
}

function parseDate(value, name = 'date') {
  try {
    const date = Temporal.PlainDate.from(value);
    if (date.toString() !== value) throw new RangeError();
    return date;
  } catch {
    fail('INVALID_LOCAL_DATE', `${name} must be an ISO local date`);
  }
}

function parseTime(value, name) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    fail('INVALID_LOCAL_TIME', `${name} must be a local time with second precision at most`);
  }

  try {
    return Temporal.PlainTime.from(value);
  } catch {
    fail('INVALID_LOCAL_TIME', `${name} is not a valid local time`);
  }
}

function parseInstant(value, name) {
  try {
    return Temporal.Instant.from(value);
  } catch {
    fail('INVALID_INSTANT', `${name} must identify an instant with an offset or Z`);
  }
}

function toInstant(localDateTime, timeZone, name) {
  try {
    return localDateTime
      .toZonedDateTime(timeZone, { disambiguation: 'reject' })
      .toInstant();
  } catch {
    fail(
      'INVALID_LOCAL_TIME_IN_TIME_ZONE',
      `${name} is ambiguous, nonexistent, or invalid in ${timeZone}`,
    );
  }
}

function normalizePeriods(periods, date, timeZone, name) {
  if (!Array.isArray(periods)) {
    fail('INVALID_CONFIGURATION', `${name} must be an array`);
  }

  const normalized = periods.map((period, index) => {
    const startTime = parseTime(period?.startTime, `${name}[${index}].startTime`);
    const endTime = parseTime(period?.endTime, `${name}[${index}].endTime`);
    const start = date.toPlainDateTime(startTime);
    const end = date.toPlainDateTime(endTime);

    if (Temporal.PlainDateTime.compare(start, end) >= 0) {
      fail('PERIOD_CROSSES_MIDNIGHT', `${name}[${index}] must end after it starts on the same date`);
    }

    // Boundaries are domain times too; invalid DST times make the schedule invalid.
    toInstant(start, timeZone, `${name}[${index}].startTime`);
    toInstant(end, timeZone, `${name}[${index}].endTime`);
    return { start, end };
  }).sort((left, right) => Temporal.PlainDateTime.compare(left.start, right.start));

  for (let index = 1; index < normalized.length; index += 1) {
    if (Temporal.PlainDateTime.compare(normalized[index].start, normalized[index - 1].end) < 0) {
      fail('OVERLAPPING_OPERATING_PERIODS', `${name} contains overlapping periods`);
    }
  }

  return normalized;
}

function effectivePeriods(context, date, timeZone) {
  const weeklyPeriods = context.weeklyPeriods ?? [];
  if (!Array.isArray(weeklyPeriods)) {
    fail('INVALID_CONFIGURATION', 'weeklyPeriods must be an array');
  }

  for (const [index, period] of weeklyPeriods.entries()) {
    if (!Number.isInteger(period?.weekday) || period.weekday < 1 || period.weekday > 7) {
      fail('INVALID_CONFIGURATION', `weeklyPeriods[${index}].weekday must be between 1 and 7`);
    }
  }

  if (context.exception != null) {
    const exceptionDate = parseDate(context.exception.localDate, 'exception.localDate');
    if (!exceptionDate.equals(date)) {
      fail('INVALID_CONFIGURATION', 'exception.localDate must match the evaluated date');
    }
    if (context.exception.mode === 'CLOSED') {
      if ((context.exception.periods?.length ?? 0) !== 0) {
        fail('INVALID_CONFIGURATION', 'a CLOSED exception cannot contain periods');
      }
      return [];
    }
    if (context.exception.mode !== 'CUSTOM_PERIODS' || !context.exception.periods?.length) {
      fail('INVALID_CONFIGURATION', 'a CUSTOM_PERIODS exception must contain at least one period');
    }
    return normalizePeriods(context.exception.periods, date, timeZone, 'exception.periods');
  }

  const periods = weeklyPeriods
    .filter((period) => period.weekday === date.dayOfWeek)
    .map(({ startTime, endTime }) => ({ startTime, endTime }));
  return normalizePeriods(periods, date, timeZone, 'weeklyPeriods');
}

function intervalsOverlap(left, right) {
  return Temporal.Instant.compare(left.start, right.end) < 0
    && Temporal.Instant.compare(right.start, left.end) < 0;
}

function normalizeInstantIntervals(values, name) {
  if (!Array.isArray(values)) fail('INVALID_CONFIGURATION', `${name} must be an array`);
  return values.map((value, index) => {
    const start = parseInstant(value?.startAt, `${name}[${index}].startAt`);
    const end = parseInstant(value?.endAt, `${name}[${index}].endAt`);
    if (Temporal.Instant.compare(start, end) >= 0) {
      fail('INVALID_INTERVAL', `${name}[${index}] must end after it starts`);
    }
    return { ...value, start, end };
  });
}

function bookingCrossesLocalMidnight(booking, timeZone) {
  const startDate = booking.start.toZonedDateTimeISO(timeZone).toPlainDate();
  const lastIncludedDate = booking.end
    .subtract({ nanoseconds: 1 })
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  return !startDate.equals(lastIncludedDate);
}

export function effectiveBookingStatus(booking, now) {
  if (booking?.status === BOOKING_STATUS.PENDING_PAYMENT) return BOOKING_STATUS.PENDING_PAYMENT;
  if (booking?.status === BOOKING_STATUS.CANCELLED) return BOOKING_STATUS.CANCELLED;
  if (booking?.status === BOOKING_STATUS.COMPLETED) return BOOKING_STATUS.COMPLETED;
  if (booking?.status !== BOOKING_STATUS.CONFIRMED) {
    fail('INVALID_BOOKING_STATUS', `unknown booking status: ${booking?.status}`);
  }

  const end = parseInstant(booking.endAt, 'booking.endAt');
  const current = parseInstant(now, 'now');
  return Temporal.Instant.compare(current, end) >= 0
    ? BOOKING_STATUS.COMPLETED
    : BOOKING_STATUS.CONFIRMED;
}

function normalizeContext(input, now) {
  if (input == null || typeof input !== 'object') {
    fail('INVALID_CONFIGURATION', 'booking context is required');
  }

  const date = parseDate(input.date);
  const timeZone = input.timeZone;
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    fail('INVALID_TIME_ZONE', 'timeZone must be an IANA time-zone identifier');
  }

  // This validates the identifier independently of any supplied operating period.
  toInstant(date.toPlainDateTime('12:00'), timeZone, 'date');

  if (!Array.isArray(input.allowedDurationsMinutes) || input.allowedDurationsMinutes.length === 0) {
    fail('INVALID_CONFIGURATION', 'allowedDurationsMinutes must contain at least one duration');
  }
  const durations = [...new Set(input.allowedDurationsMinutes.map((duration, index) =>
    requirePositiveInteger(duration, `allowedDurationsMinutes[${index}]`)))].sort((a, b) => a - b);
  const startIntervalMinutes = requirePositiveInteger(input.startIntervalMinutes, 'startIntervalMinutes');
  const separationMinutes = requireNonNegativeInteger(
    input.minimumSeparationMinutes,
    'minimumSeparationMinutes',
  );
  const minimumAdvanceMinutes = requireNonNegativeInteger(
    input.bookingWindow?.minimumAdvanceMinutes,
    'bookingWindow.minimumAdvanceMinutes',
  );
  const maximumAdvanceMinutes = requireNonNegativeInteger(
    input.bookingWindow?.maximumAdvanceMinutes,
    'bookingWindow.maximumAdvanceMinutes',
  );
  if (minimumAdvanceMinutes > maximumAdvanceMinutes) {
    fail('INVALID_CONFIGURATION', 'minimum advance cannot exceed maximum advance');
  }

  const periods = effectivePeriods(input, date, timeZone);
  const bookings = normalizeInstantIntervals(input.bookings ?? [], 'bookings');
  for (const booking of bookings) {
    if (!Object.values(BOOKING_STATUS).includes(booking.status)) {
      fail('INVALID_BOOKING_STATUS', `unknown booking status: ${booking.status}`);
    }
    if (bookingCrossesLocalMidnight(booking, timeZone)) {
      fail('BOOKING_CROSSES_MIDNIGHT', 'an existing booking crosses local midnight');
    }
  }

  return {
    date,
    timeZone,
    durations,
    startIntervalMinutes,
    separationMinutes,
    minimumAdvanceMinutes,
    maximumAdvanceMinutes,
    periods,
    // The adapter has already removed expired holds with database time. A live checkout
    // hold occupies the court exactly like a confirmed booking.
    bookings: bookings.filter((booking) =>
      [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.PENDING_PAYMENT].includes(booking.status)),
    unavailabilities: normalizeInstantIntervals(input.unavailabilities ?? [], 'unavailabilities'),
    now,
  };
}

function candidatePeriod(candidate, durationMinutes, periods) {
  const end = candidate.add({ minutes: durationMinutes });
  return periods.find((period) =>
    Temporal.PlainDateTime.compare(candidate, period.start) >= 0
    && Temporal.PlainDateTime.compare(end, period.end) <= 0);
}

function isOnGrid(candidate, periods, intervalMinutes) {
  return periods.some((period) => {
    if (Temporal.PlainDateTime.compare(candidate, period.start) < 0
      || Temporal.PlainDateTime.compare(candidate, period.end) >= 0) return false;
    const elapsedMinutes = period.start.until(candidate).total({ unit: 'minutes' });
    return Number.isInteger(elapsedMinutes) && elapsedMinutes % intervalMinutes === 0;
  });
}

function evaluateOption(context, startTimeValue, durationMinutes, {
  checkBookingWindow = true,
  expectedInterval,
} = {}) {
  const startTime = parseTime(startTimeValue, 'option.startTime');
  const localStart = context.date.toPlainDateTime(startTime);
  const reasons = [];

  if (!context.durations.includes(durationMinutes)) reasons.push(REJECTION.DURATION_NOT_ALLOWED);
  if (!isOnGrid(localStart, context.periods, context.startIntervalMinutes)) {
    reasons.push(REJECTION.START_NOT_ON_GRID);
  }

  const validDuration = Number.isSafeInteger(durationMinutes) && durationMinutes > 0;
  const period = validDuration ? candidatePeriod(localStart, durationMinutes, context.periods) : undefined;
  if (!period) reasons.push(REJECTION.OUTSIDE_OPERATING_HOURS);

  const start = toInstant(localStart, context.timeZone, 'option.startTime');
  let end;
  if (validDuration) {
    const localEnd = localStart.add({ minutes: durationMinutes });
    if (!localEnd.toPlainDate().equals(context.date)) {
      if (!reasons.includes(REJECTION.OUTSIDE_OPERATING_HOURS)) {
        reasons.push(REJECTION.OUTSIDE_OPERATING_HOURS);
      }
    } else {
      end = toInstant(localEnd, context.timeZone, 'option.endTime');
    }
  }

  if (end) {
    const interval = { start, end };
    if (context.unavailabilities.some((unavailability) => intervalsOverlap(interval, unavailability))) {
      reasons.push(REJECTION.UNAVAILABLE);
    }

    const separation = { minutes: context.separationMinutes };
    const conflicts = context.bookings.some((booking) =>
      Temporal.Instant.compare(end.add(separation), booking.start) > 0
      && Temporal.Instant.compare(booking.end.add(separation), start) > 0);
    if (conflicts) reasons.push(REJECTION.BOOKING_CONFLICT);

    if (checkBookingWindow) {
      const earliestNow = start.subtract({ minutes: context.maximumAdvanceMinutes });
      const latestNow = start.subtract({ minutes: context.minimumAdvanceMinutes });
      if (Temporal.Instant.compare(context.now, earliestNow) < 0
        || Temporal.Instant.compare(context.now, latestNow) > 0) {
        reasons.push(REJECTION.OUTSIDE_BOOKING_WINDOW);
      }
    }

    if (expectedInterval
      && (Temporal.Instant.compare(start, expectedInterval.start) !== 0
        || Temporal.Instant.compare(end, expectedInterval.end) !== 0)) {
      reasons.push(REJECTION.INTERVAL_NOT_RECONSTRUCTABLE);
    }
  }

  const option = end ? {
    localDate: context.date.toString(),
    startTime: startTime.toString(),
    durationMinutes,
    startAt: start.toString(),
    endAt: end.toString(),
  } : undefined;

  return reasons.length === 0
    ? { reservable: true, option }
    : { reservable: false, reasons: [...new Set(reasons)] };
}

export function createBookingDomain({ clock } = {}) {
  if (typeof clock?.now !== 'function') {
    fail('INVALID_CLOCK', 'clock.now must be a function');
  }

  function withContext(input, operation) {
    const now = parseInstant(clock.now(), 'clock.now()');
    return operation(normalizeContext(input, now));
  }

  return Object.freeze({
    generateAvailability(input) {
      return withContext(input, (context) => {
        const options = [];
        for (const period of context.periods) {
          for (
            let candidate = period.start;
            Temporal.PlainDateTime.compare(candidate, period.end) < 0;
            candidate = candidate.add({ minutes: context.startIntervalMinutes })
          ) {
            for (const duration of context.durations) {
              try {
                const result = evaluateOption(context, candidate.toPlainTime().toString(), duration);
                if (result.reservable) options.push(result.option);
              } catch (error) {
                if (error?.code !== 'INVALID_LOCAL_TIME_IN_TIME_ZONE') throw error;
                if (String(error.message).startsWith('option.startTime')) break;
                if (!String(error.message).startsWith('option.endTime')) throw error;
              }
            }
          }
        }
        return options;
      });
    },

    validateOption(input, option) {
      return withContext(input, (context) =>
        evaluateOption(context, option?.startTime, option?.durationMinutes));
    },

    assessExistingBooking(input, booking) {
      const now = parseInstant(clock.now(), 'clock.now()');
      if (effectiveBookingStatus(booking, now) !== BOOKING_STATUS.CONFIRMED) {
        return { applicable: false, compatible: false, reasons: [] };
      }

      const [interval] = normalizeInstantIntervals([booking], 'booking');
      const timeZone = booking.timeZone ?? input?.timeZone;
      const localStart = interval.start.toZonedDateTimeISO(timeZone).toPlainDateTime();
      const localEnd = interval.end.toZonedDateTimeISO(timeZone).toPlainDateTime();
      const durationMinutes = localStart.until(localEnd).total({ unit: 'minutes' });
      const bookings = (input?.bookings ?? []).filter((neighbor) =>
        booking.id == null || neighbor?.id !== booking.id);
      const context = normalizeContext({
        ...input,
        date: localStart.toPlainDate().toString(),
        timeZone,
        bookings,
      }, now);
      const result = evaluateOption(
        context,
        localStart.toPlainTime().toString(),
        durationMinutes,
        { checkBookingWindow: false, expectedInterval: interval },
      );

      return {
        applicable: true,
        compatible: result.reservable,
        reasons: result.reasons ?? [],
      };
    },
  });
}
