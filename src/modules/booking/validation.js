import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import { bookingError } from './errors.js';

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const idSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_UNSIGNED_BIGINT,
);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
});
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).refine(
  (value) => {
    try {
      return Temporal.PlainTime.from(value).toString({ smallestUnit: 'second' }) === value;
    } catch {
      return false;
    }
  },
);

const availabilitySchema = z.object({
  courtId: idSchema,
  date: localDateSchema,
}).strict();

const confirmationSchema = z.object({
  courtId: idSchema,
  localDate: localDateSchema,
  startTime: localTimeSchema,
  durationMinutes: z.number().int().positive().max(65_535),
  expectedPriceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('COP'),
  useCreditMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const ownBookingsSchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || 'request',
    message: issue.message,
  }));
  throw bookingError('invalid_request', { details });
}

export function validateAvailabilityRequest(input) {
  return parse(availabilitySchema, input);
}

export function validateConfirmationRequest(input) {
  return parse(confirmationSchema, input);
}

export function validateOwnBookingsRequest(input) {
  const parsed = parse(ownBookingsSchema, input);
  const limit = parsed.limit === undefined ? 25 : Number(parsed.limit);
  if (limit < 1 || limit > 100) {
    throw bookingError('invalid_request', {
      details: [{ field: 'limit', message: 'Must be between 1 and 100' }],
    });
  }
  return { limit, cursor: parsed.cursor };
}

export function validateCancellationRequest(input) {
  return parse(z.object({ bookingId: idSchema }).strict(), input);
}

export function validateFacilityCreditRequest(input) {
  return parse(z.object({ facilityId: idSchema }).strict(), input);
}

export function validateRescheduleRequest(input) {
  return parse(z.object({ localDate: localDateSchema, startTime: localTimeSchema,
    expectedPriceMinor: confirmationSchema.shape.expectedPriceMinor, currency: z.literal('COP') }).strict(), input);
}

export function validateExceptionRequest(input) {
  return parse(z.object({ category: z.enum(['MAL_CLIMA', 'FUERZA_MAYOR']),
    note: z.string().trim().min(1).max(500).optional() }).strict(), input);
}

export function validateOwnerCancellation(input) {
  return parse(z.object({ reasonCode: z.enum(['COURT_DAMAGE', 'URGENT_MAINTENANCE',
    'UNEXPECTED_CLOSURE', 'EXTRAORDINARY_UNAVAILABILITY']),
  reason: z.string().trim().min(1).max(500) }).strict(), input);
}

export function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value)) {
    throw bookingError('invalid_request', {
      details: [{ field: 'Idempotency-Key', message: 'Must contain 1 to 128 visible ASCII bytes' }],
    });
  }
  return value;
}
