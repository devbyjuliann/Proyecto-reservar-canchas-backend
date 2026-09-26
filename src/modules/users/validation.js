import { UsersValidationError } from './errors.js';

export const USER_ROLES = Object.freeze(['USUARIO', 'ADMINISTRADOR']);

export function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new UsersValidationError('Email must be a string');
  }

  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

export function validateCreateUserInput({ name, email } = {}) {
  const normalizedName = normalizeRequiredText(name, 'Name', 150);
  const normalizedEmail = normalizeEmail(email);

  if (!isValidEmail(normalizedEmail)) {
    throw new UsersValidationError('Email format is invalid');
  }

  return { name: normalizedName, email: normalizedEmail };
}

export function validateRole(role) {
  if (!USER_ROLES.includes(role)) {
    throw new UsersValidationError('Role must be USUARIO or ADMINISTRADOR');
  }

  return role;
}

export function validateUserId(userId) {
  if (
    (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) ||
    (typeof userId === 'string' && /^[1-9]\d*$/.test(userId))
  ) {
    return userId;
  }

  throw new UsersValidationError('User id must be a positive integer');
}

function normalizeRequiredText(value, label, maximumLength) {
  if (typeof value !== 'string') {
    throw new UsersValidationError(`${label} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new UsersValidationError(
      `${label} must contain between 1 and ${maximumLength} characters`,
    );
  }

  return normalized;
}
