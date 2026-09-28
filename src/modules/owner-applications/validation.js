import { z } from 'zod';

import { appError } from '../../shared/errors.js';

const MAX_ID = 18_446_744_073_709_551_615n;
const id = z.string().refine(
  (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_ID,
  'Must be a canonical positive ID',
);
const page = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw appError('invalid_request', 'The request is invalid', {
    details: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request', message: issue.message,
    })),
  });
}

function pagination(query, admin = false) {
  const parsed = parse(admin ? page.extend({
    status: z.enum(['PENDIENTE', 'APROBADA', 'RECHAZADA', 'all']).optional(),
  }).strict() : page, query);
  const limit = parsed.limit === undefined ? 25 : Number(parsed.limit);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw appError('invalid_request', 'The request is invalid');
  }
  return {
    limit,
    cursor: parsed.cursor,
    ...(admin ? { status: parsed.status ?? 'PENDIENTE' } : {}),
  };
}

export const validateApplication = (body) => parse(z.object({
  businessName: z.string().trim().min(1).max(150),
  message: z.string().max(1000).nullable().optional(),
}).strict(), body);

export const validateRejection = (body) => parse(z.object({
  reason: z.string().trim().min(1).max(500),
}).strict(), body);

export const validateId = (value) => parse(id, value);
export const validateOwnPage = (query) => pagination(query);
export const validateAdminPage = (query) => pagination(query, true);
export const validateEmptyQuery = (query) => parse(z.object({}).strict(), query);

export function rejectBody(request) {
  if (Number(request.headers['content-length'] ?? 0) > 0
    || request.headers['transfer-encoding'] !== undefined) {
    throw appError('invalid_request', 'The request is invalid');
  }
}
