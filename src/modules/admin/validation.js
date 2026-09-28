import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import { appError } from '../../shared/errors.js';

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const MAX_UNSIGNED_INT = 4_294_967_295;
const MAX_UNSIGNED_SMALLINT = 65_535;

const idSchema = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_UNSIGNED_BIGINT,
  'Must be a canonical positive unsigned bigint string',
);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  try {
    return Temporal.PlainDate.from(value).toString() === value;
  } catch {
    return false;
  }
}, 'Must be a valid ISO local date');
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).refine(
  (value) => {
    try {
      return Temporal.PlainTime.from(value).toString({ smallestUnit: 'second' }) === value;
    } catch {
      return false;
    }
  },
  'Must be a valid local time with seconds',
);
const instantSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/)
  .refine((value) => {
    try {
      Temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  }, 'Must be a valid RFC 3339 UTC instant');
const requiredText = (maximum) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum) => z.string().max(maximum).nullable();
const sportCodeSchema = z.string().regex(/^[A-Z0-9_]{2,32}$/);
const unsignedIntSchema = z.number().int().min(0).max(MAX_UNSIGNED_INT);
const unsignedSmallintSchema = z.number().int().min(0).max(MAX_UNSIGNED_SMALLINT);
const positiveSmallintSchema = z.number().int().min(1).max(MAX_UNSIGNED_SMALLINT);
const durationsSchema = z.array(positiveSmallintSchema);
const timeZoneSchema = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'Must be a valid IANA time zone');

const idRequest = (name) => z.object({ [name]: idSchema }).strict();
const pageQuerySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).optional(),
  cursor: z.string().min(1).optional(),
}).strict();
const emptyQuerySchema = z.object({}).strict();
const statePageQuerySchema = pageQuerySchema.extend({
  state: z.enum(['active', 'inactive', 'all']).optional(),
}).strict();

const createFacilitySchema = z.object({
  name: requiredText(150),
  timeZone: timeZoneSchema,
  city: requiredText(120).optional(),
  address: requiredText(250).optional(),
  description: requiredText(1000).optional(),
  minimumAdvanceMinutes: unsignedIntSchema.optional(),
  maximumAdvanceMinutes: unsignedIntSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasMinimum = value.minimumAdvanceMinutes !== undefined;
  const hasMaximum = value.maximumAdvanceMinutes !== undefined;
  if (hasMinimum !== hasMaximum) {
    context.addIssue({ code: 'custom', path: ['minimumAdvanceMinutes'], message: 'Advance limits must be omitted or supplied together' });
  }
  if (hasMinimum && value.minimumAdvanceMinutes > value.maximumAdvanceMinutes) {
    context.addIssue({ code: 'custom', path: ['minimumAdvanceMinutes'], message: 'Must not exceed maximumAdvanceMinutes' });
  }
});
const facilityPatchSchema = z.object({
  name: requiredText(150).optional(),
  city: requiredText(120).optional(),
  address: requiredText(250).optional(),
  description: requiredText(1000).optional(),
}).strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one supported field is required');
const facilityBookingPolicySchema = z.object({
  timeZone: timeZoneSchema,
  minimumAdvanceMinutes: unsignedIntSchema,
  maximumAdvanceMinutes: unsignedIntSchema,
}).strict().refine(
  (value) => value.minimumAdvanceMinutes <= value.maximumAdvanceMinutes,
  { path: ['minimumAdvanceMinutes'], message: 'Must not exceed maximumAdvanceMinutes' },
);

const createCourtSchema = z.object({
  name: requiredText(150),
  description: nullableText(500).optional(),
  sportCode: sportCodeSchema.nullable().optional(),
  minimumSeparationMinutes: unsignedSmallintSchema,
  startIntervalMinutes: positiveSmallintSchema,
  allowedDurationsMinutes: durationsSchema,
}).strict();
const courtPatchSchema = z.object({
  name: requiredText(150).optional(),
  description: nullableText(500).optional(),
  sportCode: sportCodeSchema.nullable().optional(),
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  'At least one supported field is required',
);
const bookingConfigurationSchema = z.object({
  courtId: idSchema,
  minimumSeparationMinutes: unsignedSmallintSchema,
  startIntervalMinutes: positiveSmallintSchema,
  allowedDurationsMinutes: durationsSchema,
}).strict();

const weeklyPeriodSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  startTime: localTimeSchema,
  endTime: localTimeSchema,
}).strict();
const weeklyScheduleSchema = z.object({ periods: z.array(weeklyPeriodSchema) }).strict();
const datePeriodSchema = z.object({
  startTime: localTimeSchema,
  endTime: localTimeSchema,
}).strict();
const dateExceptionSchema = z.object({
  mode: z.enum(['CLOSED', 'CUSTOM_PERIODS']),
  periods: z.array(datePeriodSchema),
}).strict();
const createUnavailabilitySchema = z.object({
  type: z.enum(['BLOQUEO_ADMINISTRATIVO', 'FUERA_DE_SERVICIO']),
  startAt: instantSchema,
  endAt: instantSchema,
  reason: nullableText(500).optional(),
}).strict();
const conflictQuerySchema = pageQuerySchema.extend({
  courtId: idSchema.optional(),
  bookingId: idSchema.optional(),
  operationalChangeId: idSchema.optional(),
}).strict();

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw invalidRequest(result.error.issues);
}

function invalidRequest(issues) {
  return appError('invalid_request', 'The request is invalid', {
    details: issues?.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message,
    })),
  });
}

function page(input, withState = false) {
  const parsed = parse(withState ? statePageQuerySchema : pageQuerySchema, input);
  const limit = parsed.limit === undefined ? 25 : Number(parsed.limit);
  if (limit > 100) {
    throw invalidRequest([{ path: ['limit'], message: 'Must be between 1 and 100' }]);
  }
  return {
    ...(withState ? { state: parsed.state ?? 'active' } : {}),
    limit,
    cursor: parsed.cursor,
  };
}

export function validateIdRequest(name, value) {
  return parse(idRequest(name), { [name]: value });
}

export function validateLocalDateRequest(value) {
  return parse(z.object({ localDate: localDateSchema }).strict(), { localDate: value });
}

export function validateStatePageQuery(input) {
  return page(input, true);
}

export function validatePageQuery(input) {
  return page(input);
}

export function validateEmptyQuery(input) {
  return parse(emptyQuerySchema, input);
}

export function validateConflictQuery(input) {
  const parsed = parse(conflictQuerySchema, input);
  const limit = parsed.limit === undefined ? 25 : Number(parsed.limit);
  if (limit > 100) {
    throw invalidRequest([{ path: ['limit'], message: 'Must be between 1 and 100' }]);
  }
  return { ...parsed, limit };
}

export function validateCreateFacility(input) {
  const parsed = parse(createFacilitySchema, input);
  return {
    ...parsed,
    minimumAdvanceMinutes: parsed.minimumAdvanceMinutes ?? 15,
    maximumAdvanceMinutes: parsed.maximumAdvanceMinutes ?? 43_200,
  };
}

export const validateFacilityPatch = (input) => parse(facilityPatchSchema, input);
export const validateFacilityBookingPolicy = (input) => parse(facilityBookingPolicySchema, input);
export const validateCreateCourt = (input) => parse(createCourtSchema, input);
export const validateCourtPatch = (input) => parse(courtPatchSchema, input);
export const validateBookingConfiguration = (input) => parse(bookingConfigurationSchema, input);
export const validateWeeklySchedule = (input) => parse(weeklyScheduleSchema, input);
export const validateDateException = (input) => parse(dateExceptionSchema, input);
export const validateCreateUnavailability = (input) => parse(createUnavailabilitySchema, input);
