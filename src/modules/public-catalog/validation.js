import { z } from 'zod';

import { appError } from '../../shared/errors.js';

const id = z.string().refine((value) => /^[1-9]\d*$/.test(value)
  && BigInt(value) <= 18_446_744_073_709_551_615n);
const text = (max) => z.string().trim().min(1).max(max);
const price = z.string().regex(/^[1-9]\d*$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
);
const page = {
  limit: z.string().regex(/^[1-9]\d*$/).optional(),
  cursor: z.string().min(1).optional(),
};

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw appError('invalid_request', 'The request is invalid', {
    details: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request', message: issue.message,
    })),
  });
}

export function validateId(value) {
  return parse(id, value);
}

export function validateEmptyQuery(query) {
  parse(z.object({}).strict(), query);
}

export function validateFilters(query, kind) {
  const schema = z.object({
    ...page,
    ...(kind === 'facility-courts' ? {} : { q: text(100).optional(), city: text(120).optional() }),
    sport: z.string().regex(/^[A-Z0-9_]{2,32}$/).optional(),
    minPriceMinor: price.optional(),
    maxPriceMinor: price.optional(),
  }).strict();
  const parsed = parse(schema, query);
  const limit = parsed.limit === undefined ? 25 : Number(parsed.limit);
  if (!Number.isSafeInteger(limit) || limit > 100) throw appError('invalid_request', 'The request is invalid');
  if (parsed.minPriceMinor !== undefined && parsed.maxPriceMinor !== undefined
    && BigInt(parsed.minPriceMinor) > BigInt(parsed.maxPriceMinor)) {
    throw appError('invalid_request', 'The request is invalid');
  }
  return {
    limit,
    cursor: parsed.cursor,
    filters: {
      q: parsed.q ?? null,
      city: parsed.city?.normalize('NFC').toLowerCase() ?? null,
      sport: parsed.sport ?? null,
      minPriceMinor: parsed.minPriceMinor === undefined ? null : Number(parsed.minPriceMinor),
      maxPriceMinor: parsed.maxPriceMinor === undefined ? null : Number(parsed.maxPriceMinor),
    },
  };
}

export function rejectBody(request) {
  if (Number(request.headers['content-length'] ?? 0) > 0
    || request.headers['transfer-encoding'] !== undefined) {
    throw appError('invalid_request', 'The request is invalid');
  }
}
