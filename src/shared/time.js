import { Temporal } from '@js-temporal/polyfill';

export function toInstantString(value) {
  let input = value;
  if (value instanceof Date) input = value.toISOString();
  if (typeof input === 'string' && !/[zZ]|[+-]\d\d:\d\d$/.test(input)) {
    input = `${input.replace(' ', 'T')}Z`;
  }
  return Temporal.Instant.from(input).toString({
    fractionalSecondDigits: 6,
    roundingMode: 'trunc',
  });
}

export function toMySqlDateTime(value) {
  return toInstantString(value).replace('T', ' ').replace(/Z$/, '');
}

export function compareInstants(left, right) {
  return Temporal.Instant.compare(
    Temporal.Instant.from(toInstantString(left)),
    Temporal.Instant.from(toInstantString(right)),
  );
}

export function localDayBounds(localDate, timeZone, paddingMinutes = 0) {
  const date = Temporal.PlainDate.from(localDate);
  const start = date
    .toZonedDateTime(timeZone)
    .toInstant()
    .subtract({ minutes: paddingMinutes });
  const end = date
    .add({ days: 1 })
    .toZonedDateTime(timeZone)
    .toInstant()
    .add({ minutes: paddingMinutes });
  return {
    startAt: toMySqlDateTime(start.toString()),
    endAt: toMySqlDateTime(end.toString()),
  };
}
