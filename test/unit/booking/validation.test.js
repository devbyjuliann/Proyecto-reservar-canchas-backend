import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateAvailabilityRequest,
  validateCancellationRequest,
  validateConfirmationRequest,
  validateIdempotencyKey,
  validateOwnBookingsRequest,
} from '../../../src/modules/booking/validation.js';

const CONFIRMATION = {
  courtId: '12',
  localDate: '2026-09-28',
  startTime: '16:00:00',
  durationMinutes: 60,
  expectedPriceMinor: 9000000,
  currency: 'COP',
};

test('confirmation accepts only the documented exact payload', () => {
  const input = CONFIRMATION;
  assert.deepEqual(validateConfirmationRequest(input), input);
  assert.throws(
    () => validateConfirmationRequest({ ...input, userId: '7' }),
    { code: 'invalid_request' },
  );
  assert.throws(
    () => validateConfirmationRequest({ ...input, startTime: '16:00' }),
    { code: 'invalid_request' },
  );
  for (const price of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateConfirmationRequest({ ...input, expectedPriceMinor: price }),
      { code: 'invalid_request' });
  }
  assert.throws(() => validateConfirmationRequest({ ...input, currency: 'USD' }),
    { code: 'invalid_request' });
});

test('public ids accept only canonical positive BIGINT UNSIGNED strings', () => {
  for (const courtId of [
    'abc',
    '12abc',
    '+1',
    '-1',
    '0',
    '00',
    '01',
    '',
    ' ',
    ' 1',
    '1 ',
    '1.5',
    '1e3',
    '18446744073709551616',
  ]) {
    assert.throws(
      () => validateConfirmationRequest({ ...CONFIRMATION, courtId }),
      { code: 'invalid_request' },
    );
  }

  assert.equal(validateAvailabilityRequest({
    courtId: '1',
    date: '2026-09-28',
  }).courtId, '1');
  assert.equal(validateCancellationRequest({ bookingId: '42' }).bookingId, '42');
  assert.equal(validateConfirmationRequest({
    ...CONFIRMATION,
    courtId: '18446744073709551615',
  }).courtId, '18446744073709551615');
});

test('idempotency keys are exact visible ASCII values up to 128 bytes', () => {
  assert.equal(validateIdempotencyKey('Booking-ABC-1'), 'Booking-ABC-1');
  assert.equal(validateIdempotencyKey('x'.repeat(128)), 'x'.repeat(128));
  assert.throws(() => validateIdempotencyKey(''), { code: 'invalid_request' });
  assert.throws(() => validateIdempotencyKey('contains space'), { code: 'invalid_request' });
  assert.throws(() => validateIdempotencyKey('x'.repeat(129)), { code: 'invalid_request' });
});

test('own bookings validates limits and preserves an opaque cursor', () => {
  assert.deepEqual(validateOwnBookingsRequest({}), { limit: 25, cursor: undefined });
  assert.deepEqual(validateOwnBookingsRequest({ limit: '100', cursor: 'opaque' }), {
    limit: 100,
    cursor: 'opaque',
  });
  assert.throws(() => validateOwnBookingsRequest({ limit: '101' }), {
    code: 'invalid_request',
  });
});
