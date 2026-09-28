import { toInstantString } from '../../shared/time.js';
import { facilitiesError } from './errors.js';

const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const STATES = new Set(['active', 'inactive', 'all']);

export function isValidIanaTimezone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateCreateFacilityInput(input = {}) {
  assertPlainObject(input, 'input');
  rejectUnknown(input, [
    'name',
    'timeZone',
    'city',
    'address',
    'description',
    'minimumAdvanceMinutes',
    'maximumAdvanceMinutes',
  ]);

  const hasMinimum = Object.hasOwn(input, 'minimumAdvanceMinutes');
  const hasMaximum = Object.hasOwn(input, 'maximumAdvanceMinutes');
  if (hasMinimum !== hasMaximum) invalid('Advance limits must be supplied together');

  const name = requiredText(input.name, 'name', 150);
  const timeZone = validateTimezone(input.timeZone);
  const minimumAdvanceMinutes = unsignedInteger(
    hasMinimum ? input.minimumAdvanceMinutes : 15,
    'minimumAdvanceMinutes',
    4_294_967_295,
  );
  const maximumAdvanceMinutes = unsignedInteger(
    hasMaximum ? input.maximumAdvanceMinutes : 43_200,
    'maximumAdvanceMinutes',
    4_294_967_295,
  );
  if (minimumAdvanceMinutes > maximumAdvanceMinutes) {
    invalid('minimumAdvanceMinutes cannot exceed maximumAdvanceMinutes');
  }
  return {
    name, timeZone, minimumAdvanceMinutes, maximumAdvanceMinutes,
    ...catalogFields(input),
  };
}

export function validateUpdateFacilityInput(input = {}) {
  assertPlainObject(input, 'input');
  rejectUnknown(input, ['name', 'city', 'address', 'description']);
  const changes = {};
  if (Object.hasOwn(input, 'name')) changes.name = requiredText(input.name, 'name', 150);
  Object.assign(changes, catalogFields(input));
  requireChanges(changes);
  return changes;
}

// Retained as a validation utility; court creation is not exposed by this module.
export function validateCreateCourtInput(input = {}) {
  assertPlainObject(input, 'input');
  rejectUnknown(input, [
    'name',
    'description',
    'minimumSeparationMinutes',
    'startIntervalMinutes',
    'allowedDurationsMinutes',
  ]);
  const durations = input.allowedDurationsMinutes;
  if (!Array.isArray(durations) || durations.length === 0) {
    invalid('allowedDurationsMinutes must be a non-empty array');
  }
  const normalizedDurations = durations.map((value) =>
    positiveInteger(value, 'allowedDurationsMinutes', 65_535));
  if (new Set(normalizedDurations).size !== normalizedDurations.length) {
    invalid('allowedDurationsMinutes cannot contain duplicates');
  }
  return {
    name: requiredText(input.name, 'name', 150),
    description: optionalText(input.description, 'description', 500),
    minimumSeparationMinutes: unsignedInteger(
      input.minimumSeparationMinutes,
      'minimumSeparationMinutes',
      65_535,
    ),
    startIntervalMinutes: positiveInteger(
      input.startIntervalMinutes,
      'startIntervalMinutes',
      65_535,
    ),
    allowedDurationsMinutes: [...normalizedDurations].sort((a, b) => a - b),
  };
}

export function validateUpdateCourtInput(input = {}) {
  assertPlainObject(input, 'input');
  rejectUnknown(input, ['name', 'description', 'sportCode']);
  const changes = {};
  if (Object.hasOwn(input, 'name')) changes.name = requiredText(input.name, 'name', 150);
  if (Object.hasOwn(input, 'description')) {
    if (input.description === undefined) invalid('description must be a string or null', 'description');
    changes.description = optionalText(input.description, 'description', 500);
  }
  if (Object.hasOwn(input, 'sportCode')) {
    if (input.sportCode !== null
      && (typeof input.sportCode !== 'string' || !/^[A-Z0-9_]{2,32}$/.test(input.sportCode))) {
      invalid('sportCode must be an uppercase sport code or null', 'sportCode');
    }
    changes.sportCode = input.sportCode;
  }
  requireChanges(changes);
  return changes;
}

export function validateId(id, field = 'id') {
  const value = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  if (
    typeof value !== 'string'
    || !/^[1-9]\d*$/.test(value)
    || BigInt(value) > MAX_UNSIGNED_BIGINT
  ) {
    invalid(`${field} must be a positive decimal ID`, field);
  }
  return value;
}

export function assertAdministrator(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw facilitiesError('authentication_required');
  }
  try {
    validateId(actor.id, 'actor.id');
  } catch {
    throw facilitiesError('authentication_required');
  }
  if (!Array.isArray(actor.roles) || !actor.roles.includes('ADMINISTRADOR')) {
    throw facilitiesError('forbidden');
  }
}

export function validateState(state) {
  const normalized = state ?? 'active';
  if (!STATES.has(normalized)) invalid('state must be active, inactive, or all', 'state');
  return normalized;
}

export function validateLimit(limit) {
  const normalized = limit === undefined ? 25 : limit;
  const value = typeof normalized === 'string' && /^[1-9]\d*$/.test(normalized)
    ? Number(normalized)
    : normalized;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    invalid('limit must be an integer between 1 and 100', 'limit');
  }
  return value;
}

export function validateNow(now) {
  try {
    return toInstantString(now);
  } catch (cause) {
    throw facilitiesError('invalid_request', {
      details: [{ field: 'now', message: 'Must be a valid instant' }],
      cause,
    });
  }
}

function catalogFields(input) {
  const fields = {};
  for (const [field, maximum] of [['city', 120], ['address', 250], ['description', 1000]]) {
    if (Object.hasOwn(input, field)) fields[field] = requiredText(input[field], field, maximum);
  }
  return fields;
}

function validateTimezone(timeZone) {
  if (!isValidIanaTimezone(timeZone)) invalid('timeZone must be a valid IANA identifier');
  return timeZone;
}

function requiredText(value, field, maximumLength) {
  if (typeof value !== 'string') invalid(`${field} must be a string`, field);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    invalid(`${field} must contain between 1 and ${maximumLength} characters`, field);
  }
  return normalized;
}

function optionalText(value, field, maximumLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(`${field} must be a string or null`, field);
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    invalid(`${field} cannot exceed ${maximumLength} characters`, field);
  }
  return normalized || null;
}

function unsignedInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    invalid(`${field} must be an integer between 0 and ${maximum}`, field);
  }
  return value;
}

function positiveInteger(value, field, maximum) {
  const result = unsignedInteger(value, field, maximum);
  if (result === 0) invalid(`${field} must be greater than zero`, field);
  return result;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${field} must be an object`, field);
  }
}

function rejectUnknown(input, allowed) {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) invalid(`Unknown field: ${unknown}`, unknown);
}

function requireChanges(changes) {
  if (Object.keys(changes).length === 0) invalid('At least one supported change is required');
}

function invalid(message, field) {
  throw facilitiesError('invalid_request', {
    details: [{ ...(field ? { field } : {}), message }],
  });
}
