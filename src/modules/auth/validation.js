import { z } from 'zod';

import { normalizeEmail } from '../users/index.js';
import { appError } from '../../shared/errors.js';

export const MIN_PASSWORD_CHARACTERS = 12;
export const MAX_PASSWORD_BYTES = 256;

const nameSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(150));
const emailSchema = z.string().transform((value) => normalizeEmail(value)).pipe(
  z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
const passwordSchema = z.string().superRefine((value, context) => {
  if (Array.from(value).length < MIN_PASSWORD_CHARACTERS) {
    context.addIssue({ code: 'custom', message: `Must contain at least ${MIN_PASSWORD_CHARACTERS} characters` });
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    context.addIssue({ code: 'custom', message: `Must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes` });
  }
});
const loginPasswordSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    context.addIssue({ code: 'custom', message: `Must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes` });
  }
});

const registrationSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
}).strict();

const loginSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
}).strict();

export function validateRegistration(input) {
  return parse(registrationSchema, input);
}

export function validateLogin(input) {
  return parse(loginSchema, input);
}

export function validatePassword(password) {
  return parse(passwordSchema, password);
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw appError('invalid_request', 'The request is invalid', {
    details: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'request',
      message: issue.message,
    })),
  });
}
