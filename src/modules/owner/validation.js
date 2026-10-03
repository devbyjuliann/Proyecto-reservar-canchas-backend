import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

import { appError } from '../../shared/errors.js';
import { toInstantString } from '../../shared/time.js';

const id = z.string().refine((value) => /^[1-9]\d*$/.test(value)
  && BigInt(value) <= 18_446_744_073_709_551_615n);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/)
  .refine((value) => {
    try { return Temporal.Instant.from(value).toString() !== ''; } catch { return false; }
  });
const query = z.object({
  facilityId: id.optional(),
  courtId: id.optional(),
  status: z.enum(['PENDIENTE_PAGO', 'CONFIRMADA', 'CANCELADA', 'COMPLETADA']).optional(),
  startFrom: instant.optional(),
  startBefore: instant.optional(),
  limit: z.string().regex(/^[1-9]\d*$/).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export function validateOwnerBookingsQuery(input) {
  const parsed = query.safeParse(input);
  if (!parsed.success) throw invalidRequest(parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || 'request', message: issue.message,
  })));
  const value = parsed.data;
  const limit = value.limit === undefined ? 25 : Number(value.limit);
  if (limit > 100) throw invalidRequest([{ field: 'limit', message: 'Must be between 1 and 100' }]);
  const startFrom = value.startFrom && toInstantString(value.startFrom);
  const startBefore = value.startBefore && toInstantString(value.startBefore);
  if (startFrom && startBefore && Temporal.Instant.compare(startFrom, startBefore) >= 0) {
    throw invalidRequest([{ field: 'startBefore', message: 'Must be after startFrom' }]);
  }
  return { ...value, startFrom, startBefore, limit };
}

function invalidRequest(details) {
  return appError('invalid_request', 'The request is invalid', { details });
}
